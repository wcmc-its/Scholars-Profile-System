/**
 * Administrators-tab helpers (#728 Phase B, `ed-admin-org-unit-roles-spec.md`
 * § 4 / § 6 Phase B): the feature flag and the owner-scope resolver.
 *
 * The Administrators tab (`/edit/administrators`) is a read-only surface listing
 * every `UnitAdmin` grant grouped by person. Superusers see every grant; a unit
 * Owner sees only grants within the subtree they own (D5). This module supplies
 * the flag gate and computes the owner's unit-code scope server-side — the query,
 * never the UI, is the boundary.
 *
 * Server-only by construction for `loadOwnerManagedUnitScope` (reads Prisma via a
 * narrow injected client) — no `server-only` import so it loads under vitest with
 * a fake client, matching `unit-edit-context.ts` / `edit-roster.ts`. The flag is
 * read lazily inside the helper (never at module load), per the repo convention.
 */
import type { EditSession } from "@/lib/auth/superuser";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * Whether the Administrators tab is enabled (#728 Phase B). Off by default; when
 * off the page returns Forbidden and the tab is hidden in the subnav (mirroring
 * `isSlugRequestEnabled` for the slug-request queue).
 */
export function isAdministratorsTabEnabled(): boolean {
  return process.env.SELF_EDIT_ADMINISTRATORS_TAB === "on";
}

/**
 * The Prisma surface `loadOwnerManagedUnitScope` reads — a `PrismaClient` (or a
 * `db.read` client) satisfies it structurally. Kept narrow so the unit tests can
 * mock exactly these models.
 */
export type OwnerScopeClient = Pick<PrismaClient, "unitAdmin" | "division">;

/**
 * The unit codes a non-superuser Owner manages, expanded for the dept→division
 * cascade (Amendment 1 § A1.2): an owned **department** also covers each of its
 * **divisions**, so those division codes are added to the scope; an owned
 * **division** or **center** contributes only its own code. Returns `[]` for a
 * user who owns nothing (the page then renders Forbidden).
 *
 * Superuser callers should not invoke this — they see all grants (scope
 * `undefined`); this resolver is the Owner-subtree boundary only.
 */
export async function loadOwnerManagedUnitScope(
  session: EditSession,
  db: OwnerScopeClient,
): Promise<string[]> {
  const ownedRows = await db.unitAdmin.findMany({
    where: { cwid: session.cwid, role: "owner" },
    select: { entityType: true, entityId: true },
  });
  if (ownedRows.length === 0) return [];

  const scope = new Set<string>();
  const ownedDeptCodes: string[] = [];
  for (const row of ownedRows) {
    scope.add(row.entityId);
    if (row.entityType === "department") ownedDeptCodes.push(row.entityId);
  }

  // Expand each owned department to its divisions (the dept→division cascade).
  if (ownedDeptCodes.length > 0) {
    const divisions = await db.division.findMany({
      where: { deptCode: { in: ownedDeptCodes } },
      select: { code: true },
    });
    for (const d of divisions) scope.add(d.code);
  }

  return [...scope];
}
