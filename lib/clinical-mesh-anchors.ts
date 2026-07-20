/**
 * Issue #1836 — anchor clinical board specialties to a MeSH *disease* descriptor
 * so the clinical boost + `clinical:exact` evidence fire for the whole disease
 * subtree a specialty covers, not just literal specialty-name queries.
 *
 * The subsumption is done cap-free via tree-number prefixes (NOT the 200-capped
 * `descendantUis` set): the doc stores each specialty's ANCHOR tree numbers (a
 * cardiologist → `["C14"]`); the query supplies its descriptor's ANCESTOR
 * closure (`treeNumberPrefixes`, e.g. heart failure `C14.280.434` →
 * `["C14.280.434","C14.280","C14"]`). Subsumption ⇔ the two sets intersect —
 * both sides are a handful of strings, so no descendant enumeration and no cap.
 *
 * Dependency-free (fs only) so the ETL index builder can import it without
 * dragging search-runtime deps — same reason `lib/mesh-descriptor-uis.ts` and
 * `lib/mesh-tree-ancestors.ts` stay lean.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** One specialty's disease anchor, precomputed at index time and stored on the
 *  people doc (`_source`, `enabled:false`) so the evidence label is recoverable
 *  at query time without re-resolving. */
export type ClinicalAnchor = {
  specialty: string;
  boardCertified: boolean;
  /** The anchor descriptor's disease-tree tree numbers (C / F03 only). */
  tree: string[];
};

export const CLINICAL_ANCHORS_CSV = path.join(
  process.cwd(),
  "etl/clinical-mesh/specialty-anchors.csv",
);

/** Normalized key for the specialty→anchor lookup: lowercase, strip everything
 *  but alphanumerics. Robust to casing / punctuation / hyphen drift between the
 *  POPS strings and the curated CSV ("Cardiovascular Disease" ⇄ "cardiovascular
 *  disease" ⇄ "Cardiovascular-Disease"). */
export function anchorKey(specialty: string): string {
  return specialty.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** MeSH disease trees: C = Diseases, F03 = Mental Disorders. The disease-tree
 *  guard is the specificity backbone — an auto/mis-resolved non-disease anchor
 *  (e.g. a discipline in the H tree) contributes no tree numbers and so cannot
 *  create a false clinical match; only a curated disease anchor counts. */
export function isDiseaseTree(tn: string): boolean {
  return tn.startsWith("C") || tn.startsWith("F03");
}

/**
 * Parse the curated `specialty,descriptor_ui,note` CSV into a
 * `anchorKey → descriptorUi` map. The specialty column MAY contain commas, so we
 * locate the `D\d+` descriptor column rather than blindly splitting on the first
 * comma. Blank lines, `#` comments, and the header row are skipped.
 *
 * ponytail: hand-parse — the file is a controlled, comment-friendly two-column
 * artifact, not arbitrary user CSV; a quote-aware parser lib would be overkill.
 */
export function parseSpecialtyAnchors(csv: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(",");
    const uiIdx = cols.findIndex((c) => /^D\d+$/.test(c.trim()));
    if (uiIdx <= 0) continue; // header, malformed, or no descriptor column
    const specialty = cols.slice(0, uiIdx).join(",").trim();
    const ui = cols[uiIdx].trim();
    if (!specialty) continue;
    const key = anchorKey(specialty);
    if (!map.has(key)) map.set(key, ui); // first row wins
  }
  return map;
}

/**
 * Load the curated specialty→anchor map from disk (once per index build via
 * `loadMeshAncestorContext`). Throws (fail-loud) if the file is absent — the CSV
 * is committed, so absence is a packaging bug, not a runtime-degrade case (same
 * stance as etl/mesh-aliases). NOTE: `loadMeshAncestorContext` runs on BOTH the
 * ETL image and the app-runtime suppress/reject/revoke reflect fast-path; the
 * standalone image only ships this CSV because `next.config.ts`
 * outputFileTracingIncludes traces it into those routes. Any NEW app-runtime
 * caller must add the CSV to that route's trace list.
 */
export function loadSpecialtyAnchorMap(csvPath: string = CLINICAL_ANCHORS_CSV): Map<string, string> {
  return parseSpecialtyAnchors(readFileSync(csvPath, "utf8"));
}

/**
 * Resolve a scholar's specialty strings to their disease-anchor tree numbers.
 * Returns the flat deduped tree-number set (for the OpenSearch `terms` boost
 * filter) plus the per-specialty {@link ClinicalAnchor} rows (for the evidence
 * label). A specialty absent from the map, or whose anchor has no disease-tree
 * tree number, contributes nothing (graceful — falls back to today's literal
 * clinicalSpecialties behavior, no regression).
 */
export function buildClinicalAnchors(
  clinicalSpecialties: string[],
  boardSet: string[],
  anchorMap: ReadonlyMap<string, string>,
  treeNumbersByUi: ReadonlyMap<string, string[]>,
): { tree: string[]; anchors: ClinicalAnchor[] } {
  const boardNorm = new Set(boardSet.map((b) => b.toLowerCase().trim()));
  const anchors: ClinicalAnchor[] = [];
  const treeSet = new Set<string>();
  for (const specialty of clinicalSpecialties) {
    const ui = anchorMap.get(anchorKey(specialty));
    if (!ui) continue;
    const tns = (treeNumbersByUi.get(ui) ?? []).filter(isDiseaseTree);
    if (tns.length === 0) continue;
    anchors.push({
      specialty,
      boardCertified: boardNorm.has(specialty.toLowerCase().trim()),
      tree: tns,
    });
    for (const tn of tns) treeSet.add(tn);
  }
  return { tree: [...treeSet], anchors };
}

/**
 * Query-side subsumption for the evidence label: the first anchor whose tree
 * number is at-or-above the query descriptor (i.e. any of its tree numbers is in
 * the query's ancestor closure). Returns the same shape `clinicalExactMatch`
 * emits so the evidence renderers need no change; null when nothing subsumes.
 *
 * `queryAncestorTreeNumbers` = union of `treeNumberPrefixes` over the query
 * descriptor's tree numbers (computed once per request in the resolver).
 */
export function clinicalMeshMatch(
  queryAncestorTreeNumbers: string[],
  anchors: ClinicalAnchor[],
): { specialty: string; boardCertified: boolean } | null {
  if (queryAncestorTreeNumbers.length === 0 || anchors.length === 0) return null;
  const closure = new Set(queryAncestorTreeNumbers);
  for (const a of anchors) {
    // ponytail: first anchor wins (mirrors clinicalExactMatch's first-match rule)
    if (a.tree.some((tn) => closure.has(tn))) {
      return { specialty: a.specialty, boardCertified: a.boardCertified };
    }
  }
  return null;
}
