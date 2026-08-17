/**
 * `/edit/data-sharing` loader — S-Index Phase 1 admin/CTSA reporting
 * (`Data Sharing in Scholars Profile System - SPEC.md`, "Admin and CTSA
 * reporting"). Reads SPS's own `DatasetDeposit`/`PersonDatasetDeposit` bridge
 * (a deliberate deviation from the SPEC's original reciterdb-direct sequencing
 * — the bridge now exists and gets suppression-filtering for free; see the
 * 2026-08-12 dashboard plan).
 *
 * Scope note (v1, shipped this way on purpose, not an oversight): this loader
 * reports COUNTS ONLY — distinct datasets, distinct depositing faculty, link
 * volume — by department, by repository, and by named faculty. v1 deliberately
 * deferred "share rate" (a rate over a data-eligible publication denominator):
 * the SPEC's original MeSH-based "sensitive-category" denominator was
 * investigated and cut for cost/value reasons (see
 * `reference_shared_pct_column_needs_one_denominator` on why a wrong
 * denominator is worse than a missing one).
 *
 * Share rate (added after v1): a MeSH-free, SPEC-compliant fallback
 * denominator — every confirmed first/last-authored WCM publication since
 * `SHARE_RATE_YEAR_FLOOR`, no subject-matter subset. `loadShareRateCorpus` /
 * `buildShareRates` / `depositedPmidSet` build it; `buildDataSharingReport`
 * merges `shareRateDenominator`/`shareRateNumerator` onto `overall`,
 * `byDepartment`, and `byFaculty`. Still no full-text coverage stat — that
 * SPEC headline remains out of scope.
 *
 * Share rate, publication-type scope (2026-08-15): the denominator originally
 * had no publication-type filter, but the numerator's underlying deposit-scan
 * pipeline only ever covers `SHARE_RATE_ELIGIBLE_TYPES` — every other type
 * inflated the denominator with zero chance of a numerator hit. Fixed by
 * scoping `loadShareRateCorpus` to the same types. Doesn't close the whole
 * gap: the numerator is also full-time-faculty-only and SPS has no bridged
 * FTE field to match that on the denominator side — open, see
 * `SHARE_RATE_ELIGIBLE_TYPES`'s doc comment. Checked the corresponding-author
 * question too (a mockup footer claimed dashboard metrics go beyond
 * first/last): traced `PersonDatasetDeposit`'s only write path
 * (`etl/data-sharing/shared.ts`) back to `attribute.py`'s
 * `authorPosition IN ('first','last')` source query — no widening exists
 * anywhere in the pipeline, so no reconciliation was needed here.
 *
 * Strict-only (decided 2026-08-12): `DatasetDeposit.confidence` is only ever
 * `'high'` or `null` in what's actually persisted — there is no generous/ceiling
 * band to read. See the dashboard plan's "Strict/generous band" section.
 *
 * S-Index v2 (this PR): three free/cheap additions, zero migration. (1) Access
 * model split — `openDatasets`/`controlledDatasets` on `byDepartment`/
 * `byFaculty`, `openPubs`/`controlledPubs` on `overall` — via `bucketDatasetLink`.
 * (2) Registry separation — `registryDatasets` on `byDepartment` only (the
 * faculty table stays Open/Controlled-only); `REGISTRY_DATA_TYPE` rows
 * (ClinicalTrials.gov / CTRI) are excluded from the open/controlled split
 * everywhere, not just counted separately — counting a trial registration as
 * data sharing would inflate every number on this page. (3) Funding lens —
 * `nihFundedPubs`/`notNihFundedPubs` on `overall`, via `loadFundingSplit`
 * joining `GrantPublication`/`Grant.nihIc` over the same non-registry
 * deposited-pmid population the access split uses.
 *
 * S-Index v2, risk tier (this PR, stacked on the above): `tierOf` (`@/lib/
 * repository-tier`, a partial port of `catalog.py`'s `R` list — tier only)
 * classifies every `repository` by host jurisdiction × access model.
 * `byRepositoryTier` groups `byRepository` by tier; `pubsByTier` flattens
 * `pmids` per row keyed by tier (same Set-per-bucket, no-reconciliation
 * pattern as `pubAccessPmidSets`). `NamedFacultyRow.concerningDeposits` /
 * `.foreignHostedDeposits` and `overall.concerningDepositInstances` are
 * DEPOSIT-INSTANCE (row) counts, not distinct-dataset counts — see
 * `countConcerningDeposits`'s doc comment.
 *
 * SCOPE (SPEC "Amended 08-13", read before touching any of the above):
 * "concerning" here is TIER-DERIVED ONLY — CONCERN (country-of-concern host)
 * or FOREIGN_OPEN/FOREIGN_CTRL (foreign-hosted). It does NOT include
 * `catalog.py`'s open-deposit-of-sensitive-category branch, which needs raw
 * MeSH per citing publication and was cut this session. Never present this
 * flag as the full 3-way "concerning" definition in code or on the page.
 *
 * S-Index v2, granular sub-types (this PR, stacked on the above): reads the
 * new `DatasetDeposit.sensitiveCats`/`.sensitiveSubtypes` columns (from
 * `scripts/bulk-data-rule/taxonomy.py`'s `tag()`, via the companion
 * ReCiterDB PR + `attribute.py`'s `WRITE_DATASET_DEPOSIT` path) and adds
 * `bySubtype` — deposit-instance counts per granular sub-type (e.g.
 * "genomic:WGS/WES"), grouped by coarse category, via `aggregateBySubtype`.
 * Dark until the companion columns exist on the live `reciterdb.dataset_deposit`
 * AND `etl/data-sharing` has re-run — see that PR's description.
 *
 * v3, stakeholder feedback pass (this PR): (1) Tier padding —
 * `aggregateRepositoriesByTier` and `tierPubSpectrum` now emit a zero row for
 * every tier rather than only tiers present in the data, so "Country of
 * concern · 0" is a visible statement instead of a silent absence (see
 * `paddedTiers`). (2) PMC coverage — `loadShareRateCorpus` now also reads the
 * publication's `pmcid`; `overall.pmcCoveredPubs`/`.pmcDepositedPubs` (via
 * `pmcCoverage`) bound the full-text arm of the deposit scan by the corpus it
 * can actually inspect. (3) `dataset_url` on the item CSV, via the profile
 * page's own `resolveDatasetUrl` resolver table — same deep link per accession
 * as the public "Datasets" section, not just the repository homepage.
 * (4) Item-grain section exports — `buildSectionItemsCsv` gives every
 * aggregate table a one-row-per-(person, dataset)-link download, organized to
 * match that table's grouping (the stakeholder wants drill-down items, not
 * just the rollups). (5) Registry rows excluded from `depositedPmidSet`
 * (review finding): the share-rate numerator and `pmcDepositedPubs` counted a
 * pub whose only detected signal was a ClinicalTrials.gov registration, while
 * the methods prose claimed registrations were excluded — see that function's
 * doc comment. The headline distinct-dataset/faculty/link totals and
 * `byRepository` still include registry rows on purpose (they describe
 * everything detected, with registry visible in its own buckets).
 *
 * NIH-funded filter (2026-08-16, GitHub #2469): `DataSharingReportFilters
 * .nihFunded` finishes the three-field filter ask that shipped year range and
 * tier first (see `DataSharingReportFilters`'s own doc comment for why the
 * NIH-funded row filter needed its own pass: a pmid's NIH-funded status
 * needs `loadFundingSplit`'s async grant join to resolve before a row can be
 * kept or dropped, so it can't fold into `applyReportFilters`'s synchronous
 * pass). `loadDataSharingReport` runs `loadFundingSplit` on `rawRows` now,
 * always the full unfiltered corpus, then applies `applyNihFilter` as a
 * second pass over the year/tier-filtered rows, then recomputes the funding
 * totals actually reported (`deriveFundingTotals`) from the FINAL filtered
 * row set rather than trusting `loadFundingSplit`'s own (always-unfiltered)
 * totals; see that function's doc comment for the regression this avoids.
 * Filtered CSV export (2026-08-16, GitHub #2470): `/edit/data-sharing/export`
 * now parses and applies the same filters (year/tier/nihFunded) the on-page
 * tables use, on all three of its export paths; see that route's own doc
 * comment. Every `DownloadLink` on the page reflects the active filter now,
 * so the export caption no longer needs its old "ignores filters" caveat.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { resolveDatasetUrl } from "@/components/profile/datasets-section";
import { loadContributorSuppressions } from "@/lib/api/manual-layer";
import { toCsv, type CsvCell } from "@/lib/csv";
import { tierOf } from "@/lib/repository-tier";

/** The Prisma surface this loader needs — kept narrow for unit tests. */
export type DataSharingReportClient = Pick<
  PrismaClient,
  "personDatasetDeposit" | "suppression" | "publicationAuthor" | "grantPublication" | "datasetDeposit"
>;

/** Matches the Python extraction pipeline's own year>=2020 floor
 *  (scripts/bulk-data-rule/attribute.py's load_db()/load_ft()). The
 *  deposit-detection pipeline never scanned pubs before this year, so
 *  counting them in the denominator would manufacture "no detected deposit"
 *  for pubs that were simply never checked — not a scope choice, a
 *  coverage-window fix. */
export const SHARE_RATE_YEAR_FLOOR = 2020;

/** Matches the Python extraction pipeline's own corpus-query scope
 *  (`extract_databanks.py` hardcodes `publicationTypeCanonical = 'Academic
 *  Article'`; `preprint_extend.py` adds `'Preprint'`). Nothing outside these
 *  two types is ever scanned for deposits, so counting them in the
 *  denominator inflates it with pubs that have zero chance of ever
 *  contributing to the numerator (2026-08-15 fix — see the data-sharing
 *  dashboard handoff). The numerator's extraction pipeline is also
 *  full-time-faculty-only (`attribute.py`'s `fullTimeFaculty='yes'`) — a
 *  2026-08-15 comment here claimed SPS had no bridged field to match that on
 *  the denominator side, which was wrong: `Scholar.roleCategory ===
 *  'full_time_faculty'` is exactly that field (ETL-populated from ED/LDAP,
 *  already the standard full-time check in 20+ other places — `lib/
 *  eligibility.ts`, `lib/api/topics.ts`, `lib/api/spotlight.ts`, etc). Fixed
 *  2026-08-16 (review finding): `loadShareRateCorpus` now scopes to it. */
const SHARE_RATE_ELIGIBLE_TYPES = ["Academic Article", "Preprint"] as const;

/** Two known duplicate `Scholar.primaryDepartment` strings for the same real
 *  org unit — confirmed via a live staging probe (2026-08-16 review): 591
 *  scholars carry "Weill Cornell Graduate School", 6 carry the shorter
 *  "Graduate School". An upstream ED/LDAP naming inconsistency, not
 *  something this dashboard's aggregation should surface as two separate
 *  departments (a dean reading "0 datasets, 0 faculty" next to "Graduate
 *  School" while "Weill Cornell Graduate School" has real numbers reads as a
 *  missing-data bug, not a spelling variant). Applied once, at ingestion
 *  (`loadDatasetLinkRows`/`loadShareRateCorpus`), not per-aggregate — a
 *  bounded 1-entry map, not a general department-normalization system; add
 *  an entry here only when another confirmed duplicate turns up. */
const DEPARTMENT_ALIASES: Record<string, string> = {
  "Graduate School": "Weill Cornell Graduate School",
};

