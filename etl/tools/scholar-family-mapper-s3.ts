/**
 * Pure mapper: the A2 canonical taxonomy → `scholar_family` rollup rows (#799,
 * the family-primary Methods lens). Side-effect-free + unit-tested, mirroring
 * `./scholar-tool-mapper-s3.ts`, so the join/ranking/guard is verifiable without
 * an S3 fetch or a DB.
 *
 * Input is the per-scholar `faculty{<cwid>}.families[]` slice of the A2
 * `tools.json` artifact (which embeds the faculty rollup byte-identically to the
 * standalone faculty.json — see etl/tools/index.ts). Each family entry carries
 * six keys (live-verified against the deployed artifact, schema tools-a2-v2 /
 * v2026-06-10; `pmids` added by ReciterAI#175):
 *
 *   faculty{<cwid>}.families[]  { family_id, label, supercategory, pub_count,
 *                                 exemplar_tool_ids[], pmids[] }  sorted (-pub_count, family_id)
 *
 *   - `pmids` (#819) is the distinct member-PMID set, with the upstream invariant
 *     distinct(pmids).length === pub_count. Read directly + coerced to digit
 *     strings; backs the lens's click-to-filter. Absent ([]) on a pre-#175 artifact.
 *
 * Contract notes that shape this mapper:
 *   - `pub_count` is the per-scholar, C-tier-RECONCILED distinct-publication count
 *     (C-tier members are already excluded from the count and the exemplars
 *     upstream). Read it DIRECTLY — SPS cannot reconstruct it from faculty.json.
 *   - `supercategory` is non-null on every live family row and is the #800 group
 *     key + the #801 gating key. It is an OPEN set (it drifted 13→14 and the spec
 *     docs lag the code), so we WARN-and-keep on an unknown value, never throw.
 *   - `label` is contractually `string | null`; we skip a family with no usable
 *     label (it cannot be displayed) rather than coalescing to the opaque id.
 *   - `family_id` is NOT stable across A2 rebuilds; it is only ever the
 *     (cwid, family_id) rebuild key here. Downstream suppression (#800) and
 *     audience-gating (#801) overlays key on (supercategory, label) instead.
 *   - `exemplar_tool_ids` are canonical_tool_id strings, which SPS has no
 *     read-time id→name map for (scholar_tool is keyed by name, not id). So we
 *     resolve them to member-tool DISPLAY NAMES here, via the same canonical
 *     tools[] index the sibling tool mapper joins on — that is what the lens
 *     renders ("CheXpert · MIMIC-CXR"). Names refresh on every full-replace run.
 */
import type { ToolsArtifactSlice } from "./scholar-tool-mapper-s3";
import { selectBestSnippet, type ToolContextIndex } from "./tool-context";

/** One per-(scholar, family) entry in `faculty[<cwid>].families[]`. */
export type FacultyFamilyEntry = {
  family_id?: string | null;
  label?: string | null;
  supercategory?: string | null;
  pub_count?: number | null;
  exemplar_tool_ids?: unknown;
  /** #819 — the distinct member PMIDs (ReciterAI#175). Invariant upstream:
   *  distinct(pmids).length === pub_count. Absent on the pre-#175 artifact. */
  pmids?: unknown;
  [key: string]: unknown;
};

/** One row to write to `scholar_family` (sourceArtifactSha is stamped by the loader). */
export type ScholarFamilyWrite = {
  cwid: string;
  familyId: string;
  familyLabel: string;
  supercategory: string;
  pmidCount: number;
  /** Resolved member-tool DISPLAY NAMES (canonical_tool_id → tools[].display_name),
   *  per-scholar ranked — what the lens shows ("CheXpert · MIMIC-CXR"). */
  exemplarTools: string[];
  /** #1119 — best usage snippet per exemplar tool, keyed by the SAME DISPLAY NAME
   *  as `exemplarTools` (so the lens/overview line them up 1:1), drawn from a paper
   *  in this family's `pmids` (falling back to any of the tool's snippets) via the
   *  A2 `tool_context.json` map. Only exemplars with a usable snippet appear; `{}`
   *  when none do, or when no tool-context index was supplied. EXTRACTED paper text
   *  (grounding-eligible, unlike `definition`) — injection-safe DATA in any prompt. */
  exemplarContexts: Record<string, string>;
  /** #819 — distinct member PMIDs (digit strings), read from the artifact; backs
   *  the click-to-filter membership. `[]` on the pre-#175 artifact (no field). */
  pmids: string[];
  /** #879 — generated 1–2 sentence capability gloss for the family, joined by
   *  `family_id` from the top-level `families[]` taxonomy (NOT the per-scholar
   *  slice, which has no definition). `null` when the artifact has none. */
  definition: string | null;
  /** #879 — provenance for `definition` ("generated" | null), passed through raw;
   *  the render layer gates the "AI-generated" disclaimer on `=== "generated"`. */
  definitionSource: string | null;
};

