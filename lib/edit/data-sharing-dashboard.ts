/**
 * S-Index Phase 1 admin/CTSA dashboard (`/edit/data-sharing`) — feature flag +
 * tab visibility. Global-only, no unit scoping: unlike Data Quality, there is
 * no natural "unit Owner sees their unit's rollup" cut here (department rollups
 * span the whole DatasetDeposit/PersonDatasetDeposit bridge, not a per-unit
 * roster), so this mirrors the Usage dashboard's audience shape (a fixed
 * role check) rather than Data Quality's scope resolver. Audience: superuser,
 * comms_steward, or data_sharing_viewer (2026-08-15 — the dedicated role added
 * for the standing audience this dashboard was reframed around: research
 * leadership, compliance/grant reporting, and the library/RDM team; see
 * `lib/auth/data-sharing-viewer.ts`).
 */
import type { EditSession } from "@/lib/auth/superuser";
import type { DataSharingReportFilters } from "@/lib/api/data-sharing-report";

/** Whether the dashboard is enabled (off by default). When off the route
 *  404s and the sub-nav tab is hidden — mirrors `isDataQualityDashboardEnabled`. */
export function isDataSharingDashboardEnabled(): boolean {
  return process.env.EDIT_DATA_SHARING_DASHBOARD === "on";
}

/** Whether to advertise the "Data sharing" tab for this viewer: the feature is
 *  enabled AND the viewer is a superuser, a comms_steward, or a
 *  data_sharing_viewer. */
export function isDataSharingDashboardTabVisible(session: {
  isSuperuser: boolean;
  isCommsSteward: boolean;
  isDataSharingViewer?: boolean;
}): boolean {
  return (
    isDataSharingDashboardEnabled() &&
    (session.isSuperuser || session.isCommsSteward || !!session.isDataSharingViewer)
  );
}

/** Same predicate, applied to a resolved `EditSession` — the page's own gate. */
export function canViewDataSharingDashboard(session: EditSession): boolean {
  return isDataSharingDashboardTabVisible(session);
}

/** Sortable columns per table (2026-08-16 ask: "the datasets-desc default
 *  buries a small department's high share rate — rate-sorted is the view the
 *  RDM team actually wants"). Server-rendered `<a>` links, not a client
 *  sort — `applyReportFilters`/`loadDataSharingReport` already re-render the
 *  whole page on every filter change, so a second, client-only sort
 *  mechanism would be two different interaction models on one page for no
 *  real gain; ponytail: native GET links cover the ask (click a header,
 *  page reloads sorted) without a client island or shipping the full
 *  (unpaginated) byFaculty array to the browser. */
/** Rows per faculty-table page (2026-08-16: was a static "+N more, see the
 *  CSV" cut; now the page size for real in-page pagination — same number,
 *  same rationale, a 500+-row wall was the original complaint). */
export const FACULTY_ROW_CAP = 25;

export const DEPARTMENT_SORT_KEYS = ["datasets", "faculty", "shareRate"] as const;
export type DepartmentSortKey = (typeof DEPARTMENT_SORT_KEYS)[number];
export const FACULTY_SORT_KEYS = ["datasets", "shareRate", "concerning"] as const;
export type FacultySortKey = (typeof FACULTY_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export type DataSharingUiParams = {
  filters: DataSharingReportFilters;
  deptSort?: DepartmentSortKey;
  deptDir: SortDir;
  facSort?: FacultySortKey;
  facDir: SortDir;
  /** 1-indexed page into `byFaculty` — pagination past the old static
   *  `FACULTY_ROW_CAP` cut (2026-08-16 ask). */
  facPage: number;
};

function parseNumericParam(v: string | string[] | undefined): number | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function parseDir(v: string | string[] | undefined): SortDir {
  return (Array.isArray(v) ? v[0] : v) === "asc" ? "asc" : "desc";
}

/** Parses `/edit/data-sharing`'s query params — filters (year range, tier)
 *  and per-table sort/page. Every param is independently optional and
 *  invalid values degrade to "no filter"/"default sort", never a thrown
 *  error — this page has no client-side validation in front of it, a typed
 *  URL is the only input. */
export function parseDataSharingParams(
  searchParams: Record<string, string | string[] | undefined>,
): DataSharingUiParams {
  const tiersRaw = searchParams.tier;
  const tiers = tiersRaw === undefined ? undefined : Array.isArray(tiersRaw) ? tiersRaw : [tiersRaw];
  const deptSortRaw = Array.isArray(searchParams.deptSort) ? searchParams.deptSort[0] : searchParams.deptSort;
  const facSortRaw = Array.isArray(searchParams.facSort) ? searchParams.facSort[0] : searchParams.facSort;
  const facPage = parseNumericParam(searchParams.facPage);
  return {
    filters: {
      yearFrom: parseNumericParam(searchParams.yearFrom),
      yearTo: parseNumericParam(searchParams.yearTo),
      tiers,
    },
    deptSort: DEPARTMENT_SORT_KEYS.includes(deptSortRaw as DepartmentSortKey)
      ? (deptSortRaw as DepartmentSortKey)
      : undefined,
    deptDir: parseDir(searchParams.deptDir),
    facSort: FACULTY_SORT_KEYS.includes(facSortRaw as FacultySortKey) ? (facSortRaw as FacultySortKey) : undefined,
    facDir: parseDir(searchParams.facDir),
    facPage: facPage && facPage >= 1 ? Math.floor(facPage) : 1,
  };
}