function normalizeDepartmentName(department: string | null): string | null {
  if (department === null) return null;
  return DEPARTMENT_ALIASES[department] ?? department;
}

/** The display label a null `DatasetLinkRow.department`/`ShareRateCorpusRow
 *  .department` groups under — `aggregateByDepartment` and `buildShareRates`
 *  both fall back to this exact string so the two rollups' "no department on
 *  file" bucket keys match. Exported (2026-08-16 adversarial-review finding)
 *  so `matchesItemsFilter` can translate the label back to `null` when a §3
 *  department-table row's "Items" link passes it as the filter value — the
 *  dashboard's per-row link uses `DepartmentRollup.department` (already the
 *  label, never raw `null`), so comparing it directly against a
 *  `DatasetLinkRow.department` of `null` silently matched zero rows. */
export const UNKNOWN_DEPARTMENT_LABEL = "Unknown / no department on file";

/** One suppression-filtered (person, dataset) link, flattened for aggregation —
 *  the shape every `aggregateBy*` function below operates on. Exported so
 *  tests can build fixtures directly, without a Prisma mock. */
export type DatasetLinkRow = {
  cwid: string;
  scholarName: string;
  scholarSlug: string;
  department: string | null;
  datasetId: string;
  repository: string;
  accessModel: string | null;
  /** Export-only fields (exact `DatasetDeposit` column names, prisma/schema.prisma)
   *  — none of the `aggregateBy*` functions below read these, they exist so the
   *  item-level CSV export (below) can reuse this same suppression-filtered row
   *  set instead of a second query. Optional (not just nullable) so the existing
   *  rollup-fixture rows in `tests/unit/data-sharing-report.test.ts` don't need
   *  touching — a strict additive extension, not a reshape. */
  title?: string | null;
  accessionOrDoi?: string;
  resourceType?: string | null;
  dataType?: string | null;
  depositYear?: number | null;
  provenance?: string;
  confidence?: string | null;
  /** `PersonDatasetDeposit.pmids` (top-level on the link, not on `dataset`)
   *  — the citing pmids for this (cwid, dataset) pair. Unlike the
   *  export-only fields above, this one IS read outside the CSV path:
   *  `depositedPmidSet` (below) flattens it across every non-registry row to
   *  build the share-rate numerator. Same optional-not-nullable shape so the
   *  existing rollup-fixture rows in `tests/unit/data-sharing-report.test.ts`
   *  stay valid untouched. */
  pmids?: string[];
  /** `DatasetDeposit.sensitiveCats`/`.sensitiveSubtypes` (S-Index v2 granular
   *  sub-types) — like `pmids` above, NOT export-only: `aggregateBySubtype`
   *  (below) parses `sensitiveSubtypes` to build `DataSharingReport.bySubtype`,
   *  so these live outside the export-only block even though `sensitiveCats`
   *  itself is currently read only by the CSV export. Optional, same
   *  not-nullable-but-optional shape as `pmids`, for the same reason: existing
   *  rollup-fixture rows in `tests/unit/data-sharing-report.test.ts` predate
   *  these columns and shouldn't need touching. */
  sensitiveCats?: string | null;
  sensitiveSubtypes?: string | null;
};

export type DepartmentRollup = {
  department: string;
  datasets: number;
  faculty: number;
  links: number;
  /** Distinct-dataset counts split by access model / registry status — see
   *  `bucketDatasetLink`'s doc comment for the exact bucketing rule (registry
   *  checked before access model; a dataset can appear in exactly one of these
   *  three, or none, if `accessModel` is null on a non-registry deposit).
   *  Required, not optional, unlike the share-rate fields above:
   *  `aggregateByDepartment` is the only producer of `DepartmentRollup` and
   *  every caller goes through it, so there is no partial-construction path
   *  that would need these to be optional. */
  openDatasets: number;
  controlledDatasets: number;
  registryDatasets: number;
  /** Share-rate totals for this department, merged in by `buildDataSharingReport`.
   *  Optional (not required) so it stays additive over `aggregateByDepartment`'s
   *  own output and over pre-existing test fixtures that predate the share rate. */
  shareRateDenominator?: number;
  shareRateNumerator?: number;
};

export type RepositoryBreakdown = {
  repository: string;
  /** `'open' | 'controlled'`, or null when no deposit in this repository has
   *  one recorded. A repository is a fixed access model in practice, but the
   *  data model carries it per-deposit, not per-repository. */
  accessModel: string | null;
  datasets: number;
  /** `tierOf(repository)` — `'CONCERN' | 'FOREIGN_OPEN' | 'FOREIGN_CTRL' |
   *  'US_OPEN' | 'US_CTRL' | 'REGISTRY' | 'UNKNOWN'`. Pure function of
   *  `repository`, computed here rather than stored — see `@/lib/
   *  repository-tier`'s header for the tier-only SPEC-boundary note. */
  tier: string;
};

export type NamedFacultyRow = {
  cwid: string;
  name: string;
  slug: string;
  department: string | null;
  datasets: number;
  links: number;
  /** Same bucketing rule as `DepartmentRollup.openDatasets`/`controlledDatasets`
   *  (registry checked first, then access model) — no `registryDatasets` here
   *  on purpose, the faculty table only ever shows Open/Controlled. Required,
   *  same rationale as `DepartmentRollup`: `aggregateByFaculty` is the only
   *  producer. */
  openDatasets: number;
  controlledDatasets: number;
  /** Deposit-INSTANCE (row) counts, not distinct-dataset or distinct-pub
   *  counts — same grain as `links` above, not `datasets`. `concerningDeposits`
   *  counts rows whose `tierOf(repository)` is `'CONCERN'` OR
   *  `'FOREIGN_OPEN'`/`'FOREIGN_CTRL'`; `foreignHostedDeposits` counts only
   *  the `FOREIGN_*` subset (`CONCERN` is its own, more severe bucket — not
   *  "foreign-hosted" in this taxonomy, so it does NOT also count toward
   *  `foreignHostedDeposits`). Tier-derived only — see
   *  `countConcerningDeposits`'s doc comment and the module header's SPEC
   *  "Amended 08-13" scope note. Required, same rationale as `openDatasets`/
   *  `controlledDatasets`: `aggregateByFaculty` is the only producer. */
  concerningDeposits: number;
  foreignHostedDeposits: number;
  /** Share-rate totals for this scholar — same optional/merge shape as
   *  `DepartmentRollup`'s fields, see that comment. */
  shareRateDenominator?: number;
  shareRateNumerator?: number;
};

/** catalog.py's `bucket` field for ClinicalTrials.gov / CTRI rows — trial
 *  registration, not identifiable microdata. `DatasetLinkRow.dataType` /
 *  `DatasetDeposit.dataType` carry this exact string for those rows. Checked
 *  BEFORE `accessModel` everywhere on this page: a registry deposit must never
 *  land in the open/controlled split even though its `accessModel` may itself
 *  resolve to `'open'` (ClinicalTrials.gov's catalog row is "open registry").
 *  Counting ClinicalTrials.gov as data sharing would inflate every number —
 *  registries are separated everywhere on this page. */
export const REGISTRY_DATA_TYPE = "registration (not microdata)";

/** One dataset link's access bucket — the single rule every open/controlled/
 *  registry split on this page shares. Registry status wins first; only a
 *  non-registry row is then split by `accessModel`. `null` (ambiguous/unknown
 *  access, e.g. the Synapse "open/controlled" case `access_model()` in
 *  `scripts/bulk-data-rule/attribute.py` now returns `None` for) is a real
 *  third outcome — uncounted in either bucket, not silently forced into one. */
export function bucketDatasetLink(row: Pick<DatasetLinkRow, "dataType" | "accessModel">): "open" | "controlled" | "registry" | null {
  if (row.dataType === REGISTRY_DATA_TYPE) return "registry";
  if (row.accessModel === "open") return "open";
  if (row.accessModel === "controlled") return "controlled";
  return null;
}

/** One confirmed first/last-authored WCM publication in the share-rate
 *  denominator corpus (`loadShareRateCorpus`). Deliberately MeSH-free — no
 *  subject-matter filtering, just "is this a WCM-credited pub the deposit
 *  pipeline could have scanned".
 *
 *  `inPmc` (`Publication.pmcid` non-null) is optional-not-nullable for the
 *  same backward-compat reason as `DatasetLinkRow.pmids`: pre-PMC test
 *  fixtures build these rows as literals and shouldn't need touching. Absent
 *  reads as `false` (`pmcCoverage` below). Why it matters at all: the
 *  full-text availability-statement arm of the deposit scan can only inspect
 *  pubs whose full text is IN PMC — see `pmcCoverage`'s doc comment. */
export type ShareRateCorpusRow = { pmid: string; cwid: string; department: string | null; inPmc?: boolean };

/** `catalog.py`'s tier priority order, most to least severe — the sort order
 *  `aggregateRepositoriesByTier` and `pubsByTier` both use. `'UNKNOWN'`
 *  (a repository not in `@/lib/repository-tier`'s port) sorts last, after
 *  `REGISTRY`. */
export const TIER_ORDER = ["CONCERN", "FOREIGN_OPEN", "FOREIGN_CTRL", "US_OPEN", "US_CTRL", "REGISTRY", "UNKNOWN"] as const;

/** The tier list both tier aggregates emit rows for, in `TIER_ORDER`: every
 *  real tier ALWAYS, whether or not the data has one, plus `UNKNOWN` only
 *  when it actually occurs. Zero-padding is the point, not a convenience
 *  (2026-08-16 stakeholder feedback): "Country of concern · 0" is a visible
 *  compliance STATEMENT — "we checked, there are none" — and silently
 *  dropping the row turned the strongest possible answer into an absence.
 *  `UNKNOWN` is the one exception because it's not a real-world claim, just
 *  a port-lag bucket (`tierOf`'s fallback) — a permanent "Unclassified · 0"
 *  row would imply an unclassified category exists when it doesn't. */
function paddedTiers(present: ReadonlySet<string>): string[] {
  // Union, not intersection: a tier value present in the data but missing
  // from TIER_ORDER (a future catalog.py sync adding a tier without updating
  // the order list) must still be emitted — silently dropping it would make
  // its datasets vanish from the tier table, the spectrum, and the tiers CSV
  // with nothing failing loudly. Appended after the known order, sorted for
  // determinism.
  const base = TIER_ORDER.filter((tier) => tier !== "UNKNOWN" || present.has("UNKNOWN"));
  const extras = [...present].filter((t) => !(TIER_ORDER as readonly string[]).includes(t)).sort();
  return [...base, ...extras];
}

/** The tier-only "concerning" set per the SPEC's "Amended 08-13" note —
 *  CONCERN (country-of-concern host) plus both foreign-hosted tiers. Shared
 *  by `countConcerningDeposits` (per-faculty and whole-corpus) so the
 *  definition can't drift between the two call sites. */
const CONCERNING_TIERS = new Set(["CONCERN", "FOREIGN_OPEN", "FOREIGN_CTRL"]);
/** The foreign-hosted subset of `CONCERNING_TIERS` — deliberately excludes
 *  `CONCERN`, which is its own more severe bucket, not "foreign-hosted" in
 *  this taxonomy (see `NamedFacultyRow.foreignHostedDeposits`'s comment). */
const FOREIGN_HOSTED_TIERS = new Set(["FOREIGN_OPEN", "FOREIGN_CTRL"]);

/** Repositories grouped by risk tier — "Repositories by risk tier" on the
 *  dashboard. Groups `aggregateByRepository`'s existing per-repository
 *  output by `tier`, summing `datasets` and collecting repository names;
 *  does not re-scan `DatasetLinkRow`s. Sorted by `TIER_ORDER`. */
