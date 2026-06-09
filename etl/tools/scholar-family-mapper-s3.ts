/**
 * Pure mapper: the A2 canonical taxonomy → `scholar_family` rollup rows (#799,
 * the family-primary Methods lens). Side-effect-free + unit-tested, mirroring
 * `./scholar-tool-mapper-s3.ts`, so the join/ranking/guard is verifiable without
 * an S3 fetch or a DB.
 *
 * Input is the per-scholar `faculty{<cwid>}.families[]` slice of the A2
 * `tools.json` artifact (which embeds the faculty rollup byte-identically to the
 * standalone faculty.json — see etl/tools/index.ts). Each family entry carries
 * EXACTLY five keys (live-verified against the deployed artifact, 2026-06-09):
 *
 *   faculty{<cwid>}.families[]  { family_id, label, supercategory, pub_count,
 *                                 exemplar_tool_ids[] }   sorted (-pub_count, family_id)
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

/** One per-(scholar, family) entry in `faculty[<cwid>].families[]`. */
export type FacultyFamilyEntry = {
  family_id?: string | null;
  label?: string | null;
  supercategory?: string | null;
  pub_count?: number | null;
  exemplar_tool_ids?: unknown;
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
};

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
};

type Accum = {
  familyLabel: string;
  supercategory: string;
  pmidCount: number;
  exemplarTools: string[];
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
  },
): BuildScholarFamilyS3Result {
  const topN = opts.topNPerScholar ?? 50;
  const known = opts.knownSupercategories;

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
      const prev = byFamilyId.get(familyId);
      if (!prev) {
        byFamilyId.set(familyId, { familyLabel, supercategory, pmidCount, exemplarTools });
      } else if (pmidCount > prev.pmidCount) {
        // Same family_id appeared twice: keep the strongest count + its exemplars.
        prev.pmidCount = pmidCount;
        prev.exemplarTools = exemplarTools;
      }
    }

    const ranked = [...byFamilyId.entries()]
      .map(([familyId, v]) => ({ familyId, ...v }))
      .sort((a, b) => b.pmidCount - a.pmidCount || a.familyId.localeCompare(b.familyId));

    for (const e of ranked.slice(0, topN)) {
      writes.push({
        cwid,
        familyId: e.familyId,
        familyLabel: e.familyLabel,
        supercategory: e.supercategory,
        pmidCount: e.pmidCount,
        exemplarTools: e.exemplarTools,
      });
    }
  }

  return { writes, skippedMissingCwid, skippedMissingFields, unknownSupercategory };
}
