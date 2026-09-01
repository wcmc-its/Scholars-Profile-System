/**
 * #2519 PR 2 — the center render union (`lib/api/centers.ts`): a Cornell
 * (Ithaca) `source: "cornell-ithaca"` `CenterMembership` row renders inline
 * with WCM members when `CORNELL_DIRECTORY_MEMBERS` is on, is counted in the
 * headline `scholarCount`, and disappears entirely (query + render + count)
 * when the flag is off.
 *
 * Mocks `@/lib/db` and `@/lib/edit/cornell-directory-flag` — no network/DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  centerFindUnique,
  scholarFindMany,
  membershipFindMany,
  externalMemberFindMany,
  isCornellDirectoryMembersEnabledMock,
} = vi.hoisted(() => ({
  centerFindUnique: vi.fn(),
  scholarFindMany: vi.fn(),
  membershipFindMany: vi.fn(),
  externalMemberFindMany: vi.fn(),
  isCornellDirectoryMembersEnabledMock: vi.fn(() => false),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    center: { findUnique: centerFindUnique },
    // #2542 — leadership is an `OrgUnitRoleAssignment` row fetched with its own
    // query; it used to be a nested `leaders` relation on `center`.
    orgUnitRoleAssignment: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    scholar: { findMany: scholarFindMany, findUnique: vi.fn(async () => null) },
    centerMembership: { findMany: membershipFindMany },
    centerProgram: { findMany: vi.fn(async () => []) },
    publicationTopic: { groupBy: vi.fn(async () => []) },
    grant: { findMany: vi.fn(async () => []) },
    externalMember: { findMany: externalMemberFindMany },
    suppression: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/edit/cornell-directory-flag", () => ({
  isCornellDirectoryMembersEnabled: isCornellDirectoryMembersEnabledMock,
}));

import { getCenter, getCenterMembers } from "@/lib/api/centers";

const WCM_ROW = {
  cwid: "wcm001",
  membershipType: null,
  programCode: null,
  startDate: null,
  endDate: null,
  source: "manual",
};
const CORNELL_ROW = {
  cwid: "ab123",
  membershipType: null,
  programCode: null,
  startDate: null,
  endDate: null,
  source: "cornell-ithaca",
};

const WCM_SCHOLAR = {
  cwid: "wcm001",
  preferredName: "Wendy Cwm",
  slug: "wendy-cwm",
  primaryTitle: null,
  primaryDepartment: null,
  roleCategory: "full_time_faculty",
  overview: null,
  professorialRank: null,
  department: null,
  division: null,
};

const EXTERNAL_MEMBER = {
  cuid: "ab123",
  displayName: "Ada Byron",
  givenName: "Ada",
  familyName: "Byron",
  title: "Research Associate",
  dept: "Computer Science",
  email: "ab123@cornell.edu",
  affiliation: "staff",
  source: "cornell-ithaca",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

beforeEach(() => {
  vi.clearAllMocks();
  isCornellDirectoryMembersEnabledMock.mockReturnValue(false);
  externalMemberFindMany.mockResolvedValue([EXTERNAL_MEMBER]);

  // ONE membership fixture used by every query site: the roster query reads
  // ALL rows (no `where.source`); the headline-count query filters by
  // `where.source: "cornell-ithaca"` — branch on that to simulate both.
  membershipFindMany.mockImplementation((args: { where?: { source?: string } }) => {
    const rows = [WCM_ROW, CORNELL_ROW];
    return Promise.resolve(
      args?.where?.source ? rows.filter((r) => r.source === args.where!.source) : rows,
    );
  });

  scholarFindMany.mockImplementation((args: { where?: { cwid?: { in?: string[] } }; select?: Record<string, unknown> }) => {
    const inCwids = args?.where?.cwid?.in ?? [];
    const matches = inCwids.includes(WCM_SCHOLAR.cwid) ? [WCM_SCHOLAR] : [];
    const keys = Object.keys(args?.select ?? {});
    if (keys.length === 1 && keys[0] === "cwid") {
      return Promise.resolve(matches.map((s) => ({ cwid: s.cwid })));
    }
    if (keys.length === 1 && keys[0] === "roleCategory") {
      return Promise.resolve(matches.map((s) => ({ roleCategory: s.roleCategory })));
    }
    return Promise.resolve(matches);
  });
});

describe("center render union — flag ON", () => {
  beforeEach(() => isCornellDirectoryMembersEnabledMock.mockReturnValue(true));

  it("renders both the WCM member and the Cornell member, the external one marked and slugless", async () => {
    centerFindUnique.mockResolvedValue({
      code: "TEST_CENTER_UNION_ON",
      name: "Test Center",
      slug: "test-center-union-on",
      description: null,
      url: null,
      // #2542 — the director is an `OrgUnitRoleAssignment` row with roleKey
      // 'director'; an empty array is "no director", and the columns are the
      // dual-read fallback, also empty here.
      leaders: [],
      directorCwid: null,
      leaderInterim: false,
    });

    const result = await getCenterMembers("TEST_CENTER_UNION_ON", {});
    expect(result.mode).toBe("flat");
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.total).toBe(2);
    const byCwid = new Map(result.hits.map((h) => [h.cwid, h]));
    expect(byCwid.get("wcm001")?.isExternal).toBeUndefined();
    expect(byCwid.get("wcm001")).toMatchObject({ slug: "wendy-cwm" });
    expect(byCwid.get("ab123")).toMatchObject({
      isExternal: true,
      slug: "",
      externalProfileUrl: "https://www.cornell.edu/search/sso/people.cfm?netid=ab123",
    });
  });

  it("adds the Cornell member into the headline scholarCount", async () => {
    centerFindUnique.mockResolvedValue({
      code: "TEST_CENTER_UNION_ON_HERO",
      name: "Test Center",
      slug: "test-center-union-on-hero",
      description: null,
      url: null,
      // #2542 — the director is an `OrgUnitRoleAssignment` row with roleKey
      // 'director'; an empty array is "no director", and the columns are the
      // dual-read fallback, also empty here.
      leaders: [],
      directorCwid: null,
      leaderInterim: false,
    });

    const center = await getCenter("test-center-union-on-hero");
    // 1 WCM (publicly displayed) + 1 Cornell external member.
    expect(center!.scholarCount).toBe(2);
  });
});

describe("center render union — flag OFF", () => {
  it("drops the Cornell member entirely — render stays byte-identical to today", async () => {
    isCornellDirectoryMembersEnabledMock.mockReturnValue(false);
    centerFindUnique.mockResolvedValue({
      code: "TEST_CENTER_UNION_OFF",
      name: "Test Center",
      slug: "test-center-union-off",
      description: null,
      url: null,
      // #2542 — the director is an `OrgUnitRoleAssignment` row with roleKey
      // 'director'; an empty array is "no director", and the columns are the
      // dual-read fallback, also empty here.
      leaders: [],
      directorCwid: null,
      leaderInterim: false,
    });

    const result = await getCenterMembers("TEST_CENTER_UNION_OFF", {});
    expect(result.mode).toBe("flat");
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.cwid)).toEqual(["wcm001"]);
    expect(externalMemberFindMany).not.toHaveBeenCalled();
  });

  it("does not add the Cornell member to the headline scholarCount", async () => {
    isCornellDirectoryMembersEnabledMock.mockReturnValue(false);
    centerFindUnique.mockResolvedValue({
      code: "TEST_CENTER_UNION_OFF_HERO",
      name: "Test Center",
      slug: "test-center-union-off-hero",
      description: null,
      url: null,
      // #2542 — the director is an `OrgUnitRoleAssignment` row with roleKey
      // 'director'; an empty array is "no director", and the columns are the
      // dual-read fallback, also empty here.
      leaders: [],
      directorCwid: null,
      leaderInterim: false,
    });

    const center = await getCenter("test-center-union-off-hero");
    expect(center!.scholarCount).toBe(1);
  });
});