export type RepositoryTierRollup = {
  tier: string;
  datasets: number;
  repositories: string[];
};

/** One tier's distinct-publication count — the Rollup's tier "spectrum".
 *  Built the same way `pubAccessPmidSets` builds its open/controlled sets:
 *  one `Set<pmid>` per bucket (here, per tier), flattened from every row's
 *  `pmids`. A pmid can land in more than one tier (deposits of the same
 *  publication in repositories of different tiers) — real, not reconciled
 *  away, same spirit as every other multi-bucket caveat in this file. */
export type TierPubSpectrumRow = {
  tier: string;
  pubs: number;
};

export type DataSharingReport = {
  overall: {
    datasets: number;
    faculty: number;
    links: number;
    shareRateDenominator: number;
    shareRateNumerator: number;
    /** PMC coverage of the share-rate corpus — `pmcCoveredPubs` is the count
     *  of distinct corpus pmids whose full text is in PubMed Central
     *  (`Publication.pmcid` non-null); `pmcDepositedPubs` is how many of THOSE
     *  have a detected deposit. KNOWN DATA-QUALITY GAP (2026-08-16 review,
     *  confirmed via staging probe): `Publication.pmcid` reads non-null for
     *  99.7% of the ENTIRE `Publication` table (191,377/191,974), not just
     *  this corpus — a near-universal "in PMC" rate across pre-2008 pubs,
     *  non-NIH-funded work, and non-biomedical journals isn't plausible as
     *  genuine full-text coverage. The field (sourced from ReCiter's
     *  `analysis_summary_article.pmcid`, a separate upstream system this repo
     *  doesn't own) isn't currently a trustworthy "full text is in PMC"
     *  signal. Kept on the report (raw counts, not hidden) but the dashboard
     *  must NOT present it as a fair bounding denominator until the upstream
     *  field is investigated — see the "Known gaps" methods section. Built by
     *  `pmcCoverage`. */
    pmcCoveredPubs: number;
    pmcDepositedPubs: number;
    /** Distinct publications with at least one detected OPEN-access deposit,
     *  and separately at least one detected CONTROLLED-access deposit — built
     *  by `pubAccessPmidSets`, registry rows excluded entirely (same rationale
     *  as `REGISTRY_DATA_TYPE`'s doc comment). A pmid can land in both sets
     *  (different deposits, different access models on the same publication)
     *  — that's real, same spirit as the multi-department caveat elsewhere in
     *  this file; don't reconcile it away. */
    openPubs: number;
    controlledPubs: number;
    /** NIH-funded vs. not-NIH-funded split over the same non-registry deposited
     *  pmid population `openPubs`/`controlledPubs` are built from — see
     *  `loadFundingSplit`. "Not NIH-funded" is the honest claim, not
     *  "non-federal": `Grant.nihIc` is only ever populated for NIH awards, so
     *  other-federal funding (CDC/NSF/etc.) isn't distinguishable from truly
     *  non-federal with this field. */
    nihFundedPubs: number;
    notNihFundedPubs: number;
    /** Whole-corpus deposit-INSTANCE (row) count, tier-only definition — the
     *  one Compliance-view number buildable without the COC-coauthor pull
     *  (SPEC "Amended 08-13"). Same `countConcerningDeposits` rule as
     *  `NamedFacultyRow.concerningDeposits`, summed over every row instead
     *  of grouped by faculty. NOT a distinct-dataset or distinct-pub count —
     *  see that field's comment. */
    concerningDepositInstances: number;
    /** Deposit instances with at least one parseable sub-type token — see
     *  `countSubtypeClassifiedInstances`. Compare against `links` for §5's
     *  own coverage statement. */
    subtypeClassifiedInstances: number;
  };
  byDepartment: DepartmentRollup[];
  byRepository: RepositoryBreakdown[];
  /** `byRepository` grouped by tier — see `RepositoryTierRollup`. */
  byRepositoryTier: RepositoryTierRollup[];
  /** Distinct-publication count per tier — see `TierPubSpectrumRow`. */
  pubsByTier: TierPubSpectrumRow[];
  /** Distinct-dataset count per deposit year — see `aggregateByYear`. */
  byYear: YearlyDepositRow[];
  byFaculty: NamedFacultyRow[];
  /** Deposit-instance counts per granular sensitive sub-type, grouped by
   *  coarse category — see `aggregateBySubtype`. */
  bySubtype: SubtypeRow[];
  /** Access-model × NIH-funding cross-tab — see `buildAccessFundingCrossTab`. */
  accessFundingCrossTab: AccessFundingCrossTab;
  /** The `RECENT_ITEMS_LIMIT` most recently deposited items — see
   *  `mostRecentDeposits`'s doc comment for what "recent" can and can't mean
   *  with this data model. */
  recentItems: DatasetLinkRow[];
  /** MAX(lastRefreshedAt) across `DatasetDeposit` — when the weekly
   *  data-sharing bridge last fully synced (every row gets the same run
   *  timestamp, see `etl/data-sharing/shared.ts`'s `buildDepositsAndLinks`).
   *  Null if the table has never been populated. */
  dataAsOf: Date | null;
  /** True min/max `depositYear` across the FULL unfiltered corpus, for the
   *  §3 filter form's ghost text and native min/max clamp (2026-08-16 ask).
   *  Deliberately NOT derived from whatever `filters` narrowed the rest of
   *  this report down to, since a stakeholder narrowing the tier filter to
   *  `CONCERN` must not see the year bounds themselves shrink to match. That
   *  would make the ghost text misreport the true earliest/latest deposit
   *  year in the data. Computed by `computeDepositYearBounds` over `rawRows`
   *  and spread onto the return value only inside `loadDataSharingReport`
   *  (alongside `dataAsOf`, same populate-point), NOT threaded through
   *  `buildDataSharingReport`'s params. That way a test building a report
   *  via that function directly never has to supply a value neither it nor
   *  its own fixtures care about. */
  depositYearBounds: DepositYearBounds;
};

/** Read every active (person, dataset) link, suppression-filtered — a whole-
 *  dataset suppression drops every link to it; a per-contributor suppression
 *  drops only that one person's link, mirroring the profile "Datasets" section
 *  and the `/edit` Datasets card (`lib/api/profile.ts`'s `datasetSuppressions`
 *  pattern, generalized via the same `loadContributorSuppressions` helper). */
export async function loadDatasetLinkRows(client: DataSharingReportClient): Promise<DatasetLinkRow[]> {
  const links = await client.personDatasetDeposit.findMany({
    select: {
      cwid: true,
      datasetId: true,
      // Top-level on the link (PersonDatasetDeposit), not nested under
      // `dataset` — the citing pmids are per (cwid, dataset) pair, not a
      // property of the dataset itself.
      pmids: true,
      scholar: { select: { preferredName: true, fullName: true, slug: true, primaryDepartment: true } },
      // Widened for the item-level CSV export (below) — the three rollup
      // aggregates only ever read repository/accessModel; the rest are
      // export-only and otherwise ignored.
      dataset: {
        select: {
          repository: true,
          accessModel: true,
          title: true,
          accessionOrDoi: true,
          resourceType: true,
          dataType: true,
          sensitiveCats: true,
          sensitiveSubtypes: true,
          depositYear: true,
          provenance: true,
          confidence: true,
        },
      },
    },
  });
  if (links.length === 0) return [];

  const suppressions = await loadContributorSuppressions(
    "dataset_deposit",
    [...new Set(links.map((l) => l.datasetId))],
    client,
  );

  const rows: DatasetLinkRow[] = [];
  for (const l of links) {
    if (suppressions.darkIds.has(l.datasetId)) continue;
    if (suppressions.hiddenContributorsById.get(l.datasetId)?.has(l.cwid)) continue;
    rows.push({
      cwid: l.cwid,
      scholarName: l.scholar.preferredName || l.scholar.fullName,
      scholarSlug: l.scholar.slug,
      department: normalizeDepartmentName(l.scholar.primaryDepartment),
      datasetId: l.datasetId,
      repository: l.dataset.repository,
      accessModel: l.dataset.accessModel,
      title: l.dataset.title,
      accessionOrDoi: l.dataset.accessionOrDoi,
      resourceType: l.dataset.resourceType,
      dataType: l.dataset.dataType,
      sensitiveCats: l.dataset.sensitiveCats,
      sensitiveSubtypes: l.dataset.sensitiveSubtypes,
      depositYear: l.dataset.depositYear,
      provenance: l.dataset.provenance,
      confidence: l.dataset.confidence,
      // Real MySQL JSON column via Prisma — narrow defensively (`Json` is
      // `JsonValue`, not `string[]`), same idiom as `edit-context.ts`'s
      // dataset loader.
      pmids: Array.isArray(l.pmids) ? l.pmids.filter((p): p is string => typeof p === "string") : [],
    });
  }
  return rows;
}

/** Read every confirmed first/last-authored, full-time-faculty WCM
 *  publication since `SHARE_RATE_YEAR_FLOOR`, scoped to
 *  `SHARE_RATE_ELIGIBLE_TYPES` — the share-rate denominator corpus.
 *  `roleCategory: "full_time_faculty"` (2026-08-16 review finding) matches
 *  the numerator extraction pipeline's own `fullTimeFaculty='yes'` scope —
 *  see `SHARE_RATE_ELIGIBLE_TYPES`'s doc comment for why a prior comment
 *  here claiming no such field existed was wrong. Confirmed via staging
 *  probe: this shrinks the corpus from 16,984 to 8,508 distinct pmids — a
 *  real, roughly-2x change to every share-rate percentage on the page, not a
 *  cosmetic fix. `cwid` is guaranteed non-null by the `where` clause
 *  (`cwid: { not: null }`) even though Prisma's generated type keeps the
 *  column's nullable declaration; asserted once here rather than threading
 *  `string | null` through every downstream aggregate. */
export async function loadShareRateCorpus(client: DataSharingReportClient): Promise<ShareRateCorpusRow[]> {
  const rows = await client.publicationAuthor.findMany({
    where: {
      OR: [{ isFirst: true }, { isLast: true }],
      isConfirmed: true,
      cwid: { not: null },
      scholar: { roleCategory: "full_time_faculty" },
      publication: {
        year: { gte: SHARE_RATE_YEAR_FLOOR },
        publicationType: { in: [...SHARE_RATE_ELIGIBLE_TYPES] },
      },
    },
    select: {
      pmid: true,
      cwid: true,
      scholar: { select: { primaryDepartment: true } },
      // `pmcid` non-null ⇒ the pub's full text is in PubMed Central — the only
      // corpus the full-text availability-statement scan can inspect, so this
      // is the PMC-coverage denominator (`pmcCoverage` below), not a display
      // field. 2026-08-16: empirically this reads ~100% institution-wide
      // (99.7% of the ENTIRE Publication table, not just this corpus — see
      // `PmcCoverageTotals`'s doc comment), so treat it as a known
      // data-quality gap in the upstream field, not a working denominator.
      publication: { select: { pmcid: true } },
    },
  });
  return rows.map((row) => ({
    pmid: row.pmid,
    cwid: row.cwid as string,
    department: normalizeDepartmentName(row.scholar?.primaryDepartment ?? null),
    inPmc: row.publication?.pmcid != null,
  }));
}