/** Family-level definition keyed by `family_id`, joined into the per-scholar rows.
 *  Built by the loader from the artifact's top-level `families[]` (see etl/tools/
 *  index.ts) — the per-scholar `faculty[].families[]` slice carries no definition. */
export type FamilyDefinitionIndex = ReadonlyMap<
  string,
  { definition: string | null; definitionSource: string | null }
>;

export type BuildScholarFamilyS3Result = {
  writes: ScholarFamilyWrite[];
  /** Scholars in the artifact whose cwid is out of FK scope (skipped). */
  skippedMissingCwid: number;
  /**
   * Family entries dropped for a missing family_id / label / supercategory, or a
   * non-positive pub_count (nothing to show). A data-health signal.
   */
  skippedMissingFields: number;
  /**
   * Family entries whose `supercategory` was not in the supplied known set — kept
   * (open-set policy), but counted so the loader can alarm on taxonomy drift.
   * Always 0 when `opts.knownSupercategories` is not provided.
   */
  unknownSupercategory: number;
  /**
   * Written family rows where `distinct(pmids).length !== pmidCount` — the
   * ReciterAI#175 invariant. Should be 0 on a coherent artifact; a non-zero count
   * is a data-health alarm (the loader logs it). The row is still written with the
   * artifact's pmids (pmidCount stays the upstream pub_count).
   */
  pmidCountMismatch: number;
  /**
   * #879 — written rows that got a non-null `definition` from the family-definition
   * join. Compare against the loader's indexed `with_definition` count to detect a
   * SILENT join-key divergence (top-level families[] family_id drifting from the
   * per-scholar slice within one publish): a near-zero hit rate against a populated
   * index is the alarm. 0 is expected on a pre-v3 artifact (no familyDefById).
   */
  definitionJoinHits: number;
  /**
   * #989 — per-scholar family entries collapsed because two distinct `family_id`s
   * shared the same STABLE `(supercategory, familyLabel)` identity. The mapper
   * keeps the strongest by `pmidCount` so the table holds ≤1 row per
   * `(cwid, supercategory, familyLabel)` — the basis the distinct-member
   * aggregations (`_count.cwid` over `groupBy([sc,label])`) and the per-row chips
   * rely on. A non-zero count is an upstream-taxonomy alarm (the loader logs it),
   * not a failure: counts stay correct precisely because the duplicate was
   * collapsed rather than written as a second row.
   */
  duplicateFamilyLabel: number;
};

type Accum = {
  familyLabel: string;
  supercategory: string;
  pmidCount: number;
  exemplarTools: string[];
  pmids: string[];
  /** #1119 — exemplar tool DISPLAY NAME → best usage snippet (see ScholarFamilyWrite). */
  exemplarContexts: Record<string, string>;
};

/**
 * Resolve raw `exemplar_tool_ids` → member-tool DISPLAY NAMES via the canonical
 * tools[] index, preserving order and de-duping. Unresolvable ids are dropped — a
 * cosmetic, bounded loss (exemplars are ≤3 and back only the lens's sub-label).
 */
function resolveExemplarTools(raw: unknown, toolsById: Map<string, string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!id) continue;
    const name = toolsById.get(id);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * #1119 — resolve each exemplar tool id to its best usage snippet, keyed by the
 * tool DISPLAY NAME (the same key space as `resolveExemplarTools`, deduped
 * first-wins so the two stay 1:1). Candidate snippets are scoped to this family's
 * member pmids (the closest available "scholar's pmids for that tool"), falling
 * back inside `selectBestSnippet` to any of the tool's snippets. Only exemplars
 * with a usable snippet appear; returns `{}` otherwise. A `seen` Set (not an `in`
 * check) avoids prototype-key pitfalls for unusual tool names.
 */
