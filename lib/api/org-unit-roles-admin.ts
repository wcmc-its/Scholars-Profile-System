/**
 * Org-unit role vocabulary roster (server-side builder) — #2542 Phase 3, the
 * steward-owned editor for `OrgUnitRole`.
 *
 * One roster row per `OrgUnitRole` entry, ordered by (entityType, roleGroup,
 * sortOrder, key) — the same grouping the unit page itself renders in — with a
 * `holderCount`: how many assignments currently reference that (entityType,
 * key). The confirm-on-rename dialog reports this as "this rename affects N
 * units", so it must be a real count, not a placeholder.
 *
 * TWO holder sources, neither of which is a single Prisma relation on
 * `OrgUnitRole` today:
 *   - `OrgUnitRoleAssignment` (the `leadershipHolders` relation) — the
 *     leadership half.
 *   - `CenterMembership.membershipRoleKey` — the membership half. This has NO
 *     Prisma relation yet (`prisma/schema.prisma`, `CenterMembership`: "No
 *     relation to OrgUnitRole YET" — the FK lands in a follow-up contract
 *     migration), so it is read directly off the column pair
 *     (`roleEntityType`, `membershipRoleKey`) rather than via `include`.
 * Both are read as a single grouped query (`groupBy`) rather than N+1 per-row
 * lookups.
 *
 * DB-CALLER-INJECTED ON PURPOSE. `buildRoleRoster` takes the Prisma client as
 * an explicit parameter rather than defaulting it from `lib/db.ts` (contrast
 * `buildFamilyRoster`'s `db: PrismaRead = prisma`): a default-arg alias to the
 * live client would make this un-runnable DB-free in a unit test, and the
 * default itself is easy to shadow silently at a call site. Server-only —
 * imports the generated Prisma types.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The narrow read surface `buildRoleRoster` needs — small enough for a test to
 *  inject a fake without standing up a real `PrismaClient`. */
export type OrgUnitRoleRosterDb = Pick<
  PrismaClient,
  "orgUnitRole" | "orgUnitRoleAssignment" | "centerMembership"
>;

/** One roster row — an `OrgUnitRole` entry plus its live holder count. */
export interface OrgUnitRoleRosterRow {
  key: string;
  entityType: string;
  label: string;
  roleGroup: string;
  scope: string;
  singleHolder: boolean;
  sortOrder: number;
  profileTitle: boolean;
  source: string;
  /** Assignments (leadership) + memberships (membership) currently keyed to
   *  this (entityType, key) — see the module docblock for the two sources. */
  holderCount: number;
}

/** `"{entityType}:{key}"` — the join key between the vocabulary rows and the
 *  two holder-count groupBys, neither of which shares a Prisma relation with
 *  the other. */
function rosterKey(entityType: string, key: string): string {
  return `${entityType}:${key}`;
}

/**
 * Build the full role-vocabulary roster across every unit kind, ordered by
 * (entityType, roleGroup, sortOrder, key).
 */
export async function buildRoleRoster(
  db: OrgUnitRoleRosterDb,
): Promise<OrgUnitRoleRosterRow[]> {
  const [roles, leadershipCounts, membershipCounts] = await Promise.all([
    db.orgUnitRole.findMany({
      orderBy: [
        { entityType: "asc" },
        { roleGroup: "asc" },
        { sortOrder: "asc" },
        { key: "asc" },
      ],
    }),
    db.orgUnitRoleAssignment.groupBy({
      by: ["entityType", "roleKey"],
      _count: { _all: true },
    }),
    db.centerMembership.groupBy({
      by: ["roleEntityType", "membershipRoleKey"],
      _count: { _all: true },
    }),
  ]);

  const holderCounts = new Map<string, number>();
  for (const row of leadershipCounts) {
    const k = rosterKey(row.entityType, row.roleKey);
    holderCounts.set(k, (holderCounts.get(k) ?? 0) + row._count._all);
  }
  for (const row of membershipCounts) {
    // A pre-backfill row (or one with no membership role at all) groups under
    // a null `membershipRoleKey` — it references no vocabulary entry, so skip it.
    if (row.membershipRoleKey === null) continue;
    const k = rosterKey(row.roleEntityType, row.membershipRoleKey);
    holderCounts.set(k, (holderCounts.get(k) ?? 0) + row._count._all);
  }

  return roles.map((role) => ({
    key: role.key,
    entityType: role.entityType,
    label: role.label,
    roleGroup: role.roleGroup,
    scope: role.scope,
    singleHolder: role.singleHolder,
    sortOrder: role.sortOrder,
    profileTitle: role.profileTitle,
    source: role.source,
    holderCount: holderCounts.get(rosterKey(role.entityType, role.key)) ?? 0,
  }));
}