/** Distinct-dataset / distinct-faculty / link counts, department is
 *  single-valued per scholar so faculty counts partition cleanly across
 *  departments — but dataset counts do NOT (a dataset with co-authors in two
 *  departments counts once in each), so summing this table's `datasets`
 *  column will run ahead of `overall.datasets`. That's real multi-department
 *  co-authorship, not a bug — don't silently reconcile it away. */
export function aggregateByDepartment(rows: readonly DatasetLinkRow[]): DepartmentRollup[] {
  const byDept = new Map<
    string,
    {
      datasets: Set<string>;
      faculty: Set<string>;
      links: number;
      openDatasets: Set<string>;
      controlledDatasets: Set<string>;
      registryDatasets: Set<string>;
    }
  >();
  for (const r of rows) {
    const dept = r.department ?? UNKNOWN_DEPARTMENT_LABEL;
    const bucket = byDept.get(dept) ?? {
      datasets: new Set(),
      faculty: new Set(),
      links: 0,
      openDatasets: new Set<string>(),
      controlledDatasets: new Set<string>(),
      registryDatasets: new Set<string>(),
    };
    bucket.datasets.add(r.datasetId);
    bucket.faculty.add(r.cwid);
    bucket.links++;
    const kind = bucketDatasetLink(r);
    if (kind === "registry") bucket.registryDatasets.add(r.datasetId);
    else if (kind === "open") bucket.openDatasets.add(r.datasetId);
    else if (kind === "controlled") bucket.controlledDatasets.add(r.datasetId);
    byDept.set(dept, bucket);
  }
  return [...byDept.entries()]
    .map(([department, b]) => ({
      department,
      datasets: b.datasets.size,
      faculty: b.faculty.size,
      links: b.links,
      openDatasets: b.openDatasets.size,
      controlledDatasets: b.controlledDatasets.size,
      registryDatasets: b.registryDatasets.size,
    }))
    .sort((a, b) => b.datasets - a.datasets);
}

/** Distinct-dataset count per repository. `accessModel` is read off whichever
 *  row is seen first for that repository — see `RepositoryBreakdown`'s note on
 *  why this is per-deposit data being read as if it were per-repository.
 *  `tier` is `tierOf(repository)` — a pure function of the repository name,
 *  so unlike `accessModel` there's no first-seen ambiguity to resolve. */
export function aggregateByRepository(rows: readonly DatasetLinkRow[]): RepositoryBreakdown[] {
  const byRepo = new Map<string, { datasets: Set<string>; accessModel: string | null }>();
  for (const r of rows) {
    const bucket = byRepo.get(r.repository) ?? { datasets: new Set(), accessModel: null };
    bucket.datasets.add(r.datasetId);
    if (bucket.accessModel === null && r.accessModel !== null) bucket.accessModel = r.accessModel;
    byRepo.set(r.repository, bucket);
  }
  return [...byRepo.entries()]
    .map(([repository, b]) => ({ repository, accessModel: b.accessModel, datasets: b.datasets.size, tier: tierOf(repository) }))
    .sort((a, b) => b.datasets - a.datasets);
}

/** Groups `aggregateByRepository`'s output by tier — "Repositories by risk
 *  tier". Sums each tier's `datasets` (same double-count caveat as
 *  `aggregateByDepartment`: a dataset deposited to two repositories in the
 *  same tier is not expected here since `RepositoryBreakdown` is already
 *  one row per repository, but a dataset multi-deposited across repositories
 *  in the SAME tier would still sum, not dedup, across those repositories —
 *  no worse than `byRepository` itself). Sorted by `TIER_ORDER`.
 *
 *  Emits one row for EVERY tier (zero-filled when absent from the data),
 *  not just tiers present — a "Country of concern · 0" row is a deliberate
 *  visible statement, see `paddedTiers`. `UNKNOWN` only when it has data. */
export function aggregateRepositoriesByTier(byRepository: readonly RepositoryBreakdown[]): RepositoryTierRollup[] {
  const byTier = new Map<string, { datasets: number; repositories: string[] }>();
  for (const r of byRepository) {
    const bucket = byTier.get(r.tier) ?? { datasets: 0, repositories: [] };
    bucket.datasets += r.datasets;
    bucket.repositories.push(r.repository);
    byTier.set(r.tier, bucket);
  }
  // Iterating `paddedTiers` (already in TIER_ORDER) IS the sort.
  return paddedTiers(new Set(byTier.keys())).map((tier) => {
    const b = byTier.get(tier);
    return { tier, datasets: b?.datasets ?? 0, repositories: b?.repositories ?? [] };
  });
}

/** Distinct-publication count per tier — the Rollup's tier "spectrum". Same
 *  Set-per-bucket, flatten-`pmids` pattern as `pubAccessPmidSets`, keyed on
 *  `tierOf(r.repository)` instead of `bucketDatasetLink`. Registry rows are
 *  NOT excluded here (unlike `pubAccessPmidSets`) — a registry repository has
 *  its own tier (`REGISTRY`) and belongs in its own spectrum bucket, same as
 *  every other tier. A pmid can land in multiple tiers; not reconciled away,
 *  see `TierPubSpectrumRow`'s comment.
 *
 *  Emits one row for EVERY tier (`pubs: 0` when absent from the data), not
 *  just tiers present — same `paddedTiers` rationale as
 *  `aggregateRepositoriesByTier`: the §1 spectrum legend must be able to say
 *  "Country of concern · 0" rather than omit the tier. `UNKNOWN` only when
 *  it has data. */
export function tierPubSpectrum(rows: readonly DatasetLinkRow[]): TierPubSpectrumRow[] {
  const byTier = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.pmids || r.pmids.length === 0) continue;
    const tier = tierOf(r.repository);
    const set = byTier.get(tier) ?? new Set<string>();
    for (const pmid of r.pmids) set.add(pmid);
    byTier.set(tier, set);
  }
  // Iterating `paddedTiers` (already in TIER_ORDER) IS the sort.
  return paddedTiers(new Set(byTier.keys())).map((tier) => ({
    tier,
    pubs: byTier.get(tier)?.size ?? 0,
  }));
}

export type SubtypeRow = { category: string; subtype: string; count: number };

/** Parse one row's `sensitiveSubtypes` string — `'|'`-delimited
 *  `"coarseCategory:label"` pairs (e.g. `"genomic:WGS/WES"`, from
 *  `scripts/bulk-data-rule/taxonomy.py`'s `tag()`) — into (category, subtype)
 *  pairs. A malformed token (no `':'` separator, or an empty half) is skipped
 *  rather than crashing or landing in a silent "unknown" bucket. THE single
 *  parser: `aggregateBySubtype` (the §5 rollup), `buildSectionItemsCsv`'s
 *  `"subtypes"` explosion, and the dashboard's §6 Sub-types column
 *  (`components/edit/data-sharing-dashboard.tsx`) all call this, so the three
 *  can't drift on what counts as a parseable token — exported for that third
 *  consumer, not for general reuse. */
export function parseSensitiveSubtypes(sensitiveSubtypes: string | null | undefined): { category: string; subtype: string }[] {
  if (!sensitiveSubtypes) return [];
  const pairs: { category: string; subtype: string }[] = [];
  for (const token of sensitiveSubtypes.split("|")) {
    const t = token.trim();
    if (!t) continue;
    const idx = t.indexOf(":");
    if (idx <= 0) continue; // no category prefix — malformed, skip
    const category = t.slice(0, idx).trim();
    const subtype = t.slice(idx + 1).trim();
    if (!category || !subtype) continue;
    pairs.push({ category, subtype });
  }
  return pairs;
}

/** Parses `DatasetLinkRow.sensitiveSubtypes` (via `parseSensitiveSubtypes`,
 *  same source as `sensitiveCats`) and counts DEPOSIT INSTANCES (row count,
 *  same grain as `links`, NOT distinct datasets or distinct pubs — same
 *  reasoning as `countConcerningDeposits`'s comment) per sub-type label,
 *  grouped by coarse category. A row listing more than one sub-type (a
 *  dataset spanning genomic + geolocation, say) counts once toward EACH
 *  sub-type it lists — not reconciled away, same spirit as this file's other
 *  multi-bucket caveats. Sorted by category, then count descending within
 *  category. */
/** Deposit-instance count with at least one parseable `sensitiveSubtypes`
 *  token — the §5 rollup's own coverage stat (2026-08-16 review: "most
 *  Recent-activity rows show `—` for sub-types, section 5 should state its
 *  own coverage" so `bySubtype`'s counts read as a floor-of-a-floor, not a
 *  census). Same `links`/`overall.links` grain (deposit instances, not
 *  distinct datasets), so it's directly comparable to `overall.links` as
 *  "N/links have any sub-type classification at all". */
export function countSubtypeClassifiedInstances(rows: readonly DatasetLinkRow[]): number {
  let count = 0;
  for (const r of rows) {
    if (parseSensitiveSubtypes(r.sensitiveSubtypes).length > 0) count++;
  }
  return count;
}

