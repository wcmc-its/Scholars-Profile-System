/**
 * Pure mapper: the A2 canonical tools taxonomy (v7) → `scholar_tool` rollup rows
 * (#794). Side-effect-free + unit-tested, mirroring the legacy
 * `etl/dynamodb/scholar-tool-mapper.ts`, so the join/ranking is verifiable
 * without an S3 fetch or a DB.
 *
 * Inputs are the two relevant slices of the A2 `tools.json` artifact (which is a
 * superset that embeds the per-faculty rollup — see etl/tools/index.ts):
 *
 *   tools[]            one record per canonical (deduped) tool:
 *                        { canonical_tool_id, display_name, method_family_label,
 *                          salience_tier, ... }
 *   faculty{<cwid>}    per-scholar rollup, keyed by cwid:
 *                        { cwid, tools: [{ canonical_tool_id, display_name,
 *                          pub_count }], families: [...] }
 *
 * We join each faculty tool entry to its canonical record by `canonical_tool_id`
 * to pick up the canonical (de-mangled, de-aliased) display name, the
 * method-family label, and the salience tier — then emit one `scholar_tool` row
 * per (cwid, canonical tool name), capped to the top-N per scholar.
 *
 * Read contract preserved (verified on master, #794): the only consumer
 * (lib/edit/overview-facts.ts) reads exactly toolName / category / pmidCount /
 * maxConfidence and orders by [pmidCount desc, maxConfidence desc]. The A2
 * artifact carries no PMIDs and no per-extraction confidence, so:
 *   - pmidCount   ← faculty tool `pub_count` (the "used in N papers" count)
 *   - maxConfidence ← derived from salience_tier (orderBy tiebreak ONLY; never
 *                     displayed, never sent to the LLM — see TIER_CONFIDENCE)
 *   - sampleContext ← #1119 — the tool's best junk-filtered usage snippet from
 *                     the A2 `tool_context.json` artifact, keyed by canonical
 *                     tool id (when an index is supplied; null otherwise). The
 *                     artifact carries no per-(scholar,tool) pmids, so this is the
 *                     tool's GLOBAL best snippet (best-of-N falls back to all of a
 *                     tool's snippets) — still tool-specific, paper-grounded text.
 *   - pmids         ← []     (Json NOT NULL needs a value; read by nothing)
 */
import type { ScholarToolWrite } from "../dynamodb/scholar-tool-mapper";
import { selectBestSnippet, type ToolContextIndex } from "./tool-context";

/** Canonical tool record (the fields this mapper reads from `tools[]`). */
export type ToolsArtifactTool = {
  canonical_tool_id: string;
  display_name: string;
  method_family_label?: string | null;
  salience_tier?: string | null;
  [key: string]: unknown;
};

/** One per-(scholar, tool) entry in `faculty[<cwid>].tools[]`. */
export type FacultyToolEntry = {
  canonical_tool_id: string;
  display_name?: string | null;
  pub_count?: number | null;
  [key: string]: unknown;
};

/** Per-scholar rollup keyed by cwid in `faculty{}`. */
export type FacultyRollup = {
  cwid?: string;
  tools?: FacultyToolEntry[];
  [key: string]: unknown;
};

/** The slice of the A2 `tools.json` artifact this mapper consumes. */
export type ToolsArtifactSlice = {
  tools: ToolsArtifactTool[];
  faculty: Record<string, FacultyRollup>;
};

export type BuildScholarToolS3Result = {
  writes: ScholarToolWrite[];
  /** Scholars in the artifact whose cwid is out of FK scope (skipped). */
  skippedMissingCwid: number;
  /** Tool entries dropped for an empty/unresolvable display name. */
  skippedMissingFields: number;
  /**
   * Tool entries whose `canonical_tool_id` was absent from `tools[]` and fell
   * back to the faculty-side display name (category/tier unavailable). A data
   * health signal — should be ~0 for a coherent artifact.
   */
  unknownToolFallback: number;
};

/**
 * Salience tier → a monotone confidence score in [0,1] that fits the
 * `scholar_tool.max_confidence` Decimal(5,4) column. The artifact has no
 * per-extraction confidence; this exists ONLY to drive the secondary
 * [maxConfidence desc] orderBy tiebreak the reader applies after pmidCount —
 * it is never rendered and never reaches the LLM. S(best) … C(weakest); a
 * null/unknown tier sorts below every graded tier.
 */
export const TIER_CONFIDENCE: Readonly<Record<string, number>> = {
  S: 0.9,
  A: 0.7,
  B: 0.5,
  C: 0.3,
};
const UNKNOWN_TIER_CONFIDENCE = 0.1;

export function tierToConfidence(tier: string | null | undefined): number {
  if (typeof tier === "string" && tier in TIER_CONFIDENCE) {
    return TIER_CONFIDENCE[tier];
  }
  return UNKNOWN_TIER_CONFIDENCE;
}

