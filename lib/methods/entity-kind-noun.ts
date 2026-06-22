/**
 * #1168 — maps a family's `dominant_kind` (the ReciterAI producer `kind` enum,
 * carried onto every entity via #260) to the noun the Surface-B rail header uses
 * ("Instruments", "Reagents", "Cell lines", …). This is why the rail can say the
 * right thing on a reagent or instrument family instead of the hard-coded
 * "Cell lines" Surface-B v1 shipped with.
 *
 * `kind` is orthogonal to `supercategory` (a supercategory mixes kinds — e.g.
 * Therapeutics & Interventions is mostly reagents with some instruments), so the
 * noun MUST key off `dominant_kind`, not the supercategory. A static map suffices:
 * the producer enum is a closed 8-value set (`pipeline_tools/vocab.py`), mirroring
 * the static `supercategory-labels.ts` precedent (OQ-2: static map vs DB dimension).
 *
 * `organism_or_cells` deliberately maps to "Cell lines" (not "Cell lines & models")
 * so the established cell-line feed is unchanged — the animal-model-vs-cell-line
 * split within that kind is deferred until non-cell-line data exists to test it.
 * An unknown / null kind (pre-#260 rows) falls back to the neutral "Entities".
 */
const KIND_NOUN: Record<string, string> = {
  instrument: "Instruments",
  reagent: "Reagents",
  organism_or_cells: "Cell lines",
  assay: "Assays",
  dataset: "Datasets",
  software: "Software",
  method: "Methods",
  model: "Models",
};

/** The plural rail-header noun for a family's dominant entity kind. Title-case
 *  ("Reagents"); call sites lower-case it for inline copy ("Filter reagents…"). */
export function entityKindNoun(dominantKind: string | null | undefined): string {
  if (!dominantKind) return "Entities";
  return KIND_NOUN[dominantKind] ?? "Entities";
}