export function aggregateBySubtype(rows: readonly DatasetLinkRow[]): SubtypeRow[] {
  const counts = new Map<string, SubtypeRow>(); // keyed "category subtype"
  for (const r of rows) {
    for (const { category, subtype } of parseSensitiveSubtypes(r.sensitiveSubtypes)) {
      const key = `${category} ${subtype}`;
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { category, subtype, count: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || b.count - a.count,
  );
}

/** Upper bound on rows in the "Recent activity" table — a UI list, not an
 *  export; if this ever needs to show more, that's pagination, not a
 *  constant bump. */
export const RECENT_ITEMS_LIMIT = 25;

/** The `limit` most recently deposited items, item-level — one row per
 *  (person, dataset) link, same grain as the CSV export (not distinct
 *  datasets: a dataset with 3 depositing/citing faculty can appear 3 times).
 *
 *  "Recent" means `depositYear` (repo metadata, or pub year as a fallback)
 *  — the ONLY per-item recency signal this data model carries.
 *  `lastRefreshedAt` on `DatasetDeposit`/`PersonDatasetDeposit` is NOT a
 *  substitute: every row gets the SAME whole-table sync timestamp on each
 *  full-replace ETL run (see `DataSharingReport.dataAsOf`'s doc comment), so
 *  it can't tell a deposit newly discovered this run from one that's been in
 *  the table for months — there is no "date SPS first saw this" field today.
 *  A row with no `depositYear` sorts last (unknown recency, not assumed
 *  recent). Deterministic tiebreak within a year (`depositYear` is
 *  year-granularity, so ties are real, not incidental): `datasetId`, stable
 *  but not itself meaningful — just enough to keep re-renders from
 *  reshuffling equally-recent rows. */
export function mostRecentDeposits(
  rows: readonly DatasetLinkRow[],
  limit: number = RECENT_ITEMS_LIMIT,
): DatasetLinkRow[] {
  return [...rows]
    .sort(
      (a, b) =>
        (b.depositYear ?? -Infinity) - (a.depositYear ?? -Infinity) ||
        a.datasetId.localeCompare(b.datasetId),
    )
    .slice(0, limit);
}

export type YearlyDepositRow = { year: number | null; datasets: number };

/** Distinct-dataset count per `depositYear` — the §1 trend chart (2026-08-16
 *  ask: "leadership's first question after 'how much' is 'is it going up'").
 *  Same distinct-dataset grain as `overall.datasets`, not deposit instances —
 *  a dataset with three depositing faculty counts once toward its year, same
 *  reasoning as `aggregateByDepartment`. `year: null` (no `depositYear` on
 *  any link to that dataset) sorts LAST as its own "Unknown year" bucket,
 *  never silently dropped or folded into a real year. Ascending year order
 *  (oldest first) — a trend chart reads left-to-right as time moving
 *  forward, the opposite convention from every other table on this page
 *  (which sort by volume descending). */
export function aggregateByYear(rows: readonly DatasetLinkRow[]): YearlyDepositRow[] {
  const byYear = new Map<number | null, Set<string>>();
  for (const r of rows) {
    const year = r.depositYear ?? null;
    const set = byYear.get(year) ?? new Set<string>();
    set.add(r.datasetId);
    byYear.set(year, set);
  }
  const knownYears = [...byYear.keys()].filter((y): y is number => y !== null).sort((a, b) => a - b);
  const result: YearlyDepositRow[] = knownYears.map((year) => ({ year, datasets: byYear.get(year)!.size }));
  if (byYear.has(null)) result.push({ year: null, datasets: byYear.get(null)!.size });
  return result;
}

export type DepositYearBounds = { min: number; max: number } | null;

/** True min/max `depositYear` across `rows`, ignoring rows with no
 *  `depositYear`. This is the year filter's ghost text and native min-max
 *  clamp (2026-08-16 ask: "you can type a year below the earliest real
 *  deposit and get a silently-empty table"). `null` when nothing in `rows`
 *  carries a `depositYear` at all, same degrade-to-absent shape as
 *  `aggregateByYear`'s own null-year bucket.
 *
 *  `loadDataSharingReport` is the ONLY caller, and it always passes
 *  `rawRows` (the pre-filter set), never the currently-filtered rows. See
 *  `DataSharingReport.depositYearBounds`'s doc comment for why the bounds
 *  must stay fixed to the full corpus regardless of which filter is active.
 *  Kept here as a plain pure function over `DatasetLinkRow[]`, not baked into
 *  `buildDataSharingReport`, precisely so a future caller can't accidentally
 *  wire it to the filtered `rows` that function already closes over. */
export function computeDepositYearBounds(rows: readonly DatasetLinkRow[]): DepositYearBounds {
  let min: number | undefined;
  let max: number | undefined;
  for (const r of rows) {
    if (r.depositYear == null) continue;
    if (min === undefined || r.depositYear < min) min = r.depositYear;
    if (max === undefined || r.depositYear > max) max = r.depositYear;
  }
  return min !== undefined && max !== undefined ? { min, max } : null;
}

/** Deposit-INSTANCE (row) counts for the tier-only "concerning" flag — same
 *  grain as `links`/`NamedFacultyRow.concerningDeposits`, NOT distinct
 *  datasets or distinct pubs: a scholar with three link rows to the same
 *  CONCERN-tier dataset (e.g. three separate `pmids` cite it) counts 3, same
 *  reasoning as why `links` itself is a row count. Shared by
 *  `aggregateByFaculty` (per-faculty) and `buildDataSharingReport`
 *  (whole-corpus, via a single-bucket call) so the two can't drift.
 *
 *  Tier-only per the SPEC's "Amended 08-13" note — see this module's header
 *  and `@/lib/repository-tier`'s. Does NOT include the open-deposit-of-
 *  sensitive-category branch (needs raw MeSH per citing pub, cut this
 *  session). */
export function countConcerningDeposits(rows: readonly DatasetLinkRow[]): { concerningDeposits: number; foreignHostedDeposits: number } {
  let concerningDeposits = 0;
  let foreignHostedDeposits = 0;
  for (const r of rows) {
    const tier = tierOf(r.repository);
    if (!CONCERNING_TIERS.has(tier)) continue;
    concerningDeposits++;
    if (FOREIGN_HOSTED_TIERS.has(tier)) foreignHostedDeposits++;
  }
  return { concerningDeposits, foreignHostedDeposits };
}

/** Distinct-dataset / link counts per named individual — same shape as the
 *  department rollup, one row per depositing scholar. No lock, no redaction,
 *  no second flag (decided 2026-08-12 — see the SPEC's "Admin and CTSA
 *  reporting" section): this ships identically to the other two views, gated
 *  only by the one dashboard flag + ordinary Insights-tab authz. */
export function aggregateByFaculty(rows: readonly DatasetLinkRow[]): NamedFacultyRow[] {
  const byCwid = new Map<
    string,
    {
      name: string;
      slug: string;
      department: string | null;
      datasets: Set<string>;
      links: number;
      openDatasets: Set<string>;
      controlledDatasets: Set<string>;
      concerningDeposits: number;
      foreignHostedDeposits: number;
    }
  >();
  for (const r of rows) {
    const bucket = byCwid.get(r.cwid) ?? {
      name: r.scholarName,
      slug: r.scholarSlug,
      department: r.department,
      datasets: new Set<string>(),
      links: 0,
      openDatasets: new Set<string>(),
      controlledDatasets: new Set<string>(),
      concerningDeposits: 0,
      foreignHostedDeposits: 0,
    };
    bucket.datasets.add(r.datasetId);
    bucket.links++;
    const kind = bucketDatasetLink(r);
    // No registry bucket on this row shape (see `NamedFacultyRow`'s comment)
    // — a registry-kind link still counts toward `datasets`/`links` above,
    // it just doesn't land in either access column.
    if (kind === "open") bucket.openDatasets.add(r.datasetId);
    else if (kind === "controlled") bucket.controlledDatasets.add(r.datasetId);
    const tier = tierOf(r.repository);
    if (CONCERNING_TIERS.has(tier)) {
      bucket.concerningDeposits++;
      if (FOREIGN_HOSTED_TIERS.has(tier)) bucket.foreignHostedDeposits++;
    }
    byCwid.set(r.cwid, bucket);
  }
  return [...byCwid.entries()]
    .map(([cwid, b]) => ({
      cwid,
      name: b.name,
      slug: b.slug,
      department: b.department,
      datasets: b.datasets.size,
      links: b.links,
      openDatasets: b.openDatasets.size,
      controlledDatasets: b.controlledDatasets.size,
      concerningDeposits: b.concerningDeposits,
      foreignHostedDeposits: b.foreignHostedDeposits,
    }))
    .sort((a, b) => b.datasets - a.datasets);
}

/** Flatten every NON-REGISTRY link row's `pmids` into one deduped set —
 *  "this publication has at least one detected dataset deposit". Two
 *  deliberate rules, one inclusion and one exclusion:
 *  (1) NOT filtered by author position or by which cwid the link belongs to:
 *  a publication has a detected deposit if ANY row cites it, regardless of
 *  who's individually credited on the `PersonDatasetDeposit` row. This
 *  matters — a pub can be first-authored by Faculty A but have its deposit
 *  attributed to Faculty B, a middle author on the same pub; filtering by
 *  position/cwid here would wrongly mark Faculty A's paper as having no
 *  deposit.
 *  (2) Registry-type rows (`bucketDatasetLink` === `'registry'`) are skipped
 *  entirely: a ClinicalTrials.gov registration is not a dataset deposit
 *  (`REGISTRY_DATA_TYPE`'s doc comment), so a pub whose ONLY detected signal
 *  is a registration must not count toward the share-rate numerator or
 *  `pmcDepositedPubs` — before this filter (2026-08-16 v3 review finding),
 *  registration-only pubs inflated both, while the methods prose claimed the
 *  opposite. A pmid carried by both a registry row and a real deposit row
 *  still counts, via the real row. */
export function depositedPmidSet(rows: readonly DatasetLinkRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.pmids || r.pmids.length === 0) continue;
    if (bucketDatasetLink(r) === "registry") continue;
    for (const pmid of r.pmids) set.add(pmid);
  }
  return set;
}

/** Flatten `pmids` into an open set and a controlled set — mirrors
 *  `depositedPmidSet`'s shape, but split by `bucketDatasetLink` instead of
 *  merged into one set, and with registry-type rows excluded entirely (not
 *  just uncounted like a null `accessModel` — a registry row never
 *  contributes to either set, full stop). A pmid can land in BOTH sets: two
 *  different deposits of the same publication with different access models
 *  is real, not a bug — same spirit as this file's multi-department caveat,
 *  don't reconcile it away. A pmid whose only non-registry deposits have a
 *  null `accessModel` lands in neither set (the real ambiguous/unknown case,
 *  same semantics as the Synapse fix `bucketDatasetLink` documents). */
export function pubAccessPmidSets(rows: readonly DatasetLinkRow[]): {
  openPmids: Set<string>;
  controlledPmids: Set<string>;
} {
  const openPmids = new Set<string>();
  const controlledPmids = new Set<string>();
  for (const r of rows) {
    if (!r.pmids || r.pmids.length === 0) continue;
    const kind = bucketDatasetLink(r);
    if (kind === "open") for (const pmid of r.pmids) openPmids.add(pmid);
    else if (kind === "controlled") for (const pmid of r.pmids) controlledPmids.add(pmid);
  }
  return { openPmids, controlledPmids };
}

/** Every pmid that appears on at least one registry-type row (`bucketDatasetLink`
 *  === `'registry'`) — used only to carve the funding-lens population down to
 *  real data-sharing pmids (`loadFundingSplit`'s `where.pmid`). Registry-ONLY
 *  pmids never reach that population anyway now that `depositedPmidSet` skips
 *  registry rows; what this carve still does is exclude a pmid with BOTH a
 *  registry row and a non-registry row: the funding lens asks "of
 *  publications with a real (non-registry) data deposit, how many are
 *  NIH-funded", and it stays simpler and more conservative to drop a
 *  both-rows pmid entirely than to partially credit it. */
function registryPmidSet(rows: readonly DatasetLinkRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.pmids || r.pmids.length === 0) continue;
    if (bucketDatasetLink(r) === "registry") for (const pmid of r.pmids) set.add(pmid);
  }
  return set;
}

export type ShareRateTotals = { denominatorPubs: number; numeratorPubs: number };

export type ShareRates = {
  overall: ShareRateTotals;
  byDepartment: Map<string, ShareRateTotals>;
  byFaculty: Map<string, ShareRateTotals>;
};

/** Denominator (confirmed first/last-authored WCM pubs since
 *  `SHARE_RATE_YEAR_FLOOR`) vs. numerator (how many of those have a detected
 *  deposit) — overall, by department, and by faculty. `overall` dedups
 *  `corpusRows` to distinct pmids first (a pub can have both a first- and a
 *  last-author WCM row, e.g. two WCM co-authors), so it doesn't double-count.
 *  `byDepartment` groups under the same "Unknown / no department on file"
 *  fallback `aggregateByDepartment` uses, and inherits the same
 *  multi-department shape: a pub with WCM first/last authors in two
 *  departments counts in both — don't expect department totals to sum to
 *  `overall`. */
export function buildShareRates(
  corpusRows: readonly ShareRateCorpusRow[],
  depositedPmids: ReadonlySet<string>,
): ShareRates {
  const distinctPmids = new Set(corpusRows.map((r) => r.pmid));
  const totalsFor = (pmids: ReadonlySet<string>): ShareRateTotals => {
    let numeratorPubs = 0;
    for (const pmid of pmids) {
      if (depositedPmids.has(pmid)) numeratorPubs++;
    }
    return { denominatorPubs: pmids.size, numeratorPubs };
  };

  const deptPmids = new Map<string, Set<string>>();
  const facultyPmids = new Map<string, Set<string>>();
  for (const r of corpusRows) {
    const dept = r.department ?? UNKNOWN_DEPARTMENT_LABEL;
    const deptSet = deptPmids.get(dept) ?? new Set<string>();
    deptSet.add(r.pmid);
    deptPmids.set(dept, deptSet);

    const facultySet = facultyPmids.get(r.cwid) ?? new Set<string>();
    facultySet.add(r.pmid);
    facultyPmids.set(r.cwid, facultySet);
  }

  return {
    overall: totalsFor(distinctPmids),
    byDepartment: new Map([...deptPmids.entries()].map(([dept, pmids]) => [dept, totalsFor(pmids)])),
    byFaculty: new Map([...facultyPmids.entries()].map(([cwid, pmids]) => [cwid, totalsFor(pmids)])),
  };
}