type Accum = {
  pmidCount: number;
  maxConfidence: number;
  category: string | null;
  /** #1119 — best usage snippet across the ids that collapsed to this name. */
  sampleContext: string | null;
};

/**
 * Build the `scholar_tool` rollup writes from the A2 tools + faculty slices.
 *
 * - Skips scholars whose cwid is not in `ourCwidSet` (FK scope, like the legacy
 *   block and the other ETL projections).
 * - Joins each faculty tool entry to its canonical `tools[]` record for the
 *   de-mangled display name, method-family label (category), and salience tier.
 * - Groups by (cwid, canonical tool NAME) — the `@@unique([cwid, toolName])`
 *   identity, matching the legacy mapper which also keys by name, not id — so
 *   two ids that collapse to one display name merge (max pub_count, max tier).
 * - Keeps the top `topNPerScholar` tools per scholar by (pmidCount, maxConfidence),
 *   matching the legacy cap and the reader's orderBy so the bounded table holds
 *   exactly the rows the overview/drawer surface first.
 */
export function buildScholarToolWritesFromS3(
  artifact: ToolsArtifactSlice,
  opts: {
    ourCwidSet: Set<string>;
    topNPerScholar?: number;
    /** #1119 — junk-filtered tool→snippet index. Omit (or a miss) leaves
     *  sampleContext null — benign and expected on a pre-v3 artifact. */
    toolContext?: ToolContextIndex;
  },
): BuildScholarToolS3Result {
  const topN = opts.topNPerScholar ?? 30;
  const toolContext = opts.toolContext;

  // Index canonical tools by id for the display_name / family / tier join.
  const toolsById = new Map<string, ToolsArtifactTool>();
  for (const t of artifact.tools ?? []) {
    if (t && typeof t.canonical_tool_id === "string") {
      toolsById.set(t.canonical_tool_id, t);
    }
  }

  const writes: ScholarToolWrite[] = [];
  let skippedMissingCwid = 0;
  let skippedMissingFields = 0;
  let unknownToolFallback = 0;

  for (const [cwid, rollup] of Object.entries(artifact.faculty ?? {})) {
    if (!cwid || !opts.ourCwidSet.has(cwid)) {
      skippedMissingCwid += 1;
      continue;
    }

    const entries = Array.isArray(rollup?.tools) ? rollup.tools : [];
    const byName = new Map<string, Accum>();
    for (const e of entries) {
      const id = typeof e?.canonical_tool_id === "string" ? e.canonical_tool_id : "";
      const rec = id ? toolsById.get(id) : undefined;
      const toolName = (rec?.display_name ?? e?.display_name ?? "").trim();
      if (!toolName) {
        skippedMissingFields += 1;
        continue;
      }
      if (!rec) unknownToolFallback += 1;

      const pubCount =
        typeof e?.pub_count === "number" && Number.isFinite(e.pub_count)
          ? Math.max(0, Math.trunc(e.pub_count))
          : 0;
      const category = rec?.method_family_label ?? null;
      const confidence = tierToConfidence(rec?.salience_tier ?? null);
      // #1119 — the tool's best usage snippet (global per tool; the artifact has
      // no per-(scholar,tool) pmids, so no scope to intersect). Keyed by id; the
      // display name drives the name-bias pass.
      const sampleContext =
        id && toolContext
          ? (selectBestSnippet(toolContext, id, { displayName: toolName })?.context ?? null)
          : null;

      const prev = byName.get(toolName);
      if (!prev) {
        byName.set(toolName, { pmidCount: pubCount, maxConfidence: confidence, category, sampleContext });
      } else {
        // Two ids collapsed to one display name: keep the strongest signal, the
        // first non-null family label (first-wins, like the legacy mapper), and
        // the longer usage snippet (the more descriptive of the collapsed ids).
        if (pubCount > prev.pmidCount) prev.pmidCount = pubCount;
        if (confidence > prev.maxConfidence) prev.maxConfidence = confidence;
        if (prev.category === null && category !== null) prev.category = category;
        if (sampleContext && (!prev.sampleContext || sampleContext.length > prev.sampleContext.length)) {
          prev.sampleContext = sampleContext;
        }
      }
    }

    const ranked = [...byName.entries()]
      .map(([toolName, v]) => ({ toolName, ...v }))
      .sort((a, b) => b.pmidCount - a.pmidCount || b.maxConfidence - a.maxConfidence);

    for (const e of ranked.slice(0, topN)) {
      writes.push({
        cwid,
        toolName: e.toolName,
        category: e.category,
        pmidCount: e.pmidCount,
        maxConfidence: e.maxConfidence,
        sampleContext: e.sampleContext,
        pmids: [],
      });
    }
  }

  return { writes, skippedMissingCwid, skippedMissingFields, unknownToolFallback };
}
