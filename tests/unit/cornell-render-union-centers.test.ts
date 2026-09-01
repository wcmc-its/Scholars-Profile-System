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

import { getCenter, getCenterMembers, getCenterMembersByType } from "@/lib/api/centers";

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
    // Chip-partition parity — the Cornell external member has no
    // `roleCategory` label of its own, but it's tallied into "Affiliated
    // faculty" so `roleCategoryCounts` sums to `total` (1 WCM + 1 external).
    expect(result.roleCategoryCounts).toEqual({
      "Full-time faculty": 1,
      "Affiliated faculty": 1,
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

describe("center render union — getCenterMembersByType", () => {
  // A second WCM scholar in the "Affiliated faculty" chip group, surname
  // "Ztest" — sorts AFTER the Cornell external "Ada Byron" (surname "Byron"),
  // so the merge-then-sort order is actually exercised, not just "external
  // always first/last".
  const AFFILIATED_SCHOLAR = {
    cwid: "wcm002",
    preferredName: "Alice Ztest",
    slug: "alice-ztest",
    primaryTitle: null,
    primaryDepartment: null,
    roleCategory: "affiliated_faculty",
    overview: null,
    professorialRank: null,
    department: null,
    division: null,
  };
  const AFFILIATED_ROW = {
    cwid: "wcm002",
    membershipType: null,
    programCode: null,
    startDate: null,
    endDate: null,
    source: "manual",
  };

  beforeEach(() => {
    isCornellDirectoryMembersEnabledMock.mockReturnValue(true);
    membershipFindMany.mockImplementation(() =>
      Promise.resolve([WCM_ROW, AFFILIATED_ROW, CORNELL_ROW]),
    );
    scholarFindMany.mockImplementation(
      (args: { where?: { roleCategory?: { in?: string[] } } }) => {
        const rawValues = args?.where?.roleCategory?.in ?? [];
        const rows = [WCM_SCHOLAR, AFFILIATED_SCHOLAR].filter((s) =>
          rawValues.includes(s.roleCategory),
        );
        return Promise.resolve(rows);
      },
    );
  });

  it("'Affiliated faculty' includes the Cornell external member, sorted by surname among WCM rows, total counts it", async () => {
    const result = await getCenterMembersByType("TEST_CENTER_BY_TYPE", "Affiliated faculty", 0);
    expect(result.total).toBe(2);
    // "Byron" < "Ztest" — the external member sorts in by surname, not appended.
    expect(result.hits.map((h) => h.cwid)).toEqual(["ab123", "wcm002"]);
    expect(result.hits.find((h) => h.cwid === "ab123")).toMatchObject({
      isExternal: true,
      slug: "",
    });
  });

  it("'Full-time faculty' does not include the Cornell external member", async () => {
    const result = await getCenterMembersByType("TEST_CENTER_BY_TYPE", "Full-time faculty", 0);
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.cwid)).toEqual(["wcm001"]);
    expect(result.hits.some((h) => h.isExternal)).toBe(false);
  });
});

describe("center render union — getCenterMembersByType — pagination across a page boundary with an interleaved external", () => {
  // 25 WCM "affiliated_faculty" scholars split so the Cornell external's
  // surname ("Tremaine") sorts strictly between them: 19 surnames < "tremaine"
  // (the "Aaa*" block) and 6 surnames > "tremaine" (the "Zzz*" block).
  // Merged + surname-sorted, the external lands at index 19 (the last slot of
  // page 0, 0-indexed, 20/page) and the 6 "Zzz*" rows spill onto page 1 —
  // exercising the boundary a slice-then-merge bug would get wrong.
  const LOW_COUNT = 19;
  const HIGH_COUNT = 6;

  function pageScholar(cwid: string, surname: string) {
    return {
      cwid,
      preferredName: `Scholar ${surname}`,
      slug: cwid,
      primaryTitle: null,
      primaryDepartment: null,
      roleCategory: "affiliated_faculty",
      overview: null,
      professorialRank: null,
      department: null,
      division: null,
    };
  }
  const LOW_SCHOLARS = Array.from({ length: LOW_COUNT }, (_, i) =>
    pageScholar(`wlo${String(i).padStart(2, "0")}`, `Aaa${String(i).padStart(2, "0")}`),
  );
  const HIGH_SCHOLARS = Array.from({ length: HIGH_COUNT }, (_, i) =>
    pageScholar(`whi${String(i).padStart(2, "0")}`, `Zzz${String(i).padStart(2, "0")}`),
  );
  const PAGE_WCM_SCHOLARS = [...LOW_SCHOLARS, ...HIGH_SCHOLARS];

  const PAGE_EXTERNAL_CUID = "nt001";
  const PAGE_EXTERNAL_MEMBER = {
    cuid: PAGE_EXTERNAL_CUID,
    displayName: "Tabitha Tremaine",
    givenName: "Tabitha",
    familyName: "Tremaine",
    title: "Research Associate",
    dept: "Computer Science",
    email: "nt001@cornell.edu",
    affiliation: "staff",
    source: "cornell-ithaca",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  beforeEach(() => {
    isCornellDirectoryMembersEnabledMock.mockReturnValue(true);
    membershipFindMany.mockImplementation(() =>
      Promise.resolve([
        ...PAGE_WCM_SCHOLARS.map((s) => ({
          cwid: s.cwid,
          membershipType: null,
          programCode: null,
          startDate: null,
          endDate: null,
          source: "manual",
        })),
        {
          cwid: PAGE_EXTERNAL_CUID,
          membershipType: null,
          programCode: null,
          startDate: null,
          endDate: null,
          source: "cornell-ithaca",
        },
      ]),
    );
    scholarFindMany.mockImplementation(
      (args: { where?: { roleCategory?: { in?: string[] } } }) => {
        const rawValues = args?.where?.roleCategory?.in ?? [];
        return Promise.resolve(
          PAGE_WCM_SCHOLARS.filter((s) => rawValues.includes(s.roleCategory)),
        );
      },
    );
    externalMemberFindMany.mockResolvedValue([PAGE_EXTERNAL_MEMBER]);
  });

  it("page 0 ends with the external at index 19, page 1 gets the remaining 6, total is 26 on both pages", async () => {
    const page0 = await getCenterMembersByType(
      "TEST_CENTER_PAGE_BOUNDARY",
      "Affiliated faculty",
      0,
    );
    expect(page0.hits).toHaveLength(20);
    expect(page0.total).toBe(26);
    expect(page0.pageSize).toBe(20);
    expect(page0.hits[19].cwid).toBe(PAGE_EXTERNAL_CUID);
    expect(page0.hits[19]).toMatchObject({ isExternal: true });

    const page1 = await getCenterMembersByType(
      "TEST_CENTER_PAGE_BOUNDARY",
      "Affiliated faculty",
      1,
    );
    expect(page1.hits).toHaveLength(6);
    expect(page1.total).toBe(26);
    expect(page1.pageSize).toBe(20);
    expect(page1.hits.every((h) => !h.isExternal)).toBe(true);
  });

  it("'Full-time faculty' on the same fixture never calls the externalMember mock", async () => {
    externalMemberFindMany.mockClear();
    const result = await getCenterMembersByType(
      "TEST_CENTER_PAGE_BOUNDARY",
      "Full-time faculty",
      0,
    );
    expect(result.total).toBe(0);
    expect(externalMemberFindMany).not.toHaveBeenCalled();
  });
});