export type PmcCoverageTotals = { pmcCoveredPubs: number; pmcDepositedPubs: number };

/** PMC coverage over the share-rate corpus — distinct corpus pmids with PMC
 *  full text (`inPmc`, i.e. `Publication.pmcid` non-null), and how many of
 *  those are in the deposited-pmid set. WHY: the full-text availability-
 *  statement arm of the deposit scan can only see pubs whose full text is in
 *  PMC (the DataBankList arm covers every PubMed record, full text or not),
 *  so full-text-derived detection is bounded by PMC coverage — the
 *  PMC-covered subset is the fairest denominator for full-text-detected
 *  deposits, and "% of corpus pubs in PMC" is itself a compliance figure
 *  stakeholders asked for (see `overall.pmcCoveredPubs`'s doc comment).
 *  Distinct-pmid grain, same dedup rule as `buildShareRates.overall`: a pub
 *  with both a first- and a last-author corpus row counts once. A pmid whose
 *  rows disagree on `inPmc` can't really happen (`pmcid` is a fact about the
 *  publication, not the author row) — OR'd defensively anyway rather than
 *  trusting row order. */
export function pmcCoverage(
  corpusRows: readonly ShareRateCorpusRow[],
  depositedPmids: ReadonlySet<string>,
): PmcCoverageTotals {
  const pmcPmids = new Set<string>();
  for (const r of corpusRows) {
    if (r.inPmc) pmcPmids.add(r.pmid);
  }
  let pmcDepositedPubs = 0;
  for (const pmid of pmcPmids) {
    if (depositedPmids.has(pmid)) pmcDepositedPubs++;
  }
  return { pmcCoveredPubs: pmcPmids.size, pmcDepositedPubs };
}

export type FundingSplitTotals = {
  nihFundedPubs: number;
  notNihFundedPubs: number;
  /** Per-pmid NIH-funded boolean, over the same `fundingPmids` population as
   *  the two totals above — added 2026-08-16 for `buildAccessFundingCrossTab`
   *  (the access-model × NIH-funding cross-tab), so that function doesn't
   *  need its own grant query. Optional, same backward-compat shape as this
   *  type's other callers/fixtures: an omitted map degrades to "nobody is
   *  NIH-funded" for the cross-tab rather than throwing. */
  nihByPmid?: Map<string, boolean>;
};

/** NIH-funded vs. not-NIH-funded split over the real (non-registry) data-
 *  sharing pmid population — `depositedPmidSet(rows)` (which already skips
 *  registry rows) minus every pmid that ALSO appears on a registry-type row
 *  (`registryPmidSet`): the subtraction now only removes both-registry-and-
 *  real pmids, the deliberately conservative carve that function's doc
 *  comment defends. A pmid counts as
 *  NIH-funded if ANY of its `GrantPublication` rows resolves to a grant with
 *  a non-null `nihIc` — `nihIc` is populated only for NIH awards (see
 *  `Grant.nihIc`'s doc comment in `prisma/schema.prisma`), so "not
 *  NIH-funded" is the honest claim here, not "non-federal": other federal
 *  funders (CDC/NSF/etc.) aren't distinguishable from truly non-federal with
 *  this field. */
export async function loadFundingSplit(
  client: DataSharingReportClient,
  rows: readonly DatasetLinkRow[],
): Promise<FundingSplitTotals> {
  const registryPmids = registryPmidSet(rows);
  const fundingPmids = [...depositedPmidSet(rows)].filter((pmid) => !registryPmids.has(pmid));
  if (fundingPmids.length === 0) return { nihFundedPubs: 0, notNihFundedPubs: 0 };

  const links = await client.grantPublication.findMany({
    where: { pmid: { in: fundingPmids } },
    select: { pmid: true, grant: { select: { nihIc: true } } },
  });

  const nihByPmid = new Map<string, boolean>();
  for (const pmid of fundingPmids) nihByPmid.set(pmid, false); // every fundingPmid gets an explicit entry
  for (const l of links) {
    const alreadyNih = nihByPmid.get(l.pmid) ?? false;
    nihByPmid.set(l.pmid, alreadyNih || l.grant.nihIc !== null);
  }

  let nihFundedPubs = 0;
  for (const pmid of fundingPmids) {
    if (nihByPmid.get(pmid)) nihFundedPubs++;
  }
  return { nihFundedPubs, notNihFundedPubs: fundingPmids.length - nihFundedPubs, nihByPmid };
}

export type AccessFundingCrossTab = {
  openNih: number;
  openNotNih: number;
  controlledNih: number;
  controlledNotNih: number;
};

/** Access-model (open/controlled) × NIH-funding cross-tab over the shared
 *  non-registry deposited-pmid population both lenses already share
 *  (2026-08-16 ask: "the methods go out of their way to guarantee the two
 *  lenses share a denominator, then the page never actually crosses them").
 *  `openPmids`/`controlledPmids` come from `pubAccessPmidSets` (registry
 *  already excluded); `nihByPmid` from `loadFundingSplit`. A pmid absent from
 *  `nihByPmid` (funding split never saw it, e.g. it has neither set truthy)
 *  reads as not-NIH-funded, same degrade-to-false as `loadFundingSplit`
 *  itself. A pmid in BOTH `openPmids` and `controlledPmids` (two deposits,
 *  different access models) counts in both rows — same don't-reconcile-away
 *  spirit as `pubAccessPmidSets`'s own doc comment. */
export function buildAccessFundingCrossTab(
  openPmids: ReadonlySet<string>,
  controlledPmids: ReadonlySet<string>,
  nihByPmid: ReadonlyMap<string, boolean>,
): AccessFundingCrossTab {
  let openNih = 0;
  let openNotNih = 0;
  let controlledNih = 0;
  let controlledNotNih = 0;
  for (const pmid of openPmids) {
    if (nihByPmid.get(pmid)) openNih++;
    else openNotNih++;
  }
  for (const pmid of controlledPmids) {
    if (nihByPmid.get(pmid)) controlledNih++;
    else controlledNotNih++;
  }
  return { openNih, openNotNih, controlledNih, controlledNotNih };
}

/** `corpusRows` defaults to `[]` for backward compatibility — existing
 *  single-argument callers (and every pre-share-rate test fixture) keep
 *  working unchanged, just with rate fields at 0/0. When a `byDepartment` or
 *  `byFaculty` row exists on the deposit side (from `rows`) but has no
 *  matching corpus entry — an edge case, e.g. a depositing scholar with zero
 *  confirmed first/last pubs since the year floor — its rate fields default
 *  to `{ 0, 0 }`, not `undefined`: keeps every row's shape uniform for the
 *  UI's `n/N (x%)` formatter without an extra undefined-check. The exported
 *  types keep these fields optional only so pre-existing test fixtures that
 *  predate share rate don't need touching.
 *
 *  `fundingSplit` defaults to `{ nihFundedPubs: 0, notNihFundedPubs: 0 }` for
 *  the same backward-compat reason `corpusRows` defaults to `[]` — it can
 *  only be computed with a DB round-trip (`loadFundingSplit`), so this pure
 *  function accepts it pre-computed rather than becoming async itself.
 *
 *  `depositedPmidRows` (2026-08-16 adversarial-review fix, filters feature):
 *  the population `depositedPmidSet` reads to build the share-rate numerator
 *  and PMC-deposited count — defaults to `rows` when omitted, so every
 *  existing caller/test is unaffected. `loadDataSharingReport` passes the
 *  UNFILTERED rows here even when a year/tier filter narrows `rows` for the
 *  deposit-side aggregates (byDepartment/byRepository/byFaculty/tiers):
 *  `corpusRows` (the share-rate DENOMINATOR) is never filtered — see
 *  `DataSharingReportFilters`'s doc comment — so pairing a FILTERED numerator
 *  against that unfiltered denominator silently deflated every share-rate/
 *  PMC-coverage percentage whenever a filter was active (a stakeholder
 *  narrowing the tier filter to CONCERN would see the share rate collapse
 *  toward 0%, not because sharing dropped, but because the numerator no
 *  longer had a matching-scope denominator). Access-model/funding figures
 *  are NOT affected — `pubAccessPmidSets`/`loadFundingSplit` compute both
 *  their own numerator AND denominator from `rows`, so a filter narrows both
 *  sides together and stays internally consistent. */
export function buildDataSharingReport(
  rows: readonly DatasetLinkRow[],
  corpusRows: readonly ShareRateCorpusRow[] = [],
  fundingSplit: FundingSplitTotals = { nihFundedPubs: 0, notNihFundedPubs: 0 },
  depositedPmidRows: readonly DatasetLinkRow[] = rows,
): Omit<DataSharingReport, "dataAsOf" | "depositYearBounds"> {
  const deposited = depositedPmidSet(depositedPmidRows);
  const rates = buildShareRates(corpusRows, deposited);
  // PMC coverage inherits `corpusRows`'s backward-compat default: with no
  // corpus supplied (or pre-PMC fixtures whose rows lack `inPmc`), both
  // fields are 0 — same degrade-to-zero shape as the share-rate fields.
  const pmc = pmcCoverage(corpusRows, deposited);
  const { openPmids, controlledPmids } = pubAccessPmidSets(rows);

  // Departments: UNION deposit-side departments with corpus-side ones, not just
  // deposit-side. A department with real denominator data (confirmed first/last
  // pubs since the year floor) but zero deposits must still appear as a
  // "0/N (0%)" row, not vanish — for a metric whose CTSA purpose is spotting
  // low/zero-sharing units, silently omitting the worst performers defeats the
  // point (found by adversarial review, not in the original spec). Bounded to
  // ~26 real departments, so this can't blow up into an unbounded table.
  const depositDeptByName = new Map(aggregateByDepartment(rows).map((d) => [d.department, d]));
  const allDeptNames = new Set([...depositDeptByName.keys(), ...rates.byDepartment.keys()]);
  const byDepartment = [...allDeptNames]
    .map((department) => {
      const d = depositDeptByName.get(department);
      const rate = rates.byDepartment.get(department);
      return {
        department,
        datasets: d?.datasets ?? 0,
        faculty: d?.faculty ?? 0,
        links: d?.links ?? 0,
        openDatasets: d?.openDatasets ?? 0,
        controlledDatasets: d?.controlledDatasets ?? 0,
        registryDatasets: d?.registryDatasets ?? 0,
        shareRateDenominator: rate?.denominatorPubs ?? 0,
        shareRateNumerator: rate?.numeratorPubs ?? 0,
      };
    })
    .sort((a, b) => b.datasets - a.datasets);

  // Named faculty: deliberately NOT unioned with the corpus the way departments
  // are — the corpus-side denominator can include thousands of confirmed
  // first/last-authored WCM scholars with zero deposits (unlike the ~26-row
  // department universe), and `ShareRateCorpusRow` doesn't carry the
  // name/slug a table row needs to render anyway (that comes from the
  // deposit-side `scholar` join, which non-depositors never appear in). This
  // table stays scoped to depositing faculty, same as v1 — the Rollup and
  // Departments sections are where the full-corpus picture lives.
  const byFaculty = aggregateByFaculty(rows).map((f) => {
    const rate = rates.byFaculty.get(f.cwid);
    return {
      ...f,
      shareRateDenominator: rate?.denominatorPubs ?? 0,
      shareRateNumerator: rate?.numeratorPubs ?? 0,
    };
  });

  const byRepository = aggregateByRepository(rows);

  return {
    overall: {
      datasets: new Set(rows.map((r) => r.datasetId)).size,
      faculty: new Set(rows.map((r) => r.cwid)).size,
      links: rows.length,
      shareRateDenominator: rates.overall.denominatorPubs,
      shareRateNumerator: rates.overall.numeratorPubs,
      pmcCoveredPubs: pmc.pmcCoveredPubs,
      pmcDepositedPubs: pmc.pmcDepositedPubs,
      openPubs: openPmids.size,
      controlledPubs: controlledPmids.size,
      nihFundedPubs: fundingSplit.nihFundedPubs,
      notNihFundedPubs: fundingSplit.notNihFundedPubs,
      concerningDepositInstances: countConcerningDeposits(rows).concerningDeposits,
      subtypeClassifiedInstances: countSubtypeClassifiedInstances(rows),
    },
    byDepartment,
    byRepository,
    byRepositoryTier: aggregateRepositoriesByTier(byRepository),
    pubsByTier: tierPubSpectrum(rows),
    byYear: aggregateByYear(rows),
    byFaculty,
    bySubtype: aggregateBySubtype(rows),
    accessFundingCrossTab: buildAccessFundingCrossTab(openPmids, controlledPmids, fundingSplit.nihByPmid ?? new Map()),
    recentItems: mostRecentDeposits(rows),
  };
}

