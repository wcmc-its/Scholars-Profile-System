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
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadContributorSuppressions } from "@/lib/api/manual-layer";
import { toCsv } from "@/lib/csv";

/** The Prisma surface this loader needs — kept narrow for unit tests. */
export type DataSharingReportClient = Pick<
  PrismaClient,
  "personDatasetDeposit" | "suppression" | "publicationAuthor" | "grantPublication"
>;

/** Matches the Python extraction pipeline's own year>=2020 floor
 *  (scripts/bulk-data-rule/attribute.py's load_db()/load_ft()). The
 *  deposit-detection pipeline never scanned pubs before this year, so
 *  counting them in the denominator would manufacture "no detected deposit"
 *  for pubs that were simply never checked — not a scope choice, a
 *  coverage-window fix. */
export const SHARE_RATE_YEAR_FLOOR = 2020;

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
   *  `depositedPmidSet` (below) flattens it across every row to build the
   *  share-rate numerator. Same optional-not-nullable shape so the existing
   *  rollup-fixture rows in `tests/unit/data-sharing-report.test.ts` stay
   *  valid untouched. */
  pmids?: string[];
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
 *  pipeline could have scanned". */
export type ShareRateCorpusRow = { pmid: string; cwid: string; department: string | null };

export type DataSharingReport = {
  overall: {
    datasets: number;
    faculty: number;
    links: number;
    shareRateDenominator: number;
    shareRateNumerator: number;
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
  };
  byDepartment: DepartmentRollup[];
  byRepository: RepositoryBreakdown[];
  byFaculty: NamedFacultyRow[];
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
      department: l.scholar.primaryDepartment,
      datasetId: l.datasetId,
      repository: l.dataset.repository,
      accessModel: l.dataset.accessModel,
      title: l.dataset.title,
      accessionOrDoi: l.dataset.accessionOrDoi,
      resourceType: l.dataset.resourceType,
      dataType: l.dataset.dataType,
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

/** Read every confirmed first/last-authored WCM publication since
 *  `SHARE_RATE_YEAR_FLOOR` — the share-rate denominator corpus. `cwid` is
 *  guaranteed non-null by the `where` clause (`cwid: { not: null }`) even
 *  though Prisma's generated type keeps the column's nullable declaration;
 *  asserted once here rather than threading `string | null` through every
 *  downstream aggregate. */
export async function loadShareRateCorpus(client: DataSharingReportClient): Promise<ShareRateCorpusRow[]> {
  const rows = await client.publicationAuthor.findMany({
    where: {
      OR: [{ isFirst: true }, { isLast: true }],
      isConfirmed: true,
      cwid: { not: null },
      publication: { year: { gte: SHARE_RATE_YEAR_FLOOR } },
    },
    select: {
      pmid: true,
      cwid: true,
      scholar: { select: { primaryDepartment: true } },
    },
  });
  return rows.map((row) => ({
    pmid: row.pmid,
    cwid: row.cwid as string,
    department: row.scholar?.primaryDepartment ?? null,
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
    const dept = r.department ?? "Unknown / no department on file";
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
 *  why this is per-deposit data being read as if it were per-repository. */
export function aggregateByRepository(rows: readonly DatasetLinkRow[]): RepositoryBreakdown[] {
  const byRepo = new Map<string, { datasets: Set<string>; accessModel: string | null }>();
  for (const r of rows) {
    const bucket = byRepo.get(r.repository) ?? { datasets: new Set(), accessModel: null };
    bucket.datasets.add(r.datasetId);
    if (bucket.accessModel === null && r.accessModel !== null) bucket.accessModel = r.accessModel;
    byRepo.set(r.repository, bucket);
  }
  return [...byRepo.entries()]
    .map(([repository, b]) => ({ repository, accessModel: b.accessModel, datasets: b.datasets.size }))
    .sort((a, b) => b.datasets - a.datasets);
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
    };
    bucket.datasets.add(r.datasetId);
    bucket.links++;
    const kind = bucketDatasetLink(r);
    // No registry bucket on this row shape (see `NamedFacultyRow`'s comment)
    // — a registry-kind link still counts toward `datasets`/`links` above,
    // it just doesn't land in either access column.
    if (kind === "open") bucket.openDatasets.add(r.datasetId);
    else if (kind === "controlled") bucket.controlledDatasets.add(r.datasetId);
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
    }))
    .sort((a, b) => b.datasets - a.datasets);
}

/** Flatten every link row's `pmids` into one deduped set — "this publication
 *  has at least one detected deposit somewhere". Deliberately NOT filtered by
 *  author position or by which cwid the link belongs to: a publication has a
 *  detected deposit if ANY row cites it, regardless of who's individually
 *  credited on the `PersonDatasetDeposit` row. This matters — a pub can be
 *  first-authored by Faculty A but have its deposit attributed to Faculty B,
 *  a middle author on the same pub; filtering by position/cwid here would
 *  wrongly mark Faculty A's paper as having no deposit. */
export function depositedPmidSet(rows: readonly DatasetLinkRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.pmids || r.pmids.length === 0) continue;
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
 *  real data-sharing pmids (`loadFundingSplit`'s `where.pmid`). A pmid with
 *  BOTH a registry row and a non-registry row is still excluded here: the
 *  funding lens asks "of publications with a real (non-registry) data
 *  deposit, how many are NIH-funded", and mixing in a pmid whose only
 *  detected deposit signal might be a CT.gov registration would blur that
 *  question — simpler and more conservative than trying to partially credit
 *  a pmid that has both. */
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
    const dept = r.department ?? "Unknown / no department on file";
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

export type FundingSplitTotals = { nihFundedPubs: number; notNihFundedPubs: number };

/** NIH-funded vs. not-NIH-funded split over the real (non-registry) data-
 *  sharing pmid population — `depositedPmidSet(rows)` minus every pmid that
 *  only shows up via a registry-type row (`registryPmidSet`), mirroring the
 *  registry exclusion `pubAccessPmidSets` applies. A pmid counts as
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
  for (const l of links) {
    const alreadyNih = nihByPmid.get(l.pmid) ?? false;
    nihByPmid.set(l.pmid, alreadyNih || l.grant.nihIc !== null);
  }

  let nihFundedPubs = 0;
  for (const pmid of fundingPmids) {
    if (nihByPmid.get(pmid)) nihFundedPubs++;
  }
  return { nihFundedPubs, notNihFundedPubs: fundingPmids.length - nihFundedPubs };
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
 *  function accepts it pre-computed rather than becoming async itself. */
export function buildDataSharingReport(
  rows: readonly DatasetLinkRow[],
  corpusRows: readonly ShareRateCorpusRow[] = [],
  fundingSplit: FundingSplitTotals = { nihFundedPubs: 0, notNihFundedPubs: 0 },
): DataSharingReport {
  const deposited = depositedPmidSet(rows);
  const rates = buildShareRates(corpusRows, deposited);
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

  return {
    overall: {
      datasets: new Set(rows.map((r) => r.datasetId)).size,
      faculty: new Set(rows.map((r) => r.cwid)).size,
      links: rows.length,
      shareRateDenominator: rates.overall.denominatorPubs,
      shareRateNumerator: rates.overall.numeratorPubs,
      openPubs: openPmids.size,
      controlledPubs: controlledPmids.size,
      nihFundedPubs: fundingSplit.nihFundedPubs,
      notNihFundedPubs: fundingSplit.notNihFundedPubs,
    },
    byDepartment,
    byRepository: aggregateByRepository(rows),
    byFaculty,
  };
}

export async function loadDataSharingReport(client: DataSharingReportClient): Promise<DataSharingReport> {
  const [rows, corpusRows] = await Promise.all([
    loadDatasetLinkRows(client),
    loadShareRateCorpus(client),
  ]);
  const fundingSplit = await loadFundingSplit(client, rows);
  return buildDataSharingReport(rows, corpusRows, fundingSplit);
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

/** Slice a (person, dataset) link row set to `DATA_SHARING_EXPORT_CAP` — a
 *  pure helper (same shape as data-quality's `DataQualityExport`) so tests can
 *  exercise the truncation branch directly, without 5,001 fake DB rows
 *  end-to-end. */
export function capDatasetLinkRows(rows: readonly DatasetLinkRow[]): DataSharingExport {
  const total = rows.length;
  return {
    rows: rows.slice(0, DATA_SHARING_EXPORT_CAP),
    total,
    truncated: total > DATA_SHARING_EXPORT_CAP,
  };
}

const DATA_SHARING_CSV_HEADERS = [
  "repository",
  "accession_or_doi",
  "title",
  "resource_type",
  "data_type",
  "access_model",
  "deposit_year",
  "provenance",
  "confidence",
  "department",
  "faculty_name",
  "cwid",
] as const;

/** Serialize item-level (person, dataset) link rows to a CSV string — one row
 *  per link (this loader's own grain), not one row per distinct dataset. No
 *  email/PII field: neither `DatasetDeposit` nor `PersonDatasetDeposit` carries
 *  one — `faculty_name` + `cwid` are the only person-identifying columns, same
 *  as the on-page "Named faculty" table. */
export function buildDataSharingCsv(rows: readonly DatasetLinkRow[]): string {
  const body = rows.map((r) => [
    r.repository,
    r.accessionOrDoi ?? "",
    r.title ?? "",
    r.resourceType ?? "",
    r.dataType ?? "",
    r.accessModel ?? "",
    r.depositYear ?? "",
    r.provenance ?? "",
    r.confidence ?? "",
    r.department ?? "",
    r.scholarName,
    r.cwid,
  ]);
  return toCsv(DATA_SHARING_CSV_HEADERS, body);
}
