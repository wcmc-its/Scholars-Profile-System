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

type AssignmentGroup = {
  entityType: string;
  roleKey: string;
  entityId: string;
  _count: { _all: number };
};
type MembershipGroup = {
  roleEntityType: string;
  membershipRoleKey: string | null;
  centerCode: string;
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
        leadershipCounts: [
          { entityType: "center", roleKey: "director", entityId: "ctr-1", _count: { _all: 3 } },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(3);
  });

  it("sums membership counts into holderCount, keyed by (roleEntityType, membershipRoleKey)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "research", "membership", 20)],
        membershipCounts: [
          {
            roleEntityType: "center",
            membershipRoleKey: "research",
            centerCode: "ctr-1",
            _count: { _all: 42 },
          },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(42);
  });

  it("adds BOTH sources together for a role that appears in each (a leader who is also a member)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "director", "leadership", 10)],
        leadershipCounts: [
          { entityType: "center", roleKey: "director", entityId: "ctr-1", _count: { _all: 1 } },
        ],
        // Not realistic for `director` specifically, but exercises the sum —
        // the two sources are independent counts keyed the same way.
        membershipCounts: [
          {
            roleEntityType: "center",
            membershipRoleKey: "director",
            centerCode: "ctr-1",
            _count: { _all: 2 },
          },
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
          {
            roleEntityType: "center",
            membershipRoleKey: null,
            centerCode: "ctr-1",
            _count: { _all: 7 },
          },
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
        leadershipCounts: [
          { entityType: "center", roleKey: "director", entityId: "ctr-1", _count: { _all: 5 } },
        ],
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
      unitCount: 0,
    });
  });

  // --- unitCount: the distinct-unit grain the confirm dialog needs alongside
  // holderCount, so "400 people across 3 centers" doesn't collapse into the
  // false "400 centers". Against the OLD single-count logic (no `unitCount`
  // field at all, `holderCount` unchanged) every `unitCount` assertion below
  // fails outright (`undefined` !== the expected number) — that is the
  // mutation proof: reverting the groupBy widening and the `unitsByKey`
  // tracking in `buildRoleRoster` breaks every one of these.

  it("a membership role spanning several units: holderCount sums people, unitCount counts distinct units (400-across-3 shape)", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "member", "membership", 10)],
        membershipCounts: [
          {
            roleEntityType: "center",
            membershipRoleKey: "member",
            centerCode: "ctr-1",
            _count: { _all: 250 },
          },
          {
            roleEntityType: "center",
            membershipRoleKey: "member",
            centerCode: "ctr-2",
            _count: { _all: 100 },
          },
          {
            roleEntityType: "center",
            membershipRoleKey: "member",
            centerCode: "ctr-3",
            _count: { _all: 50 },
          },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(400);
    expect(rows[0].unitCount).toBe(3);
  });

  it("a single-holder leadership role at one unit: holderCount and unitCount coincide at 1", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "director", "leadership", 10)],
        leadershipCounts: [
          { entityType: "center", roleKey: "director", entityId: "ctr-1", _count: { _all: 1 } },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(1);
    expect(rows[0].unitCount).toBe(1);
  });

  it("a role held by several people at the SAME single unit: unitCount is 1 while holderCount is not", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "co_director", "leadership", 20)],
        leadershipCounts: [
          { entityType: "center", roleKey: "co_director", entityId: "ctr-1", _count: { _all: 5 } },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(5);
    expect(rows[0].unitCount).toBe(1);
  });

  it("a role with zero holders reports unitCount 0, not undefined", async () => {
    const rows = await buildRoleRoster(
      makeDb({ roles: [role("center", "associate_director", "leadership", 30)] }),
    );
    expect(rows[0].unitCount).toBe(0);
  });

  it("counts a unit only once across multiple groupBy buckets for the same (entityType, role, unit) — leadership side", async () => {
    // Two different cwids at the same center still occupy one unit.
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "co_director", "leadership", 20)],
        leadershipCounts: [
          { entityType: "center", roleKey: "co_director", entityId: "ctr-1", _count: { _all: 1 } },
          { entityType: "center", roleKey: "co_director", entityId: "ctr-1", _count: { _all: 1 } },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(2);
    expect(rows[0].unitCount).toBe(1);
  });

  it("unions distinct units across BOTH sources for a role that appears in each", async () => {
    const rows = await buildRoleRoster(
      makeDb({
        roles: [role("center", "director", "leadership", 10)],
        leadershipCounts: [
          { entityType: "center", roleKey: "director", entityId: "ctr-1", _count: { _all: 1 } },
        ],
        membershipCounts: [
          {
            roleEntityType: "center",
            membershipRoleKey: "director",
            centerCode: "ctr-2",
            _count: { _all: 1 },
          },
        ],
      }),
    );
    expect(rows[0].holderCount).toBe(2);
    expect(rows[0].unitCount).toBe(2);
  });
});
