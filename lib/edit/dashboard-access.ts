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
 * Activity is also open to a department / division / center admin, who sees
 * it limited to their own people and units ({@link loadDashboardScope},
 * decision 2026-11-17).
 *
 * Server-only (reads `@/lib/db`).
 */
import { loadScopeMemberCwids } from "@/lib/api/data-quality";
import type { EditSession } from "@/lib/auth/superuser";
import { registryAdmitsDashboard } from "@/lib/auth/functional-role-authz";
import { db } from "@/lib/db";
import { isDataQualityDashboardEnabled, loadDataQualityScope } from "@/lib/edit/data-quality";
import { isDataSharingDashboardEnabled } from "@/lib/edit/data-sharing-dashboard";
import { UNGRANTABLE_DASHBOARDS, type Dashboard } from "@/lib/edit/functional-roles";
import { loadManageableUnits } from "@/lib/edit/manageable-units";
import { isResearchSecurityDashboardEnabled } from "@/lib/edit/research-security-dashboard";
import { canViewUsage } from "@/lib/edit/usage-access";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";

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

/** The grant kinds whose admins get the unit-scoped Activity view: the kinds
 *  that have people. Never `core` or `institution`. */
const SCOPED_GRANT_KINDS = ["department", "division", "center"] as const;

/** True if `cwid` holds a department / division / center `UnitAdmin` grant
 *  (owner OR curator). */
export async function adminsScopedUnit(
  cwid: string,
  client: Pick<PrismaClient, "unitAdmin">,
): Promise<boolean> {
  const grant = await client.unitAdmin.findFirst({
    where: { cwid, entityType: { in: [...SCOPED_GRANT_KINDS] } },
    select: { cwid: true },
  });
  return grant !== null;
}

/**
 * Who sees each dashboard without a grant. `viewerCanViewUsage` is the
 * already-resolved `canViewUsage` verdict and `viewerAdminsScopedUnit` the
 * already-resolved {@link adminsScopedUnit} one (each needs a DB read).
 *
 * COI is public data (decision 2026-10-01), so observers and content editors
 * see it like every other dashboard; its page is read-only.
 */
export function dashboardBirthright(
  s: DashboardViewer,
  d: Dashboard,
  viewerCanViewUsage: boolean,
  viewerAdminsScopedUnit = false,
): boolean {
  switch (d) {
    case "coi":
      return s.isSuperuser || s.isObserver === true || s.isContentEditor === true;
    case "usage":
    case "orcid-coverage":
      return viewerCanViewUsage;
    case "etl-status":
      return s.isSuperuser;
    case "activity":
      return s.isSuperuser || viewerAdminsScopedUnit;
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
  g: {
    viewerCanViewUsage: boolean;
    viewerAdminsScopedUnit: boolean;
    dashboards: ReadonlySet<Dashboard>;
  },
): boolean {
  return (
    isDashboardFlagOn(d) &&
    !dashboardBlocked(s, d) &&
    (dashboardBirthright(s, d, g.viewerCanViewUsage, g.viewerAdminsScopedUnit) ||
      (!UNGRANTABLE_DASHBOARDS.has(d) && g.dashboards.has(d)))
  );
}

/** The page / route form: resolves the reads it needs. */
export async function canViewDashboard(s: DashboardViewer, d: Dashboard): Promise<boolean> {
  if (!isDashboardFlagOn(d) || dashboardBlocked(s, d)) return false;
  const usage = d === "usage" || d === "orcid-coverage" ? await canViewUsage(s, db.read) : false;
  const scoped =
    d === "activity" && !s.isSuperuser ? await adminsScopedUnit(s.cwid, db.read) : false;
  if (dashboardBirthright(s, d, usage, scoped)) return true;
  if (UNGRANTABLE_DASHBOARDS.has(d)) return false;
  return registryAdmitsDashboard(s.cwid, d);
}

/**
 * What a viewer who passed the gate sees: everything (`all`), or only their
 * own units and the people in them. Always resolved here from the session,
 * never from a request parameter.
 */
export type DashboardScope =
  | { all: true }
  | {
      all: false;
      /** Display names of the viewer's directly granted units, for the heading. */
      unitNames: string[];
      /** Department + division codes (departments expanded to their divisions). */
      unitCodes: string[];
      centerCodes: string[];
      /** Every scholar in those units (`loadScopeMemberCwids`). */
      memberCwids: string[];
    };

/**
 * The scope of the Activity dashboard for `s`. A superuser or an ad hoc
 * `dash:activity` grantee sees every edit, as before. Anyone else is here as a
 * department / division / center admin (owner or curator) and sees those
 * units: the grants are read directly, so a comms steward's site-wide Profiles
 * scope does not widen Activity, and institution grants are left out.
 */
export async function loadDashboardScope(s: EditSession, d: "activity"): Promise<DashboardScope> {
  if (s.isSuperuser || (await registryAdmitsDashboard(s.cwid, d))) return { all: true };
  const scope = await loadDataQualityScope(
    { ...s, isSuperuser: false, isCommsSteward: false },
    db.read,
  );
  // Unreachable (both site-wide roles are forced off above); narrows the type.
  if (scope.all) return { all: true };
  const units = { all: false as const, unitCodes: scope.unitCodes, centerCodes: scope.centerCodes };
  const [memberCwids, granted] = await Promise.all([
    loadScopeMemberCwids(units, db.read),
    loadManageableUnits(s.cwid, db.read),
  ]);
  return {
    ...units,
    unitNames: [...granted.departments, ...granted.divisions, ...granted.centers].map((u) => u.name),
    memberCwids: memberCwids ?? [],
  };
}

/**
 * The audit-log (`manual_edit_audit`) predicate for a scope: the edit targets
 * a scholar in the scope, or one of the viewer's own units. `undefined` for
 * `all` (no filter). Every value is bound (`Prisma.join`); an empty list
 * contributes no clause, and a scope with nothing in it matches no row.
 */
export function activityScopeSql(scope: DashboardScope): Prisma.Sql | undefined {
  if (scope.all) return undefined;
  const ors: Prisma.Sql[] = [];
  if (scope.memberCwids.length > 0) {
    ors.push(
      Prisma.sql`(target_entity_type = 'scholar' AND target_entity_id IN (${Prisma.join(scope.memberCwids)}))`,
    );
  }
  if (scope.unitCodes.length > 0) {
    ors.push(
      Prisma.sql`(target_entity_type IN ('department', 'division') AND target_entity_id IN (${Prisma.join(scope.unitCodes)}))`,
    );
  }
  if (scope.centerCodes.length > 0) {
    ors.push(
      Prisma.sql`(target_entity_type = 'center' AND target_entity_id IN (${Prisma.join(scope.centerCodes)}))`,
    );
  }
  return ors.length > 0 ? Prisma.join(ors, " OR ") : Prisma.sql`1 = 0`;
}
