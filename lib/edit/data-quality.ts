/**
 * Profiles roster — feature flag (for its COI-review slice) and access scope.
 *
 * `/edit/scholars` ("Profiles") is a prominence-sorted list of scholars, scoped
 * for every `/edit` user EXCEPT a plain scholar editing their own profile: a
 * superuser or comms_steward sees ALL scholars; a unit Owner / Curator sees only
 * scholars in the unit(s) they administer (dept→division cascade + center
 * memberships). This module supplies the scope resolver — the query, never the
 * UI, is the boundary.
 *
 * `isDataQualityDashboardEnabled` now gates one narrower thing: the COI-review
 * column/filter on that same Profiles page, which is ALSO superuser-only
 * (`session.isSuperuser` — a comms_steward or unit Owner/Curator does not get
 * it, unlike the rest of the roster). Formerly this flag gated a whole standalone
 * "Data Quality dashboard" page (`docs/data-quality-dashboard-spec.md`) with its
 * own nav tab; that surface was folded into Profiles and its headshot/overview
 * gap tracking was dropped, keeping only the COI slice under this flag. The name
 * stuck for historical reasons — `EDIT_DATA_QUALITY_DASHBOARD` is the live env var.
 *
 * Server-only by construction for the scope resolver (reads Prisma via a narrow
 * injected client) — no `server-only` import so it loads under vitest with a fake
 * client, matching `administrators.ts` / `edit-roster.ts`. Flags are read lazily
 * inside the helpers (never at module load), per the repo convention.
 */
import type { EditSession } from "@/lib/auth/superuser";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * Whether the COI-review column/filter on the Profiles roster is enabled (off
 * by default). When off, the column and filter option are hidden for every
 * viewer, including superusers — mirroring `isAdministratorsTabEnabled` /
 * `isMethodsTabVisible`. Still superuser-only when on (see module doc comment).
 */
export function isDataQualityDashboardEnabled(): boolean {
  return process.env.EDIT_DATA_QUALITY_DASHBOARD === "on";
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
  // `cv_generator` (#2482) is a global READ-only role: it gets the same `{ all:
  // true }` scope as superuser/comms_steward here (this resolver only decides
  // WHICH scholars are listed, never write access), but stays excluded from
  // the superuser-only COI-review column (`session.isSuperuser`, unaffected).
  if (session.isSuperuser || session.isCommsSteward || session.isCvGenerator) return { all: true };

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
