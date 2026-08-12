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
      dataset: { select: { repository: true, accessModel: true } },
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
