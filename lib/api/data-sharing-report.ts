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
 * volume — by department, by repository, and by named faculty. It does NOT
 * compute "share rate" (datasets per data-eligible publication) or full-text
 * coverage, both of which the SPEC lists as headline stats. Those need a
 * denominator this pass didn't build: which publications count as
 * "data-eligible" (first/last/corresponding author, since-year, a corpus that
 * itself needs a coverage-skew caveat) is a real open definitional question,
 * not a quick join — and a wrong denominator on a number CTSA writers quote is
 * worse than a missing one (see `reference_shared_pct_column_needs_one_denominator`).
 * Fast-follow once that definition is settled.
 *
 * Strict-only (decided 2026-08-12): `DatasetDeposit.confidence` is only ever
 * `'high'` or `null` in what's actually persisted — there is no generous/ceiling
 * band to read. See the dashboard plan's "Strict/generous band" section.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadContributorSuppressions } from "@/lib/api/manual-layer";
import { toCsv } from "@/lib/csv";

/** The Prisma surface this loader needs — kept narrow for unit tests. */
export type DataSharingReportClient = Pick<
  PrismaClient,
  "personDatasetDeposit" | "suppression"
>;

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
};

export type DepartmentRollup = {
  department: string;
  datasets: number;
  faculty: number;
  links: number;
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
};

export type DataSharingReport = {
  overall: { datasets: number; faculty: number; links: number };
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
    });
  }
  return rows;
}

/** Distinct-dataset / distinct-faculty / link counts, department is
 *  single-valued per scholar so faculty counts partition cleanly across
 *  departments — but dataset counts do NOT (a dataset with co-authors in two
 *  departments counts once in each), so summing this table's `datasets`
 *  column will run ahead of `overall.datasets`. That's real multi-department
 *  co-authorship, not a bug — don't silently reconcile it away. */
export function aggregateByDepartment(rows: readonly DatasetLinkRow[]): DepartmentRollup[] {
  const byDept = new Map<string, { datasets: Set<string>; faculty: Set<string>; links: number }>();
  for (const r of rows) {
    const dept = r.department ?? "Unknown / no department on file";
    const bucket = byDept.get(dept) ?? { datasets: new Set(), faculty: new Set(), links: 0 };
    bucket.datasets.add(r.datasetId);
    bucket.faculty.add(r.cwid);
    bucket.links++;
    byDept.set(dept, bucket);
  }
  return [...byDept.entries()]
    .map(([department, b]) => ({
      department,
      datasets: b.datasets.size,
      faculty: b.faculty.size,
      links: b.links,
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
    { name: string; slug: string; department: string | null; datasets: Set<string>; links: number }
  >();
  for (const r of rows) {
    const bucket = byCwid.get(r.cwid) ?? {
      name: r.scholarName,
      slug: r.scholarSlug,
      department: r.department,
      datasets: new Set<string>(),
      links: 0,
    };
    bucket.datasets.add(r.datasetId);
    bucket.links++;
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
    }))
    .sort((a, b) => b.datasets - a.datasets);
}

export function buildDataSharingReport(rows: readonly DatasetLinkRow[]): DataSharingReport {
  return {
    overall: {
      datasets: new Set(rows.map((r) => r.datasetId)).size,
      faculty: new Set(rows.map((r) => r.cwid)).size,
      links: rows.length,
    },
    byDepartment: aggregateByDepartment(rows),
    byRepository: aggregateByRepository(rows),
    byFaculty: aggregateByFaculty(rows),
  };
}

export async function loadDataSharingReport(client: DataSharingReportClient): Promise<DataSharingReport> {
  const rows = await loadDatasetLinkRows(client);
  return buildDataSharingReport(rows);
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
