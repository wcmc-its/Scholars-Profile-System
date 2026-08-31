/**
 * Org-unit role vocabulary roster (server-side builder) — #2542 Phase 3, the
 * steward-owned editor for `OrgUnitRole`.
 *
 * One roster row per `OrgUnitRole` entry, ordered by (entityType, roleGroup,
 * sortOrder, key) — the same grouping the unit page itself renders in — with
 * TWO live counts, deliberately kept apart because they answer different
 * questions and only coincide for a `singleHolder` role:
 *   - `holderCount`: how many PEOPLE currently hold this role — assignment
 *     rows plus membership rows referencing that (entityType, key).
 *   - `unitCount`: how many DISTINCT units (by entity id / center code) have
 *     at least one holder of that role. A role held by 400 people across 3
 *     centers has `holderCount: 400, unitCount: 3` — neither number alone is
 *     the "blast radius" of a rename; the confirm dialog states both.
 *
 * TWO holder sources, neither of which is a single Prisma relation on
 * `OrgUnitRole` today:
 *   - `OrgUnitRoleAssignment` (the `leadershipHolders` relation) — the
 *     leadership half, one row per (entityType, entityId, roleKey, cwid).
 *   - `CenterMembership.membershipRoleKey` — the membership half, one row per
 *     (centerCode, roleEntityType, membershipRoleKey, cwid). This has NO
 *     Prisma relation yet (`prisma/schema.prisma`, `CenterMembership`: "No
 *     relation to OrgUnitRole YET" — the FK lands in a follow-up contract
 *     migration), so it is read directly off the column pair
 *     (`roleEntityType`, `membershipRoleKey`) rather than via `include`.
 * Both are read as a single grouped query each (`groupBy`, widened to include
 * the unit-identifying column — `entityId` / `centerCode` — alongside the
 * role columns) rather than N+1 per-row lookups; `holderCount` and
 * `unitCount` are both derived from those same two result sets, so this is
 * still exactly two round trips.
 *
 * `unitCount` UNIONS TWO COLUMNS THAT NOTHING FORCES TO AGREE. It dedupes
 * `OrgUnitRoleAssignment.entityId` against `CenterMembership.centerCode`, and
 * that is sound today only because every writer of a center assignment stores
 * `Center.code` verbatim (the #2542 backfill and `app/api/edit/unit/route.ts`),
 * while `centerCode` is FK'd to `Center.code`. But `entityId` is POLYMORPHIC
 * with no FK of its own, and `CenterMembership.roleEntityType` has no writer at
 * all — it only ever holds its `"center"` default. A future writer that stores
 * some other identifier in `entityId`, or sets a non-center `roleEntityType`,
 * would make the same unit look like two and silently inflate `unitCount`.
 * If you add such a writer, normalize here first.
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
   *  this (entityType, key) — a count of PEOPLE. See the module docblock. */
  holderCount: number;
  /** Distinct units (by entity id / center code) with at least one holder of
   *  this (entityType, key). A count of UNITS, not people — see the module
   *  docblock. Always `<= holderCount`, equal to it exactly when every
   *  holding unit has exactly one holder (the common case for a
   *  `singleHolder` role). */
  unitCount: number;
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
      by: ["entityType", "roleKey", "entityId"],
      _count: { _all: true },
    }),
    db.centerMembership.groupBy({
      by: ["roleEntityType", "membershipRoleKey", "centerCode"],
      _count: { _all: true },
    }),
  ]);

  const holderCounts = new Map<string, number>();
  // Distinct holding units per role key — a `Set` per key, sized at the end.
  const unitsByKey = new Map<string, Set<string>>();

  function addHolders(k: string, count: number, unitId: string): void {
    holderCounts.set(k, (holderCounts.get(k) ?? 0) + count);
    let units = unitsByKey.get(k);
    if (!units) {
      units = new Set();
      unitsByKey.set(k, units);
    }
    units.add(unitId);
  }

  for (const row of leadershipCounts) {
    addHolders(rosterKey(row.entityType, row.roleKey), row._count._all, row.entityId);
  }
  for (const row of membershipCounts) {
    // A pre-backfill row (or one with no membership role at all) groups under
    // a null `membershipRoleKey` — it references no vocabulary entry, so skip it.
    if (row.membershipRoleKey === null) continue;
    addHolders(
      rosterKey(row.roleEntityType, row.membershipRoleKey),
      row._count._all,
      row.centerCode,
    );
  }

  return roles.map((role) => {
    const k = rosterKey(role.entityType, role.key);
    return {
      key: role.key,
      entityType: role.entityType,
      label: role.label,
      roleGroup: role.roleGroup,
      scope: role.scope,
      singleHolder: role.singleHolder,
      sortOrder: role.sortOrder,
      profileTitle: role.profileTitle,
      source: role.source,
      holderCount: holderCounts.get(k) ?? 0,
      unitCount: unitsByKey.get(k)?.size ?? 0,
    };
  });
}