function resolveExemplarContexts(
  raw: unknown,
  toolsById: Map<string, string>,
  toolContext: ToolContextIndex,
  scholarPmids: ReadonlySet<string>,
): Record<string, string> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!id) continue;
    const name = toolsById.get(id);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const best = selectBestSnippet(toolContext, id, { displayName: name, scholarPmids });
    if (best) out[name] = best.context;
  }
  return out;
}

/**
 * Normalize the artifact's `pmids` into distinct digit strings, preserving order
 * (#819). Accepts numbers or numeric strings; drops anything non-numeric. The
 * upstream set is already distinct + C-tier-reconciled (ReciterAI#175), so this is
 * defensive coercion, not a re-aggregation. Returns [] when absent (pre-#175).
 */
function normalizePmids(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    let pmid = "";
    if (typeof v === "number" && Number.isInteger(v) && v > 0) pmid = String(v);
    else if (typeof v === "string" && /^\d+$/.test(v.trim())) pmid = v.trim();
    if (!pmid || seen.has(pmid)) continue;
    seen.add(pmid);
    out.push(pmid);
  }
  return out;
}

/**
 * Build the `scholar_family` rollup writes from the A2 faculty slice.
 *
 * - Skips scholars whose cwid is not in `ourCwidSet` (FK scope, like the sibling
 *   tool mapper and the other ETL projections).
 * - Groups by (cwid, family_id) — the `@@unique([cwid, family_id])` identity; a
 *   duplicate family_id within a scholar keeps the strongest signal (max
 *   pub_count, first label/supercategory/exemplars).
 * - `pmidCount ← family.pub_count` read directly (per-scholar, C-reconciled).
 * - Keeps the top `topNPerScholar` families per scholar by (pmidCount, family_id)
 *   — generous headroom over the lens display cap; bounds the table.
 */
