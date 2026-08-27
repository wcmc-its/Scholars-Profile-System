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
  scholarFindMany,
  scholarGroupBy,
  publicationAuthorGroupBy,
  grantGroupBy,
  suppressionFindMany,
  divisionMembershipFindMany,
  externalMemberFindMany,
  isCornellDirectoryMembersEnabledMock,
} = vi.hoisted(() => ({
  divisionFindFirst: vi.fn(),
  scholarFindMany: vi.fn(),
  scholarGroupBy: vi.fn(),
  publicationAuthorGroupBy: vi.fn(),
  grantGroupBy: vi.fn(),
  suppressionFindMany: vi.fn(),
  divisionMembershipFindMany: vi.fn(),
  externalMemberFindMany: vi.fn(),
  isCornellDirectoryMembersEnabledMock: vi.fn(() => false),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    division: { findFirst: divisionFindFirst },
    scholar: {
      findMany: scholarFindMany,
      groupBy: scholarGroupBy,
      findFirst: vi.fn(async () => null),
    },
    divisionMembership: { findMany: divisionMembershipFindMany },
    publicationAuthor: { groupBy: publicationAuthorGroupBy },
    grant: { groupBy: grantGroupBy },
    externalMember: { findMany: externalMemberFindMany },
    suppression: { findMany: suppressionFindMany },
  },
}));

vi.mock("@/lib/edit/cornell-directory-flag", () => ({
  isCornellDirectoryMembersEnabled: isCornellDirectoryMembersEnabledMock,
}));

import { getDivisionFaculty } from "@/lib/api/divisions";

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
