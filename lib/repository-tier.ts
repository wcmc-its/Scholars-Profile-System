/**
 * Repository risk-tier + homepage-URL lookup — partial port of
 * `~/Dropbox/Projects/Bulk Data Rule/pipeline/catalog.py`'s `R` list
 * (tier and url only; canonical name ↔ tier/url pairs). The org/country/
 * access/bucket/note fields on each `catalog.py` record are NOT ported here —
 * nothing on this dashboard reads them. Keep in sync if `catalog.py`'s `R`
 * list changes (repository added/removed, tier reclassified, or url moves).
 *
 * `tierOf`'s tier is a pure function of `repository` (`DatasetDeposit
 * .repository`, always the canonical name; see `attribute.py`'s
 * `d['repo']`). Priority order, most to least severe, matches `catalog.py`'s
 * own comment: CONCERN > FOREIGN_OPEN > FOREIGN_CTRL > US_OPEN > US_CTRL >
 * REGISTRY.
 *
 * `effectiveTierOf` (2026-08-16, issue #2471) is the ONE deliberate exception
 * to that pure-function invariant: Synapse hosts both open and access-
 * controlled datasets, and `DatasetDeposit.accessModel` (per-deposit, synced
 * from the pipeline) already knows which, a fact `catalog.py`'s static `R`
 * list can't carry. Scoped to Synapse only, on this dashboard's own
 * computations only; see that function's own doc comment for the exact rule.
 * `REPO_TIER`/`tierOf` themselves are untouched and stay a faithful,
 * access-blind port of `catalog.py`.
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

/** Effective tier for one deposit row (2026-08-16, issue #2471). Normally
 *  identical to `tierOf(row.repository)` (every repository except Synapse,
 *  unchanged). Synapse is a deliberate, ONE-REPOSITORY carve-out: `REPO_TIER`
 *  above still lists Synapse as the static `"US_OPEN"` default (a faithful
 *  port of `catalog.py`'s own classification, not touched by this function),
 *  but `catalog.py`'s `R` list can't see the per-deposit access model that
 *  `DatasetDeposit.accessModel` (`prisma/schema.prisma`, synced from the
 *  pipeline) already carries. Synapse hosts both open and access-controlled
 *  datasets, and the static table can only ever state one default.
 *
 *  Rule, in priority order: a Synapse row with `accessModel === "controlled"`
 *  is bumped up to `"US_CTRL"` (more protected than the static default). A
 *  Synapse row with `accessModel === "open"` stays `"US_OPEN"` (matches the
 *  static default, nothing to bump). A Synapse row with `accessModel` `null`
 *  or `undefined` (unknown) falls back to the static default `"US_OPEN"`
 *  unchanged, same as today: this function never guesses a tier from
 *  missing access-model data. Every non-Synapse repository ignores
 *  `accessModel` entirely and returns `tierOf(row.repository)` as before.
 *
 *  This is NOT a general "any repository can be access-aware" mechanism;
 *  see the confirmed approach on issue #2471. `catalog.py` and this file's
 *  own `REPO_TIER`/`tierOf` stay the single static port; only this function,
 *  and only for Synapse, reads a per-deposit fact on top of it. Callers with
 *  an actual `DatasetLinkRow` in scope (`lib/api/data-sharing-report.ts`,
 *  `components/edit/data-sharing-dashboard.tsx`) should call this instead of
 *  `tierOf(row.repository)` directly; `tierOf` itself stays correct and in
 *  use for every call site that only has a repository NAME, no row/
 *  accessModel in scope (e.g. the dashboard's static `TIER_LABELS`/
 *  `FILTERABLE_TIERS` UI lookups). */
export function effectiveTierOf(row: { repository: string; accessModel?: string | null }): string {
  if (row.repository === "Synapse" && row.accessModel === "controlled") return "US_CTRL";
  return tierOf(row.repository);
}

/** Repository homepage, keyed identically to `REPO_TIER` (same 36 canonical
 *  names, same source row in `catalog.py`). This is the repository's own
 *  homepage — NOT a per-accession deep link; `components/profile/
 *  datasets-section.tsx`'s `ACCESSION_RESOLVERS` already covers per-accession
 *  URLs for the subset of repositories that need one, and stays separate
 *  from this table on purpose. */
export const REPO_URL: Record<string, string> = {
  "GSA-Human": "https://ngdc.cncb.ac.cn/gsa-human/",
  GSA: "https://ngdc.cncb.ac.cn/gsa/",
  "NGDC/CNCB (other)": "https://ngdc.cncb.ac.cn/",
  iProX: "https://www.iprox.cn/",
  "CNGB/CNSA": "https://db.cngb.org/cnsa/",

  dbGaP: "https://www.ncbi.nlm.nih.gov/gap/",
  ImmPort: "https://www.immport.org/",

  GEO: "https://www.ncbi.nlm.nih.gov/geo/",
  SRA: "https://www.ncbi.nlm.nih.gov/sra",
  "BioProject/BioSample": "https://www.ncbi.nlm.nih.gov/bioproject/",
  GenBank: "https://www.ncbi.nlm.nih.gov/genbank/",
  "Metabolomics Workbench": "https://www.metabolomicsworkbench.org/",
  MassIVE: "https://massive.ucsd.edu/",
  Dryad: "https://datadryad.org/",
  OSF: "https://osf.io/",
  "Harvard Dataverse": "https://dataverse.harvard.edu/",
  TCIA: "https://www.cancerimagingarchive.net/",

  EGA: "https://ega-archive.org/",

  "ArrayExpress/BioStudies": "https://www.ebi.ac.uk/biostudies/arrayexpress",
  ENA: "https://www.ebi.ac.uk/ena/browser/home",
  PRIDE: "https://www.ebi.ac.uk/pride/",
  MetaboLights: "https://www.ebi.ac.uk/metabolights/",
  figshare: "https://figshare.com/",
  Zenodo: "https://zenodo.org/",
  "Mendeley Data": "https://data.mendeley.com/",
  ProteomeXchange: "http://www.proteomexchange.org/",

  OpenNeuro: "https://openneuro.org/",
  "NDA (NIMH Data Archive)": "https://nda.nih.gov/",
  PhysioNet: "https://physionet.org/",
  "IDR (Image Data Resource)": "https://idr.openmicroscopy.org/",
  Vivli: "https://vivli.org/",
  BioLINCC: "https://biolincc.nhlbi.nih.gov/",
  Synapse: "https://www.synapse.org/",

  "ClinicalTrials.gov": "https://clinicaltrials.gov/",
  CTRI: "https://ctri.nic.in/",
  PDB: "https://www.rcsb.org/",
};

/** Homepage URL for a repository's canonical name, or `null` when unmapped
 *  (mirrors `tierOf`'s `"UNKNOWN"` fallback, `null` instead since there's no
 *  sensible placeholder URL). */
export function urlOf(repository: string): string | null {
  return REPO_URL[repository] ?? null;
}