/** MAX(lastRefreshedAt) across `DatasetDeposit` — see `DataSharingReport
 *  .dataAsOf`'s doc comment for what this timestamp means. */
async function loadDataAsOf(client: DataSharingReportClient): Promise<Date | null> {
  const agg = await client.datasetDeposit.aggregate({ _max: { lastRefreshedAt: true } });
  return agg._max.lastRefreshedAt ?? null;
}

/** 2026-08-16 filters ask ("year range, NIH-funded, tier"). All three now
 *  shipped: deposit-year range and tier landed first; `nihFunded` (this PR,
 *  GitHub #2469) needed its own pass because a pmid's NIH-funded status only
 *  resolves via `loadFundingSplit`'s async grant join, so it can't fold into
 *  this type's own synchronous filter the way year/tier do. See
 *  `loadDataSharingReport`'s doc comment for the actual two-pass sequencing
 *  (year/tier first, then `applyNihFilter` once the join resolves) and
 *  `deriveFundingTotals` for why the funding totals reported alongside a
 *  filtered report are recomputed rather than reused from `loadFundingSplit`
 *  as-is. */
export type DataSharingReportFilters = {
  /** Inclusive deposit-year bounds, the §1 trend chart's own axis — applies
   *  to the deposit-side rows only (datasets/repositories/faculty/tiers/
   *  subtypes/recent/funding), NOT the share-rate corpus (which has no
   *  `depositYear`; it's scoped by publication year, a different axis — see
   *  `SHARE_RATE_YEAR_FLOOR`). A row with no `depositYear` is excluded once
   *  either bound is set — there's no way to answer "was this in range" for
   *  an unknown year, so it doesn't default to included. */
  yearFrom?: number;
  yearTo?: number;
  /** Tier codes (`@/lib/repository-tier`'s values) to include; omitted or
   *  empty = every tier. */
  tiers?: readonly string[];
  /** `true` = NIH-funded publications only, `false` = not-NIH-funded only,
   *  `undefined` = no filter (the same tri-state shape the on-page control
   *  offers). Applied by `applyNihFilter`, a second pass after
   *  `applyReportFilters`'s year/tier pass: a row passes if ANY of its
   *  `pmids` matches the requested state, the same "any citing row counts"
   *  rule `depositedPmidSet`/`registryPmidSet` already use elsewhere in this
   *  file for multi-pmid rows. A pmid with no entry in the NIH-funded map
   *  (`loadFundingSplit`'s `nihByPmid`) reads as not-NIH-funded, the same
   *  degrade-to-false convention that function's own doc comment uses. */
  nihFunded?: boolean;
};

export function applyReportFilters(
  rows: readonly DatasetLinkRow[],
  filters: DataSharingReportFilters | undefined,
): DatasetLinkRow[] {
  if (!filters) return [...rows];
  const hasYearBound = filters.yearFrom !== undefined || filters.yearTo !== undefined;
  return rows.filter((r) => {
    if (hasYearBound) {
      if (r.depositYear == null) return false;
      if (filters.yearFrom !== undefined && r.depositYear < filters.yearFrom) return false;
      if (filters.yearTo !== undefined && r.depositYear > filters.yearTo) return false;
    }
    if (filters.tiers && filters.tiers.length > 0 && !filters.tiers.includes(tierOf(r.repository))) return false;
    return true;
  });
}

/** The `filters.nihFunded` pass, kept separate from `applyReportFilters`
 *  (see `DataSharingReportFilters.nihFunded`'s doc comment for why it can't
 *  be folded in) so `loadDataSharingReport` can run it only after
 *  `loadFundingSplit`'s async grant join has resolved `nihByPmid`. A row
 *  passes if ANY of its `pmids` matches the requested `nihFunded` state; a
 *  pmid absent from `nihByPmid` reads as not-NIH-funded, same degrade-to-
 *  false convention `loadFundingSplit` documents. */
export function applyNihFilter(
  rows: readonly DatasetLinkRow[],
  nihFunded: boolean,
  nihByPmid: ReadonlyMap<string, boolean> | undefined,
): DatasetLinkRow[] {
  return rows.filter((r) => (r.pmids ?? []).some((pmid) => (nihByPmid?.get(pmid) ?? false) === nihFunded));
}

/** Recomputes the NIH-funded/not-NIH-funded totals actually reported on
 *  `overall`, from the FINAL, fully-filtered deposited-pmid population
 *  (`depositedPmidSet` over `loadDataSharingReport`'s step-6 `rows`), NOT
 *  from `loadFundingSplit`'s own totals, which describe the full unfiltered
 *  corpus (see `loadDataSharingReport`'s doc comment for why `nihByPmid`
 *  itself must be built unfiltered). Reporting `loadFundingSplit`'s totals
 *  as-is once any filter is active would silently stop reflecting that
 *  filter, a real regression versus pre-nihFunded-filter behavior, where a
 *  year filter DID correctly narrow the funding totals (the split used to
 *  run on the already-filtered rows). A pmid in `depositedPmids` counts
 *  toward `nihFundedPubs` if `nihByPmid.get(pmid)` is true, else
 *  `notNihFundedPubs`, same degrade-to-false rule as `applyNihFilter`. */
export function deriveFundingTotals(
  depositedPmids: ReadonlySet<string>,
  nihByPmid: ReadonlyMap<string, boolean> | undefined,
): Pick<FundingSplitTotals, "nihFundedPubs" | "notNihFundedPubs"> {
  let nihFundedPubs = 0;
  let notNihFundedPubs = 0;
  for (const pmid of depositedPmids) {
    if (nihByPmid?.get(pmid)) nihFundedPubs++;
    else notNihFundedPubs++;
  }
  return { nihFundedPubs, notNihFundedPubs };
}

export async function loadDataSharingReport(
  client: DataSharingReportClient,
  filters?: DataSharingReportFilters,
): Promise<DataSharingReport> {
  const [rawRows, corpusRows, dataAsOf] = await Promise.all([
    loadDatasetLinkRows(client),
    loadShareRateCorpus(client),
    loadDataAsOf(client),
  ]);
  const yearTierRows = applyReportFilters(rawRows, filters);
  // Always `rawRows`, the FULL unfiltered non-registry population: must
  // reflect the FULL unfiltered corpus regardless of the currently-active
  // filter, same rule `depositYearBounds`'s doc comment already states for
  // the year-bounds ghost text. `nihByPmid` needs complete pmid coverage so
  // `applyNihFilter` below can classify every row, whether or not a year/
  // tier filter is also active; pairing it against an already-filtered
  // population would silently degrade rows outside that filter to "not
  // NIH-funded" instead of correctly resolving them.
  const fundingSplit = await loadFundingSplit(client, rawRows);
  const rows =
    filters?.nihFunded === undefined
      ? yearTierRows
      : applyNihFilter(yearTierRows, filters.nihFunded, fundingSplit.nihByPmid);
  // `fundingSplit.nihFundedPubs`/`notNihFundedPubs` (computed above) describe
  // the full unfiltered corpus, not `rows`; see `deriveFundingTotals`'s doc
  // comment for why reporting them as-is would be wrong the moment any
  // filter is active. Recompute the two counts actually reported from the
  // FINAL, fully-filtered `rows`, leaving `nihByPmid` itself untouched:
  // `buildAccessFundingCrossTab` still needs the full map.
  const reportedFundingSplit: FundingSplitTotals = {
    ...deriveFundingTotals(depositedPmidSet(rows), fundingSplit.nihByPmid),
    nihByPmid: fundingSplit.nihByPmid,
  };
  // `rawRows` (not `rows`) backs the share-rate/PMC numerator — see
  // `buildDataSharingReport`'s `depositedPmidRows` doc comment for why a
  // filtered numerator paired against the always-unfiltered corpus
  // denominator silently deflated every share-rate percentage.
  // `depositYearBounds` reads `rawRows`, not `rows`, for the same reason;
  // see that field's doc comment on `DataSharingReport`.
  return {
    ...buildDataSharingReport(rows, corpusRows, reportedFundingSplit, rawRows),
    dataAsOf,
    depositYearBounds: computeDepositYearBounds(rawRows),
  };
}

// ---------------------------------------------------------------------------
// CSV export (`/edit/data-sharing/export`) — item-level, one row per
// suppression-filtered (person, dataset) link. Deliberately reuses
// `loadDatasetLinkRows` rather than a second "export loader": that function
// already returns the FULL suppression-filtered set with no pagination, which
// is exactly what an unpaginated export needs — a second query would just
// duplicate this one. Unlike `/edit/data-quality`, this dashboard has no
// query-param filters or unit scoping to thread through (global-only, see
// `lib/edit/data-sharing-dashboard.ts`), so the export has none either.
// ---------------------------------------------------------------------------

/** Upper bound on rows in one CSV export — mirrors `DATA_QUALITY_EXPORT_CAP`'s
 *  value and rationale: real volume today is ~1,445 links, so this is a safety
 *  net against runaway growth, not a real limit yet. */
export const DATA_SHARING_EXPORT_CAP = 5000;

export type DataSharingExport = {
  /** The rows kept after capping (input order preserved). */
  rows: DatasetLinkRow[];
  /** Total rows before the cap. */
  total: number;
  /** True when `total` exceeded the cap and `rows` was truncated. */
  truncated: boolean;
};

/** Slice any export row set to `DATA_SHARING_EXPORT_CAP` — generic because
 *  the item-grain section exports (`buildSectionItemsCsv`) cap EXPLODED rows
 *  (one per (link row, sub-type) pair), which aren't `DatasetLinkRow`s. */
function capExportRows<T>(rows: readonly T[]): { rows: T[]; total: number; truncated: boolean } {
  const total = rows.length;
  return {
    rows: rows.slice(0, DATA_SHARING_EXPORT_CAP),
    total,
    truncated: total > DATA_SHARING_EXPORT_CAP,
  };
}

