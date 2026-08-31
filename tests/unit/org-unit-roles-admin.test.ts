/**
 * Org-unit role vocabulary roster builder — pure / DB-free logic (#2542
 * Phase 3, `lib/api/org-unit-roles-admin.ts`).
 *
 * `buildRoleRoster` takes an injectable Prisma-shaped db explicitly (never a
 * default-arg alias to the live client), so a hand-rolled stub stands in for
 * the two holder sources — these tests never touch a real database.
 */
import { describe, expect, it } from "vitest";

import { buildRoleRoster } from "@/lib/api/org-unit-roles-admin";

type RoleRow = {
  entityType: string;
  key: string;
  label: string;
  roleGroup: string;
  scope: string;
  singleHolder: boolean;
  sortOrder: number;
  profileTitle: boolean;
  source: string;
};

type AssignmentGroup = { entityType: string; roleKey: string; _count: { _all: number } };
type MembershipGroup = {
  roleEntityType: string;
  membershipRoleKey: string | null;
  _count: { _all: number };
};

function makeDb(input: {
  roles: RoleRow[];
  leadershipCounts?: AssignmentGroup[];
  membershipCounts?: MembershipGroup[];
}) {
  return {
    orgUnitRole: {
      // The real query orders server-side; the fixtures below are already in
      // that order so this stub does not need to re-implement the sort.
      findMany: async () => input.roles,
    },
    orgUnitRoleAssignment: {
      groupBy: async () => input.leadershipCounts ?? [],
    },
    centerMembership: {
      groupBy: async () => input.membershipCounts ?? [],
    },
    // Cast at the call site keeps the stub terse without re-declaring all of
    // PrismaClient — `buildRoleRoster` only ever touches the three reads above.
  } as unknown as Parameters<typeof buildRoleRoster>[0];
}

const role = (
  entityType: string,
  key: string,
  roleGroup: string,
  sortOrder: number,
  overrides: Partial<RoleRow> = {},
): RoleRow => ({
  entityType,
  key,
  label: overrides.label ?? key,
  roleGroup,
  scope: overrides.scope ?? "unit",
  singleHolder: overrides.singleHolder ?? false,
  sortOrder,
  profileTitle: overrides.profileTitle ?? roleGroup === "leadership",
  source: overrides.source ?? "seed",
});

describe("buildRoleRoster", () => {
  it("returns the roster in the order the query already provided (entityType, roleGroup, sortOrder, key)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [
          role("center", "director", "leadership", 10),
          role("center", "co_director", "leadership", 20),
          role("center", "member", "membership", 10),
          role("department", "chair", "leadership", 10),
        ],
      }),
    );
    expect(rows.map((r) => `${r.entityType}:${r.key}`)).toEqual([
      "center:director",
      "center:co_director",
      "center:member",
      "department:chair",
    ]);
  });

  it("sums leadership assignment counts into holderCount, keyed by (entityType, roleKey)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "director", "leadership", 10)],
        leadershipCounts: [{ entityType: "center", roleKey: "director", _count: { _all: 3 } }],
      }),
    );
    expect(rows[0].holderCount).toBe(3);
  });

  it("sums membership counts into holderCount, keyed by (roleEntityType, membershipRoleKey)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "research", "membership", 20)],
        membershipCounts: [
          { roleEntityType: "center", membershipRoleKey: "research", _count: { _all: 42 } },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(42);
  });

  it("adds BOTH sources together for a role that appears in each (a leader who is also a member)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "director", "leadership", 10)],
        leadershipCounts: [{ entityType: "center", roleKey: "director", _count: { _all: 1 } }],
        // Not realistic for `director` specifically, but exercises the sum —
        // the two sources are independent counts keyed the same way.
        membershipCounts: [
          { roleEntityType: "center", membershipRoleKey: "director", _count: { _all: 2 } },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(3);
  });

  it("a role with zero holders in either source reports holderCount 0, not undefined", async () => {
    const rows = await buildRoleRoster(
      makeDb({ roles: [role("center", "associate_director", "leadership", 30)] }),
    );
    expect(rows[0].holderCount).toBe(0);
  });

  it("ignores a membership groupBy bucket whose membershipRoleKey is null (no vocabulary entry to credit)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "member", "membership", 10)],
        membershipCounts: [
          { roleEntityType: "center", membershipRoleKey: null, _count: { _all: 7 } },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(0);
  });

  it("never mixes counts across entityType even when the key string matches", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [
          role("center", "director", "leadership", 10),
          role("department", "director", "leadership", 10),
        ],
        leadershipCounts: [{ entityType: "center", roleKey: "director", _count: { _all: 5 } }],
      }),
    );
    const center = rows.find((r) => r.entityType === "center")!;
    const department = rows.find((r) => r.entityType === "department")!;
    expect(center.holderCount).toBe(5);
    expect(department.holderCount).toBe(0);
  });

  it("projects every OrgUnitRole column onto the roster row", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [
          role("center", "co_director", "leadership", 20, {
            label: "Co-Director",
            scope: "unit",
            singleHolder: false,
            profileTitle: true,
            source: "manual",
          }),
        ],
      }),
    );
    expect(rows[0]).toEqual({
      key: "co_director",
      entityType: "center",
      label: "Co-Director",
      roleGroup: "leadership",
      scope: "unit",
      singleHolder: false,
      sortOrder: 20,
      profileTitle: true,
      source: "manual",
      holderCount: 0,
    });
  });
});
