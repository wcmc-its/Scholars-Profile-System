/**
 * Read helper for `OrgUnitRoleScope` (#2557 Phase E amendment — explicit role
 * scoping, not default-allow).
 *
 * `research` and `clinical` are NCI CCSG vocabulary seeded into the SHARED
 * `center` role vocabulary, so all 11 centers could use them, but only Meyer
 * does (298 `research` rows, 54 `clinical`, all at `meyer_cancer_center` —
 * measured prod 2026-08-31). `isRoleAllowedAtUnit` is the gate a write path
 * calls before letting a role be newly assigned.
 *
 * SEMANTICS, mirroring the `OrgUnitRoleScope` model docblock in
 * `prisma/schema.prisma`:
 *   - ZERO scope rows for a (`entityType`, `roleKey`) pair means UNRESTRICTED
 *     — the role is allowed at any unit of that kind. Returns `true`.
 *   - ONE OR MORE rows means the role is allowed ONLY at the listed
 *     `entityId`s. Returns `true` only when `entityId` is one of them, `false`
 *     otherwise.
 * This is deliberately NOT a global default-deny: an empty table stays
 * permissive so no unit can be born unable to render a leader — creating a
 * center already mints no `unit_admin` row, and a model requiring scope rows
 * to pre-exist would inherit that same fail-closed hazard. Full rationale:
 * issue #2557.
 *
 * THIS SLICE (#2557) ADDS THE HELPER AND WIRES IT IN. Both center membership
 * write paths in `app/api/edit/roster/route.ts` call it — `handleCenter` (an
 * explicit `membershipType` in the body, and a `set`/`add` that defaults a new
 * row to `member`) and `handleCornellAdd`'s hardcoded `member` write. Existing
 * holders are never affected: this only ever gates a NEW or changed
 * assignment, and callers must not use it to retroactively hide or remove one.
 * Still not wired to this gate: the director assignment write path in
 * `app/api/edit/unit/route.ts` (writes `OrgUnitRoleAssignment` rows with a
 * hardcoded `DIRECTOR_ROLE_KEY`) — that write path exists today and is not
 * gated by this helper; `director` carries no scope rows so there is no
 * practical hole yet, but a future scope row on a leadership role would not
 * be enforced until that path calls this helper too. There is also no
 * steward UI for editing `OrgUnitRoleScope` rows themselves.
 *
 * DB-CALLER-INJECTED ON PURPOSE, no default arg aliasing the live client —
 * mirrors `buildRoleRoster` in `lib/api/org-unit-roles-admin.ts` — so a test
 * never has to stand up a real `PrismaClient`. Server-only: imports the
 * generated Prisma types, so this file must never be imported from
 * `lib/org-unit-roles.ts` or anything else that reaches the client bundle.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The narrow read surface `isRoleAllowedAtUnit` needs. */
export type OrgUnitRoleScopeDb = Pick<PrismaClient, "orgUnitRoleScope">;

/**
 * Is `roleKey` (of kind `entityType`) assignable at `entityId`?
 *
 * `true` when the role has zero scope rows (unrestricted, the default for
 * every role today) or when a scope row names this exact `entityId`. `false`
 * only when the role has one or more scope rows and none of them is this
 * `entityId`.
 */
export async function isRoleAllowedAtUnit(p: {
  entityType: string;
  roleKey: string;
  entityId: string;
  client: OrgUnitRoleScopeDb;
}): Promise<boolean> {
  const { entityType, roleKey, entityId, client } = p;

  const rows = await client.orgUnitRoleScope.findMany({
    where: { entityType, roleKey },
    select: { entityId: true },
  });

  // No scope rows at all for this role -> unrestricted.
  if (rows.length === 0) return true;

  return rows.some((row) => row.entityId === entityId);
}