/** Slice a (person, dataset) link row set to `DATA_SHARING_EXPORT_CAP` — a
 *  pure helper (same shape as data-quality's `DataQualityExport`) so tests can
 *  exercise the truncation branch directly, without 5,001 fake DB rows
 *  end-to-end. */
export function capDatasetLinkRows(rows: readonly DatasetLinkRow[]): DataSharingExport {
  return capExportRows(rows);
}

const DATA_SHARING_CSV_HEADERS = [
  "repository",
  "accession_or_doi",
  "dataset_url",
  "title",
  "resource_type",
  "data_type",
  "sensitive_cats",
  "sensitive_subtypes",
  "access_model",
  "deposit_year",
  "provenance",
  "confidence",
  "department",
  "faculty_name",
  "cwid",
  "pmids",
] as const;

/** One link row's cells, in `DATA_SHARING_CSV_HEADERS` order — the single
 *  serializer both `buildDataSharingCsv` and `buildSectionItemsCsv` share, so
 *  the two item-grain exports can't drift column-wise. `dataset_url` is the
 *  same per-accession deep link the public profile "Datasets" section renders
 *  (`resolveDatasetUrl` — DOI → doi.org, else the repository's accession
 *  resolver), not the repository homepage; empty when the accession is
 *  missing or no resolver matches. */
function datasetLinkCsvCells(r: DatasetLinkRow): CsvCell[] {
  return [
    r.repository,
    r.accessionOrDoi ?? "",
    r.accessionOrDoi
      ? resolveDatasetUrl({ repository: r.repository, accessionOrDoi: r.accessionOrDoi }) ?? ""
      : "",
    r.title ?? "",
    r.resourceType ?? "",
    r.dataType ?? "",
    r.sensitiveCats ?? "",
    r.sensitiveSubtypes ?? "",
    r.accessModel ?? "",
    r.depositYear ?? "",
    r.provenance ?? "",
    r.confidence ?? "",
    r.department ?? "",
    r.scholarName,
    r.cwid,
    r.pmids?.join("; ") ?? "",
  ];
}

/** Serialize item-level (person, dataset) link rows to a CSV string — one row
 *  per link (this loader's own grain), not one row per distinct dataset. No
 *  email/PII field: neither `DatasetDeposit` nor `PersonDatasetDeposit` carries
 *  one — `faculty_name` + `cwid` are the only person-identifying columns, same
 *  as the on-page "Named faculty" table. */
export function buildDataSharingCsv(rows: readonly DatasetLinkRow[]): string {
  return toCsv(DATA_SHARING_CSV_HEADERS, rows.map(datasetLinkCsvCells));
}

/** Per-table CSV sections for `/edit/data-sharing/export?section=…` — one
 *  entry per on-page aggregate table (the item-level export above stays the
 *  no-param default). `recentItems` has no section on purpose: it's a slice
 *  of the item-level grain the default export already covers in full. */
export const CSV_SECTIONS = ["tiers", "repositories", "departments", "faculty", "subtypes"] as const;
export type CsvSection = (typeof CSV_SECTIONS)[number];

/** Serialize one aggregate table of an already-built report. Columns mirror
 *  the on-page table (share rates exported as numerator/denominator pairs —
 *  the page's own "never a bare percentage" rule applies to exports too). */
export function buildSectionCsv(
  report: Omit<DataSharingReport, "dataAsOf">,
  section: CsvSection,
): string {
  switch (section) {
    case "tiers":
      return toCsv(
        ["tier", "datasets", "repositories"],
        report.byRepositoryTier.map((t) => [t.tier, t.datasets, t.repositories.join("; ")]),
      );
    case "repositories":
      return toCsv(
        ["repository", "tier", "access_model", "datasets"],
        report.byRepository.map((r) => [r.repository, r.tier, r.accessModel ?? "", r.datasets]),
      );
    case "departments":
      return toCsv(
        [
          "department",
          "datasets",
          "depositing_faculty",
          "open",
          "controlled",
          "registry",
          "share_rate_numerator",
          "share_rate_denominator",
        ],
        report.byDepartment.map((d) => [
          d.department,
          d.datasets,
          d.faculty,
          d.openDatasets,
          d.controlledDatasets,
          d.registryDatasets,
          d.shareRateNumerator ?? "",
          d.shareRateDenominator ?? "",
        ]),
      );
    case "faculty":
      return toCsv(
        [
          "faculty_name",
          "cwid",
          "department",
          "datasets",
          "open",
          "controlled",
          "concerning",
          "foreign_hosted",
          "share_rate_numerator",
          "share_rate_denominator",
        ],
        report.byFaculty.map((f) => [
          f.name,
          f.cwid,
          f.department ?? "",
          f.datasets,
          f.openDatasets,
          f.controlledDatasets,
          f.concerningDeposits,
          f.foreignHostedDeposits,
          f.shareRateNumerator ?? "",
          f.shareRateDenominator ?? "",
        ]),
      );
    case "subtypes":
      return toCsv(
        ["category", "subtype", "deposit_instances"],
        report.bySubtype.map((s) => [s.category, s.subtype, s.count]),
      );
  }
}

/** ITEM-grain per-section export — `?section=<X>&grain=items`. One row per
 *  (person, dataset) link (the same grain as `buildDataSharingCsv`, whose
 *  columns and `datasetLinkCsvCells` serializer this reuses), scoped and
 *  ordered to match the on-page table the section names — the 2026-08-16
 *  stakeholder ask: every aggregate table should offer its underlying items,
 *  not just the rollup counts (`buildSectionCsv` above).
 *
 *  Organization per section (each is the FULL row set, re-sorted — the
 *  sections differ by ordering/explosion, not by filtering, because every
 *  link row belongs to some repository AND some department AND some scholar):
 *  - `"repositories"` — repository, then faculty name.
 *  - `"departments"`  — department (null sorts last, serialized as `""`),
 *    then faculty name.
 *  - `"faculty"`      — faculty name, then repository.
 *  - `"subtypes"`     — EXPLODED: one output row per (link row, parsed
 *    sub-type) pair, via the same `parseSensitiveSubtypes` the §5 rollup
 *    uses (malformed tokens skipped); rows with no parseable sub-type are
 *    omitted — this is the one section that filters, because a row with no
 *    sub-type has no place in a sub-type-grouped listing. Leading
 *    `category`/`subtype` columns, then the standard item columns. Sorted
 *    category, subtype, repository.
 *  - `"tiers"`        — `null`: no items grain on purpose; tier is a pure
 *    function of repository, so the `"repositories"` grain already IS the
 *    tier drill-down, and a second byte-different ordering of the same rows
 *    would just invite "which file is canonical" confusion.
 *
 *  `DATA_SHARING_EXPORT_CAP` applies to the OUTPUT rows (after exploding,
 *  for `"subtypes"`) via the same `capExportRows` the default export's
 *  `capDatasetLinkRows` wraps — silently truncated at the cap, same safety-
 *  net-not-a-real-limit rationale as `DATA_SHARING_EXPORT_CAP`'s comment. */
/** One-row-per-table-row drill-down filter for `buildSectionItemsCsv`
 *  (2026-08-16 ask: "download items CSV 3b/3c/4/5 should have download links
 *  for each row," not just one items link per whole table). Each field
 *  matches the section it's meaningful for — `department` narrows
 *  `"departments"`, `cwid` narrows `"faculty"`, `repository` narrows
 *  `"repositories"`, `category`/`subtype` narrow `"subtypes"`.
 *
 *  NOT symmetric across fields (2026-08-16 adversarial-review correction —
 *  a prior version of this comment overclaimed): `department`/`cwid`/
 *  `repository` go through `matchesItemsFilter` and so ARE checked
 *  regardless of section (combining one of them with a different section is
 *  a sensible AND, e.g. `section=repositories&department=X`). `category`/
 *  `subtype` are NOT — they're applied only inside the `"subtypes"` case's
 *  explode loop below, because a "category" only exists once a row's
 *  `sensitiveSubtypes` has been parsed; passing them alongside a
 *  non-`"subtypes"` section is silently a no-op, not a 400 — the dashboard
 *  never builds that combination, but a hand-typed URL could. */
export type SectionItemsFilter = {
  department?: string;
  cwid?: string;
  repository?: string;
  category?: string;
  subtype?: string;
};

function matchesItemsFilter(row: DatasetLinkRow, filter: SectionItemsFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.department !== undefined) {
    // The dashboard's per-row "Items" link passes `DepartmentRollup
    // .department` (already the `UNKNOWN_DEPARTMENT_LABEL` fallback, never
    // raw `null`) — translate it back before comparing against a
    // `DatasetLinkRow.department` that's genuinely `null` for that bucket
    // (2026-08-16 adversarial-review finding: comparing the raw label
    // against `row.department ?? ""` never matched, silently emptying that
    // one department's export).
    const want = filter.department === UNKNOWN_DEPARTMENT_LABEL ? null : filter.department;
    if (row.department !== want) return false;
  }
  if (filter.cwid !== undefined && row.cwid !== filter.cwid) return false;
  if (filter.repository !== undefined && row.repository !== filter.repository) return false;
  return true;
}

export function buildSectionItemsCsv(
  rows: readonly DatasetLinkRow[],
  section: CsvSection,
  filter?: SectionItemsFilter,
): string | null {
  const byName = (a: DatasetLinkRow, b: DatasetLinkRow) => a.scholarName.localeCompare(b.scholarName);
  const filtered = rows.filter((r) => matchesItemsFilter(r, filter));
  switch (section) {
    case "tiers":
      return null;
    case "repositories": {
      const sorted = [...filtered].sort((a, b) => a.repository.localeCompare(b.repository) || byName(a, b));
      return toCsv(DATA_SHARING_CSV_HEADERS, capExportRows(sorted).rows.map(datasetLinkCsvCells));
    }
    case "departments": {
      const sorted = [...filtered].sort((a, b) => {
        // Null department sorts LAST (it serializes as "" — sorting by the
        // serialized value would put it first, hiding the no-department rows
        // above the fold instead of after every real department).
        if (a.department === null && b.department !== null) return 1;
        if (a.department !== null && b.department === null) return -1;
        return (a.department ?? "").localeCompare(b.department ?? "") || byName(a, b);
      });
      return toCsv(DATA_SHARING_CSV_HEADERS, capExportRows(sorted).rows.map(datasetLinkCsvCells));
    }
    case "faculty": {
      const sorted = [...filtered].sort((a, b) => byName(a, b) || a.repository.localeCompare(b.repository));
      return toCsv(DATA_SHARING_CSV_HEADERS, capExportRows(sorted).rows.map(datasetLinkCsvCells));
    }
    case "subtypes": {
      const exploded: { category: string; subtype: string; row: DatasetLinkRow }[] = [];
      for (const row of filtered) {
        for (const pair of parseSensitiveSubtypes(row.sensitiveSubtypes)) {
          if (filter?.category !== undefined && pair.category !== filter.category) continue;
          if (filter?.subtype !== undefined && pair.subtype !== filter.subtype) continue;
          exploded.push({ ...pair, row });
        }
      }
      exploded.sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          a.subtype.localeCompare(b.subtype) ||
          a.row.repository.localeCompare(b.row.repository),
      );
      return toCsv(
        ["category", "subtype", ...DATA_SHARING_CSV_HEADERS],
        capExportRows(exploded).rows.map((e) => [e.category, e.subtype, ...datasetLinkCsvCells(e.row)]),
      );
    }
  }
}
