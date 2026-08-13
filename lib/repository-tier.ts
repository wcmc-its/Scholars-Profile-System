/**
 * Repository risk-tier lookup — partial port of
 * `~/Dropbox/Projects/Bulk Data Rule/pipeline/catalog.py`'s `R` list
 * (tier only; canonical name ↔ tier pairs). The org/country/access/bucket/
 * note fields on each `catalog.py` record are NOT ported here — nothing on
 * this dashboard reads them. Keep in sync if `catalog.py`'s `R` list changes
 * (repository added/removed, or a tier reclassified).
 *
 * Tier is a pure function of `repository` (`DatasetDeposit.repository`,
 * always the canonical name — see `attribute.py`'s `d['repo']`). Priority
 * order, most to least severe, matches `catalog.py`'s own comment:
 * CONCERN > FOREIGN_OPEN > FOREIGN_CTRL > US_OPEN > US_CTRL > REGISTRY.
 *
 * Scope note (SPEC "Amended 08-13"): this tier lookup is the ONLY basis for
 * the "concerning" flag surfaced on the data-sharing dashboard
 * (`lib/api/data-sharing-report.ts`, `components/edit/data-sharing-dashboard.tsx`).
 * That flag is tier-derived only (country-of-concern host, foreign-hosted) —
 * it does NOT include `catalog.py`'s open-deposit-of-sensitive-category
 * branch, which needs raw MeSH per citing publication and was cut this
 * session (see the SPEC's "Amended 08-13" note). Do not present a
 * tier-only "concerning" count as the full 3-way definition.
 */

/** `catalog.py`'s tier values, most to least severe. */
export const REPO_TIER: Record<string, string> = {
  "GSA-Human": "CONCERN",
  GSA: "CONCERN",
  "NGDC/CNCB (other)": "CONCERN",
  iProX: "CONCERN",
  "CNGB/CNSA": "CONCERN",

  dbGaP: "US_CTRL",
  ImmPort: "US_CTRL",

  GEO: "US_OPEN",
  SRA: "US_OPEN",
  "BioProject/BioSample": "US_OPEN",
  GenBank: "US_OPEN",
  "Metabolomics Workbench": "US_OPEN",
  MassIVE: "US_OPEN",
  Dryad: "US_OPEN",
  OSF: "US_OPEN",
  "Harvard Dataverse": "US_OPEN",
  TCIA: "US_OPEN",

  EGA: "FOREIGN_CTRL",

  "ArrayExpress/BioStudies": "FOREIGN_OPEN",
  ENA: "FOREIGN_OPEN",
  PRIDE: "FOREIGN_OPEN",
  MetaboLights: "FOREIGN_OPEN",
  figshare: "FOREIGN_OPEN",
  Zenodo: "FOREIGN_OPEN",
  "Mendeley Data": "FOREIGN_OPEN",
  ProteomeXchange: "FOREIGN_OPEN",

  OpenNeuro: "US_OPEN",
  "NDA (NIMH Data Archive)": "US_CTRL",
  PhysioNet: "US_OPEN",
  "IDR (Image Data Resource)": "FOREIGN_OPEN",
  Vivli: "US_CTRL",
  BioLINCC: "US_CTRL",
  Synapse: "US_OPEN",

  "ClinicalTrials.gov": "REGISTRY",
  CTRI: "REGISTRY",
  PDB: "REGISTRY",
};

/** Tier for a repository's canonical name, or `"UNKNOWN"` when the
 *  repository isn't in `catalog.py`'s `R` list (e.g. new repository added
 *  upstream, port not yet updated). */
export function tierOf(repository: string): string {
  return REPO_TIER[repository] ?? "UNKNOWN";
}
