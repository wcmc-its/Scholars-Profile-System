/**
 * The one gate for the `/edit` dashboards (COI, Usage, ORCID coverage, ETL
 * status, Activity, Data sharing, Research security): the tab predicates
 * (`lib/edit/console-tabs.server.ts`), each page, and each export/API route
 * read it, so the tab and the page can never disagree.
 *
 * A dashboard is visible when its feature flag is on (COI, Data sharing,
 * Research security) AND
 * the viewer holds it by birthright OR by an ad hoc grant: a manual Reporting
 * grant carrying its `dash:` scope (`registryDashboards`, decision
 * 2026-10-01). The grant only adds access, never removes it. One exception
 * closes a dashboard outright: `dashboardBlocked`.
 *
 * Server-only (reads `@/lib/db`).
 */
import type { EditSession } from "@/lib/auth/superuser";
import { registryAdmitsDashboard } from "@/lib/auth/functional-role-authz";
import { db } from "@/lib/db";
import { isDataQualityDashboardEnabled } from "@/lib/edit/data-quality";
import { isDataSharingDashboardEnabled } from "@/lib/edit/data-sharing-dashboard";
import { UNGRANTABLE_DASHBOARDS, type Dashboard } from "@/lib/edit/functional-roles";
import { isResearchSecurityDashboardEnabled } from "@/lib/edit/research-security-dashboard";
import { canViewUsage } from "@/lib/edit/usage-access";

/** The session fields the gate reads. */
export type DashboardViewer = Pick<EditSession, "cwid" | "isSuperuser" | "isCommsSteward"> &
  Partial<
    Pick<
      EditSession,
      | "isObserver"
      | "isContentEditor"
      | "isDataSharingViewer"
      | "isResearchSecurityViewer"
      | "sensitiveDashboardsBlocked"
    >
  >;

/** False only while the dashboard's own feature flag is off. */
export function isDashboardFlagOn(d: Dashboard): boolean {
  if (d === "coi") return isDataQualityDashboardEnabled();
  if (d === "data-sharing") return isDataSharingDashboardEnabled();
  if (d === "research-security") return isResearchSecurityDashboardEnabled();
  return true;
}

/** Dashboards holding sensitive, per-person data. */
export const SENSITIVE_DASHBOARDS: ReadonlySet<Dashboard> = new Set<Dashboard>(["research-security"]);

/**
 * True when this session may not see dashboard `d` at all, whatever it holds:
 * a "View as" overlay started by a non-superuser (`sensitiveDashboardsBlocked`,
 * set by `getEffectiveEditSession`) never opens a sensitive dashboard, neither
 * through the impersonated person's role nor through their ad hoc grant. Read
 * by BOTH gate forms below, before the birthright and the registry.
 */
export function dashboardBlocked(s: DashboardViewer, d: Dashboard): boolean {
  return s.sensitiveDashboardsBlocked === true && SENSITIVE_DASHBOARDS.has(d);
}

/**
 * Who sees each dashboard without a grant. `viewerCanViewUsage` is the
 * already-resolved `canViewUsage` verdict (it needs a DB read).
 *
 * COI is public data (decision 2026-10-01), so observers and content editors
 * see it like every other dashboard; its page is read-only.
 */
export function dashboardBirthright(
  s: DashboardViewer,
  d: Dashboard,
  viewerCanViewUsage: boolean,
): boolean {
  switch (d) {
    case "coi":
      return s.isSuperuser || s.isObserver === true || s.isContentEditor === true;
    case "usage":
    case "orcid-coverage":
      return viewerCanViewUsage;
    case "etl-status":
    case "activity":
      return s.isSuperuser;
    case "data-sharing":
      return s.isSuperuser || s.isCommsSteward || s.isDataSharingViewer === true;
    // Sensitive, per-person screening results: NOT comms stewards, observers or
    // content editors (whose read view is a synthetic steward grant).
    case "research-security":
      return s.isSuperuser || s.isResearchSecurityViewer === true;
  }
}

/** The tab predicate's form: everything already loaded, no I/O. */
export function dashboardVisible(
  s: DashboardViewer,
  d: Dashboard,
  g: { viewerCanViewUsage: boolean; dashboards: ReadonlySet<Dashboard> },
): boolean {
  return (
    isDashboardFlagOn(d) &&
    !dashboardBlocked(s, d) &&
    (dashboardBirthright(s, d, g.viewerCanViewUsage) ||
      (!UNGRANTABLE_DASHBOARDS.has(d) && g.dashboards.has(d)))
  );
}

/** The page / route form: resolves the reads it needs. */
export async function canViewDashboard(s: DashboardViewer, d: Dashboard): Promise<boolean> {
  if (!isDashboardFlagOn(d) || dashboardBlocked(s, d)) return false;
  const usage = d === "usage" || d === "orcid-coverage" ? await canViewUsage(s, db.read) : false;
  if (dashboardBirthright(s, d, usage)) return true;
  if (UNGRANTABLE_DASHBOARDS.has(d)) return false;
  return registryAdmitsDashboard(s.cwid, d);
}
