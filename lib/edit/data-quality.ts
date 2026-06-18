/**
 * Data Quality dashboard — feature flag, tab visibility, and access scope
 * (`docs/data-quality-dashboard-spec.md`).
 *
 * The dashboard (`/edit/data-quality`) is a read-only, prominence-sorted list of
 * scholars and their data-quality gaps (missing headshot / overview, pending COI
 * suggestions). It is for every `/edit` user EXCEPT a plain scholar editing their
 * own profile: a superuser or comms_steward sees ALL scholars; a unit Owner /
 * Curator sees only scholars in the unit(s) they administer (dept→division
 * cascade + center memberships). This module supplies the flag gate, the sub-nav
 * visibility predicate, and the server-side scope resolver — the query, never the
 * UI, is the boundary.
 *
 * Server-only by construction for the scope resolver (reads Prisma via a narrow
 * injected client) — no `server-only` import so it loads under vitest with a fake
 * client, matching `administrators.ts` / `edit-roster.ts`. Flags are read lazily
 * inside the helpers (never at module load), per the repo convention.
 */
import type { EditSession } from "@/lib/auth/superuser";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * Whether the Data Quality dashboard is enabled (off by default). When off the
 * route 404s and the sub-nav tab is hidden — mirroring `isAdministratorsTabEnabled`
 * / `isMethodsTabVisible`.
 */
export function isDataQualityDashboardEnabled(): boolean {
  return process.env.EDIT_DATA_QUALITY_DASHBOARD === "on";
}

/**
 * Whether to advertise the "Data quality" tab in the admin sub-nav for this
 * viewer on a STEWARD surface: the feature is enabled AND the viewer is a global
 * editor (superuser or comms_steward), so they can open the org-wide dashboard.
 * A unit Owner/Curator is NOT a global editor — the `/edit/units` page ORs this
 * with "has manageable units" so they still get the tab there (scoped to their
 * units), while never being shown it on surfaces they can't open.
 */
export function isDataQualityTabVisible(session: {
  isSuperuser: boolean;
  isCommsSteward: boolean;
}): boolean {
  return isDataQualityDashboardEnabled() && (session.isSuperuser || session.isCommsSteward);
}

/**
 * The access scope for a viewer: `{ all: true }` for a global editor (superuser /
 * comms_steward), otherwise the set of unit codes (departments + divisions, with
 * the dept→division cascade) and center codes the viewer administers as Owner OR
 * Curator. A viewer with neither global role nor any grant resolves to an empty
 * scope; the route treats that as Forbidden (404).
 */
export type DataQualityScope =
  | { all: true }
  | { all: false; unitCodes: string[]; centerCodes: string[] };

/** The narrow Prisma surface the scope resolver reads. */
export type DataQualityScopeClient = Pick<PrismaClient, "unitAdmin" | "division">;

/**
 * Resolve the viewer's scope. A superuser or comms_steward is a global editor
 * (`{ all: true }`). Otherwise read their `unit_admin` grants (Owner OR Curator),
 * expand owned/curated departments to their divisions (the dept→division cascade,
 * mirroring `loadOwnerManagedUnitScope`), and carry center codes separately (a
 * center scopes by membership, not a scholar column).
 */
export async function loadDataQualityScope(
  session: EditSession,
  db: DataQualityScopeClient,
): Promise<DataQualityScope> {
  if (session.isSuperuser || session.isCommsSteward) return { all: true };

  const grants = await db.unitAdmin.findMany({
    where: { cwid: session.cwid },
    select: { entityType: true, entityId: true },
  });

  const unitCodes = new Set<string>();
  const centerCodes = new Set<string>();
  const deptCodes: string[] = [];
  for (const g of grants) {
    if (g.entityType === "department") {
      unitCodes.add(g.entityId);
      deptCodes.push(g.entityId);
    } else if (g.entityType === "division") {
      unitCodes.add(g.entityId);
    } else if (g.entityType === "center") {
      centerCodes.add(g.entityId);
    }
  }

  // Expand each managed department to its divisions (dept→division cascade).
  if (deptCodes.length > 0) {
    const divisions = await db.division.findMany({
      where: { deptCode: { in: deptCodes } },
      select: { code: true },
    });
    for (const d of divisions) unitCodes.add(d.code);
  }

  return { all: false, unitCodes: [...unitCodes], centerCodes: [...centerCodes] };
}

/** True when a non-global viewer's scope is empty — the route renders Forbidden. */
export function isEmptyScope(scope: DataQualityScope): boolean {
  return scope.all === false && scope.unitCodes.length === 0 && scope.centerCodes.length === 0;
}