export function buildScholarFamilyWritesFromS3(
  artifact: ToolsArtifactSlice,
  opts: {
    ourCwidSet: Set<string>;
    topNPerScholar?: number;
    /** Optional known A2 supercategory id set — drives the unknownSupercategory
     *  counter only. Omit to treat every value as known (open-set default). */
    knownSupercategories?: ReadonlySet<string>;
    /** #879 — `family_id` → generated definition, from the artifact's top-level
     *  `families[]`. Omit (or a miss) leaves a row's definition null — benign and
     *  expected on a pre-v3 artifact; never a reason to drop a family. */
    familyDefById?: FamilyDefinitionIndex;
    /** #1119 — junk-filtered tool→snippet index. Omit (or a miss) leaves a row's
     *  exemplarContexts `{}` — benign and expected on a pre-v3 artifact. */
    toolContext?: ToolContextIndex;
  },
): BuildScholarFamilyS3Result {
  const topN = opts.topNPerScholar ?? 50;
  const known = opts.knownSupercategories;
  const toolContext = opts.toolContext;

  // Index canonical tools by id → display name, to resolve each family's
  // exemplar_tool_ids into the member-tool names the lens renders.
  const toolsById = new Map<string, string>();
  for (const t of artifact.tools ?? []) {
    if (t && typeof t.canonical_tool_id === "string" && typeof t.display_name === "string") {
      const name = t.display_name.trim();
      if (name) toolsById.set(t.canonical_tool_id, name);
    }
  }

  const writes: ScholarFamilyWrite[] = [];
  let skippedMissingCwid = 0;
  let skippedMissingFields = 0;
  let unknownSupercategory = 0;
  let pmidCountMismatch = 0;
  let definitionJoinHits = 0;
  let duplicateFamilyLabel = 0;

  for (const [cwid, rollup] of Object.entries(artifact.faculty ?? {})) {
    if (!cwid || !opts.ourCwidSet.has(cwid)) {
      skippedMissingCwid += 1;
      continue;
    }

    const families = Array.isArray((rollup as { families?: unknown })?.families)
      ? (rollup as { families: FacultyFamilyEntry[] }).families
      : [];

    const byFamilyId = new Map<string, Accum>();
    for (const f of families) {
      const familyId = typeof f?.family_id === "string" ? f.family_id.trim() : "";
      const familyLabel = typeof f?.label === "string" ? f.label.trim() : "";
      const supercategory = typeof f?.supercategory === "string" ? f.supercategory.trim() : "";
      const pmidCount =
        typeof f?.pub_count === "number" && Number.isFinite(f.pub_count)
          ? Math.max(0, Math.trunc(f.pub_count))
          : 0;

      // Required identity + display + gating-key fields, and a positive count
      // (a family with no surfaced publications is not worth a row).
      if (!familyId || !familyLabel || !supercategory || pmidCount <= 0) {
        skippedMissingFields += 1;
        continue;
      }
      if (known && !known.has(supercategory)) unknownSupercategory += 1;

      const exemplarTools = resolveExemplarTools(f?.exemplar_tool_ids, toolsById);
      const pmids = normalizePmids(f?.pmids);
      // #1119 — scope the snippet search to this family's member pmids.
      const exemplarContexts = toolContext
        ? resolveExemplarContexts(f?.exemplar_tool_ids, toolsById, toolContext, new Set(pmids))
        : {};
      const prev = byFamilyId.get(familyId);
      if (!prev) {
        byFamilyId.set(familyId, {
          familyLabel,
          supercategory,
          pmidCount,
          exemplarTools,
          pmids,
          exemplarContexts,
        });
      } else if (pmidCount > prev.pmidCount) {
        // Same family_id appeared twice: keep the strongest count + its exemplars,
        // pmids, and contexts.
        prev.pmidCount = pmidCount;
        prev.exemplarTools = exemplarTools;
        prev.pmids = pmids;
        prev.exemplarContexts = exemplarContexts;
      }
    }

    // #989 — collapse entries sharing the STABLE (supercategory, familyLabel)
    // identity but differing in family_id. family_id is re-minted on every A2
    // rebuild; (supercategory, label) is the permalink + #800/#801 overlay
    // identity. The table's unique key is (cwid, family_id), so two such entries
    // would BOTH insert — double-counting `_count.cwid` over groupBy([sc,label])
    // and duplicating the per-row chips. Keep the strongest by pmidCount; the
    // dropped duplicates feed the duplicateFamilyLabel data-health counter.
    const byStableKey = new Map<string, { familyId: string } & Accum>();
    for (const [familyId, v] of byFamilyId) {
      const key = `${v.supercategory}::${v.familyLabel}`;
      const prev = byStableKey.get(key);
      if (!prev) {
        byStableKey.set(key, { familyId, ...v });
      } else {
        duplicateFamilyLabel += 1;
        if (v.pmidCount > prev.pmidCount) byStableKey.set(key, { familyId, ...v });
      }
    }

    const ranked = [...byStableKey.values()].sort(
      (a, b) => b.pmidCount - a.pmidCount || a.familyId.localeCompare(b.familyId),
    );

    for (const e of ranked.slice(0, topN)) {
      // Invariant alarm only among populated rows: a pre-#175 artifact has no
      // pmids ([]) on every family, which is expected, not a mismatch.
      if (e.pmids.length > 0 && e.pmids.length !== e.pmidCount) pmidCountMismatch += 1;
      // #879 — family-level definition joined by family_id; absent → null (benign).
      const def = opts.familyDefById?.get(e.familyId);
      if (def?.definition != null) definitionJoinHits += 1;
      writes.push({
        cwid,
        familyId: e.familyId,
        familyLabel: e.familyLabel,
        supercategory: e.supercategory,
        pmidCount: e.pmidCount,
        exemplarTools: e.exemplarTools,
        exemplarContexts: e.exemplarContexts,
        pmids: e.pmids,
        definition: def?.definition ?? null,
        definitionSource: def?.definitionSource ?? null,
      });
    }
  }

  return {
    writes,
    skippedMissingCwid,
    skippedMissingFields,
    unknownSupercategory,
    pmidCountMismatch,
    definitionJoinHits,
    duplicateFamilyLabel,
  };
}
