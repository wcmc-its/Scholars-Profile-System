/**
 * COI-gap detection — surface unmatched PubMed competing-interest relationships
 * for a scholar with a qualitative match-confidence tier.
 *
 * Entry point: `analyzeStatement(statement, scholar, disclosedEntities, opts?)`.
 * Build the `scholar` arg with `deriveScholar(firstName, lastName)`.
 *
 * See `docs/coi-pubmed-unmatched-feasibility.md` (design) and
 * `docs/coi-pubmed-phase0-precision-study.md` (validation plan).
 */
export * from "./pipeline";
export * from "./lifecycle";
// Note: `./compute` is intentionally NOT re-exported — it imports the DB client.
// Import it directly (`@/lib/coi-gap/compute`) from server/ETL code only.
