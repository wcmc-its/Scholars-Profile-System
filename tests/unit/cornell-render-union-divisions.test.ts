/**
 * #2519 PR 2 — the division render union (`lib/api/divisions.ts`): a Cornell
 * (Ithaca) `source: "cornell-ithaca"` `DivisionMembership` row on a
 * `source: "manual"` division renders inline with WCM faculty when
 * `CORNELL_DIRECTORY_MEMBERS` is on, and disappears entirely (query + render)
 * when the flag is off — mirroring `cornell-render-union-centers.test.ts`.
 *
 * Mocks `@/lib/db` and `@/lib/edit/cornell-directory-flag` — no network/DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  divisionFindFirst,
  divisionFindMany,
  departmentFindUnique,
  scholarFindMany,
  scholarGroupBy,
  scholarCount,
  publicationAuthorGroupBy,
  grantGroupBy,
  publicationCount,
  suppressionFindMany,
  suppressionFindFirst,
  fieldOverrideFindMany,
  queryRawUnsafeMock,
  divisionMembershipFindMany,
  divisionMembershipCount,
  externalMemberFindMany,
  isCornellDirectoryMembersEnabledMock,
  orgUnitRoleFindUnique,
  orgUnitRoleAssignmentFindFirst,
} = vi.hoisted(() => ({
  divisionFindFirst: vi.fn(),
  divisionFindMany: vi.fn(async () => []),
  departmentFindUnique: vi.fn(),
  scholarFindMany: vi.fn(),
  scholarGroupBy: vi.fn(),
  scholarCount: vi.fn(),
  publicationAuthorGroupBy: vi.fn(),
  grantGroupBy: vi.fn(),
  publicationCount: vi.fn(async () => 0),
  suppressionFindMany: vi.fn(),
  suppressionFindFirst: vi.fn(async () => null),
  fieldOverrideFindMany: vi.fn(async () => []),
  queryRawUnsafeMock: vi.fn(async () => []),
  divisionMembershipFindMany: vi.fn(),
  divisionMembershipCount: vi.fn(async () => 0),
  externalMemberFindMany: vi.fn(),
  isCornellDirectoryMembersEnabledMock: vi.fn(() => false),
  orgUnitRoleFindUnique: vi.fn(async () => null),
  orgUnitRoleAssignmentFindFirst: vi.fn(async () => null),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: departmentFindUnique },
    division: { findFirst: divisionFindFirst, findMany: divisionFindMany },
    scholar: {
      findMany: scholarFindMany,
      groupBy: scholarGroupBy,
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      count: scholarCount,
    },
    divisionMembership: { findMany: divisionMembershipFindMany, count: divisionMembershipCount },
    publicationAuthor: { groupBy: publicationAuthorGroupBy },
    publication: { count: publicationCount },
    grant: { groupBy: grantGroupBy },
    externalMember: { findMany: externalMemberFindMany },
    suppression: { findMany: suppressionFindMany, findFirst: suppressionFindFirst },
    fieldOverride: { findMany: fieldOverrideFindMany },
    orgUnitRole: { findUnique: orgUnitRoleFindUnique },
    orgUnitRoleAssignment: { findFirst: orgUnitRoleAssignmentFindFirst },
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

vi.mock("@/lib/edit/cornell-directory-flag", () => ({
  isCornellDirectoryMembersEnabled: isCornellDirectoryMembersEnabledMock,
}));

// #2519 — `getDivisionUncached`'s grant-count leg (`loadUnitGrantProjects`) is
// unrelated to the render-union/headline-count behavior under test here; stub
// it so the stats test doesn't also have to fake its own query surface.
vi.mock("@/lib/api/unit-grant-projects", () => ({
  loadUnitGrantProjects: vi.fn(async () => []),
  buildUnitGrantCards: vi.fn(async () => []),
}));

import { getDivision, getDivisionFaculty } from "@/lib/api/divisions";

const WCM_SCHOLAR = {
  cwid: "wcm001",
  preferredName: "Wendy Cwm",
  slug: "wendy-cwm",
  primaryTitle: null,
  overview: null,
  roleCategory: "full_time_faculty",
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
  scholarGroupBy.mockResolvedValue([]);
  publicationAuthorGroupBy.mockResolvedValue([]);
  grantGroupBy.mockResolvedValue([]);
  suppressionFindMany.mockResolvedValue([]);

  // One `DivisionMembership` fixture: `wcm001` (manual roster) + `ab123`
  // (cornell-ithaca). The unfiltered call (`loadDivisionMemberCwids`) sees
  // both; the source-filtered call (this PR's cornell block) sees only ab123.
  divisionMembershipFindMany.mockImplementation(
    (args: { where?: { source?: string } }) => {
      const rows = [
        { cwid: "wcm001", source: "manual-ui" },
        { cwid: "ab123", source: "cornell-ithaca" },
      ];
      return Promise.resolve(
        (args?.where?.source ? rows.filter((r) => r.source === args.where!.source) : rows).map(
          (r) => ({ cwid: r.cwid }),
        ),
      );
    },
  );

  scholarFindMany.mockImplementation(
    (args: {
      where?: { divCode?: string; cwid?: { in?: string[] } };
      select?: Record<string, unknown>;
      include?: Record<string, unknown>;
    }) => {
      const where = args?.where ?? {};
      if (where.divCode !== undefined) {
        // No LDAP-attached scholar for this (manual) division in the test.
        return Promise.resolve([]);
      }
      const inCwids = where.cwid?.in ?? [];
      const matches = inCwids.includes(WCM_SCHOLAR.cwid) ? [WCM_SCHOLAR] : [];
      if (args?.include) {
        return Promise.resolve(
          matches.map((s) => ({ ...s, department: null, division: null })),
        );
      }
      const keys = Object.keys(args?.select ?? {});
      if (keys.length === 1 && keys[0] === "cwid") {
        return Promise.resolve(matches.map((s) => ({ cwid: s.cwid })));
      }
      return Promise.resolve(matches);
    },
  );
});

describe("division render union — flag ON", () => {
  beforeEach(() => isCornellDirectoryMembersEnabledMock.mockReturnValue(true));

  it("renders both the WCM faculty member and the Cornell member, the external one marked and slugless", async () => {
    divisionFindFirst.mockResolvedValue({ chiefCwid: null, source: "manual" });

    const result = await getDivisionFaculty("TEST_DIV_UNION_ON", {});
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

  it("interleaves the Cornell member with WCM faculty by surname, not appended after them", async () => {
    divisionFindFirst.mockResolvedValue({ chiefCwid: null, source: "manual" });

    // Second WCM scholar whose surname ("Aaron") sorts BEFORE the Cornell
    // member's ("Byron"); `WCM_SCHOLAR`'s surname ("Cwm") already sorts after
    // it — together the expected order (Aaron, Byron, Cwm) can only come from
    // a real surname merge, not a "WCM rows then Cornell rows" concatenation.
    const WCM_SCHOLAR_2 = {
      cwid: "wcm002",
      preferredName: "Anna Aaron",
      slug: "anna-aaron",
      primaryTitle: null,
      overview: null,
      roleCategory: "full_time_faculty",
    };

    divisionMembershipFindMany.mockImplementation(
      (args: { where?: { source?: string } }) => {
        const rows = [
          { cwid: "wcm001", source: "manual-ui" },
          { cwid: "wcm002", source: "manual-ui" },
          { cwid: "ab123", source: "cornell-ithaca" },
        ];
        return Promise.resolve(
          (args?.where?.source ? rows.filter((r) => r.source === args.where!.source) : rows).map(
            (r) => ({ cwid: r.cwid }),
          ),
        );
      },
    );

    scholarFindMany.mockImplementation(
      (args: {
        where?: { divCode?: string; cwid?: { in?: string[] } };
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
      }) => {
        const where = args?.where ?? {};
        if (where.divCode !== undefined) return Promise.resolve([]);
        const inCwids = where.cwid?.in ?? [];
        const matches = [WCM_SCHOLAR, WCM_SCHOLAR_2].filter((s) => inCwids.includes(s.cwid));
        if (args?.include) {
          return Promise.resolve(
            matches.map((s) => ({ ...s, department: null, division: null })),
          );
        }
        const keys = Object.keys(args?.select ?? {});
        if (keys.length === 1 && keys[0] === "cwid") {
          return Promise.resolve(matches.map((s) => ({ cwid: s.cwid })));
        }
        return Promise.resolve(matches);
      },
    );

    const result = await getDivisionFaculty("TEST_DIV_INTERLEAVE", {});
    expect(result.hits.map((h) => h.preferredName)).toEqual([
      "Anna Aaron",
      "Ada Byron",
      "Wendy Cwm",
    ]);
  });
});

describe("division render union — flag OFF", () => {
  it("drops the Cornell member entirely — render stays byte-identical to today", async () => {
    isCornellDirectoryMembersEnabledMock.mockReturnValue(false);
    divisionFindFirst.mockResolvedValue({ chiefCwid: null, source: "manual" });

    const result = await getDivisionFaculty("TEST_DIV_UNION_OFF", {});
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.cwid)).toEqual(["wcm001"]);
    expect(externalMemberFindMany).not.toHaveBeenCalled();
  });
});

describe("division headline count (getDivisionUncached stats.scholars)", () => {
  // getDivisionUncached's own query surface — dept/division lookup, override
  // merge, sibling divisions, top-research-areas — beyond what the shared
  // `beforeEach` above already fakes for the roster path.
  beforeEach(() => {
    departmentFindUnique.mockResolvedValue({ code: "MED", name: "Medicine", slug: "medicine" });
    suppressionFindFirst.mockResolvedValue(null); // not whole-unit-suppressed
    fieldOverrideFindMany.mockResolvedValue([]); // no curator overrides
    divisionFindMany.mockResolvedValue([]); // sibling divisions — irrelevant here
    queryRawUnsafeMock.mockResolvedValue([]); // top-research-areas topic counts
    publicationCount.mockResolvedValue(0);
    scholarCount.mockImplementation(
      async (args: { where?: { cwid?: { in?: string[] } } }) => args?.where?.cwid?.in?.length ?? 0,
    );
  });

  it("flag ON: the headline count includes the active Cornell member", async () => {
    isCornellDirectoryMembersEnabledMock.mockReturnValue(true);
    divisionFindFirst.mockImplementation((args: { where?: { deptCode?: string } }) =>
      args?.where?.deptCode !== undefined
        ? Promise.resolve({
            code: "TEST_DIV_HEADLINE_ON",
            name: "Test Division",
            slug: "cardio-headline-on",
            deptCode: "MED",
            description: null,
            url: null,
            chiefCwid: null,
            source: "manual",
          })
        : Promise.resolve({ source: "manual" }),
    );
    divisionMembershipCount.mockResolvedValue(1); // the one cornell-ithaca row (ab123)

    const detail = await getDivision("medicine", "cardio-headline-on");
    // 1 WCM (wcm001) + 1 Cornell external member (ab123).
    expect(detail!.stats.scholars).toBe(2);
  });

  it("flag OFF: the headline count excludes the Cornell member entirely", async () => {
    isCornellDirectoryMembersEnabledMock.mockReturnValue(false);
    divisionFindFirst.mockImplementation((args: { where?: { deptCode?: string } }) =>
      args?.where?.deptCode !== undefined
        ? Promise.resolve({
            code: "TEST_DIV_HEADLINE_OFF",
            name: "Test Division",
            slug: "cardio-headline-off",
            deptCode: "MED",
            description: null,
            url: null,
            chiefCwid: null,
            source: "manual",
          })
        : Promise.resolve({ source: "manual" }),
    );

    const detail = await getDivision("medicine", "cardio-headline-off");
    expect(detail!.stats.scholars).toBe(1);
    expect(divisionMembershipCount).not.toHaveBeenCalled();
  });
});
