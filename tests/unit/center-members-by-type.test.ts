/**
 * #2537 — `getCenterMembersByType` (lib/api/centers.ts), the type-only (no
 * methods) filtered-roster loader for kind=center behind the uncacheable
 * `/api/units/[kind]/[code]/members` route. Mirrors
 * `getCenterMembersUncached`'s § 3.3 active-membership + #536/#2202/#2271
 * carve exactly, filtered further to one role-category group.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockCenterMembershipFindMany,
  mockScholarFindMany,
  mockPublicationTopicGroupBy,
  mockGrantFindMany,
  mockSuppressionFindMany,
  mockMeshSearch,
} = vi.hoisted(() => ({
  mockMeshSearch: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    centerMembership: { findMany: mockCenterMembershipFindMany },
    scholar: { findMany: mockScholarFindMany },
    publicationTopic: { groupBy: mockPublicationTopicGroupBy },
    publicationAuthor: { groupBy: vi.fn(async () => []) },
    grant: { findMany: mockGrantFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

// Unit Page v2 TOPICS chips — the loader reads `topMeshTerms` from the people
// index; mock the search client (no OpenSearch in unit tests).
vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  searchClient: () => ({ search: mockMeshSearch }),
}));

import { getCenterMembersByType, getCenterMembersFiltered } from "@/lib/api/centers";

const ACTIVE = { startDate: null, endDate: null };

function scholarRow(cwid: string, roleCategory: string, preferredName?: string) {
  return {
    cwid,
    preferredName: preferredName ?? cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    primaryDepartment: "Medicine",
    roleCategory,
    overview: null,
    professorialRank: null,
    department: null,
    division: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublicationTopicGroupBy.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockMeshSearch.mockResolvedValue({ body: { hits: { hits: [] } } });
});

describe("getCenterMembersByType", () => {
  it("filters active members by roleCategory: { in: groupToRawValues(...) }", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "fac001", membershipType: "research", ...ACTIVE },
      { cwid: "pd0002", membershipType: "research", ...ACTIVE },
    ]);
    // Unit Page v2 — the whole-roster index select (no `department` in the
    // select) is role-agnostic; the role group filters it in memory and the
    // page hydration re-applies it in SQL.
    mockScholarFindMany.mockImplementation(
      (args: { select?: { department?: unknown }; where?: { roleCategory?: { in?: string[] } } }) => {
        if (args.select?.department) {
          expect(args.where?.roleCategory?.in).toEqual(
            expect.arrayContaining(["FULL_TIME_FACULTY"]),
          );
          return Promise.resolve([scholarRow("fac001", "full_time_faculty")]);
        }
        expect(args.where?.roleCategory).toBeUndefined();
        return Promise.resolve([
          scholarRow("fac001", "full_time_faculty"),
          scholarRow("pd0002", "postdoc"),
        ]);
      },
    );

    const result = await getCenterMembersByType("MEYER", "Full-time faculty", 0);
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.cwid)).toEqual(["fac001"]);
    expect(result.hits[0].membershipType).toBe("research");
    expect(result.page).toBe(0);
    expect(result.pageSize).toBe(20);
  });

  it("returns empty for the 'All' sentinel — no raw values, never an unfiltered query", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([{ cwid: "a", ...ACTIVE }]);
    const result = await getCenterMembersByType("MEYER", "All", 0);
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("excludes lapsed/pending memberships (§ 3.3) before the type filter runs", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "live", membershipType: null, startDate: null, endDate: null },
      { cwid: "lapsed", membershipType: null, startDate: null, endDate: new Date("2000-01-01") },
    ]);
    mockScholarFindMany.mockImplementation((args: { where?: { cwid?: { in?: string[] } } }) => {
      expect(args.where?.cwid?.in).toEqual(["live"]);
      return Promise.resolve([scholarRow("live", "full_time_faculty")]);
    });

    const result = await getCenterMembersByType("MEYER", "Full-time faculty", 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["live"]);
  });

  it("carve: excludes an out-of-band suffixed doctoral-student role even when it clears the where-clause", async () => {
    // #2271 — publicRoleWhere() is a denylist; a suffix outside
    // HIDDEN_ROLE_CATEGORIES clears it, so isPubliclyDisplayed must ALSO run.
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "stu001", membershipType: null, ...ACTIVE },
    ]);
    // Even though this test asks for "Doctoral students" (whose raw values are
    // only DOCTORAL_STUDENT / doctoral_student), simulate the where-clause
    // admitting the suffixed row (as if it slipped the denylist) to prove the
    // in-memory isPubliclyDisplayed re-check is what actually drops it.
    mockScholarFindMany.mockResolvedValue([scholarRow("stu001", "doctoral_student_dvm")]);

    const result = await getCenterMembersByType("MEYER", "Doctoral students", 0);
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it("returns empty when the center has no active memberships", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([]);
    const result = await getCenterMembersByType("MEYER", "Full-time faculty", 0);
    expect(result.total).toBe(0);
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });

  it("CHPC fellows — surfaces a vocabulary membership-role label, but not for member/research keys", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      {
        cwid: "fac001",
        membershipType: null,
        membershipRoleKey: "core_faculty",
        roleVocabulary: { label: "Core Faculty Fellow" },
        ...ACTIVE,
      },
      {
        cwid: "fac002",
        membershipType: "research",
        membershipRoleKey: "research",
        roleVocabulary: { label: "Research" },
        ...ACTIVE,
      },
      {
        cwid: "fac003",
        membershipType: null,
        membershipRoleKey: "member",
        roleVocabulary: { label: "Member" },
        ...ACTIVE,
      },
    ]);
    mockScholarFindMany.mockResolvedValue([
      scholarRow("fac001", "full_time_faculty"),
      scholarRow("fac002", "full_time_faculty"),
      scholarRow("fac003", "full_time_faculty"),
    ]);

    const result = await getCenterMembersByType("CHPC", "Full-time faculty", 0);
    const byId = new Map(result.hits.map((h) => [h.cwid, h]));
    expect(byId.get("fac001")?.membershipRoleLabel).toBe("Core Faculty Fellow");
    expect(byId.get("fac001")?.membershipType).toBeNull();
    expect(byId.get("fac002")?.membershipRoleLabel).toBeNull();
    expect(byId.get("fac002")?.membershipType).toBe("research");
    expect(byId.get("fac003")?.membershipRoleLabel).toBeNull();
  });

  it("paginates 0-indexed, 20/page, ordered by surname (matching the SSR roster)", async () => {
    const cwids = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    mockCenterMembershipFindMany.mockResolvedValue(
      cwids.map((cwid) => ({ cwid, membershipType: null, ...ACTIVE })),
    );
    mockScholarFindMany.mockResolvedValue(cwids.map((c) => scholarRow(c, "full_time_faculty")));

    const page1 = await getCenterMembersByType("MEYER", "Full-time faculty", 1);
    expect(page1.total).toBe(25);
    expect(page1.page).toBe(1);
    expect(page1.hits).toHaveLength(5);
  });
});

describe("getCenterMembersFiltered — Unit Page v2 roster toolbar", () => {
  const ROWS = [
    scholarRow("c1", "full_time_faculty", "Amy Zimmer"),
    scholarRow("c2", "full_time_faculty", "Zed Adams"),
    scholarRow("c3", "postdoc", "José Moreno"),
  ];
  beforeEach(() => {
    mockCenterMembershipFindMany.mockResolvedValue(
      ROWS.map((r) => ({ cwid: r.cwid, membershipType: "research", ...ACTIVE })),
    );
    mockScholarFindMany.mockImplementation((args: { where: { cwid: { in: string[] } } }) =>
      Promise.resolve(ROWS.filter((r) => args.where.cwid.in.includes(r.cwid))),
    );
  });

  it("no role group: every active member, surname A–Z by default", async () => {
    const result = await getCenterMembersFiltered("MEYER", {}, 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["c2", "c3", "c1"]);
    expect(result.total).toBe(3);
    expect(result.roleCategoryCounts).toEqual({ "Full-time faculty": 2, Postdoc: 1 });
  });

  it("sort=grants ranks by the (suppression-aware) grant count", async () => {
    mockGrantFindMany.mockResolvedValue([
      { cwid: "c1", externalId: "G1", id: "1" },
      { cwid: "c1", externalId: "G2", id: "2" },
      { cwid: "c3", externalId: "G3", id: "3" },
    ]);
    const result = await getCenterMembersFiltered("MEYER", { sort: "grants" }, 0);
    expect(result.hits.map((h) => [h.cwid, h.grantCount])).toEqual([
      ["c1", 2],
      ["c3", 1],
      ["c2", 0],
    ]);
  });

  it("q is accent-blind and narrows the Appointment counts before the role group", async () => {
    const result = await getCenterMembersFiltered(
      "MEYER",
      { q: "jose", roleGroup: "Full-time faculty" },
      0,
    );
    expect(result.total).toBe(0);
    expect(result.roleCategoryCounts).toEqual({ Postdoc: 1 });
    const all = await getCenterMembersFiltered("MEYER", { q: "MORENO" }, 0);
    expect(all.hits.map((h) => h.cwid)).toEqual(["c3"]);
  });

  it("the deprecated wrapper forwards to the same loader", async () => {
    const result = await getCenterMembersByType("MEYER", "Postdocs & non-faculty", 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["c3"]);
  });
});

describe("getCenterMembersFiltered — Unit Page v2 TOPICS chips", () => {
  // Distinct cwids from the suites above: the MeSH lookup is cachedRead-keyed
  // on the page's cwid set.
  const ROWS = [
    scholarRow("m1", "full_time_faculty", "Ann Able"),
    scholarRow("m2", "full_time_faculty", "Bea Baker"),
  ];
  beforeEach(() => {
    mockCenterMembershipFindMany.mockResolvedValue(
      ROWS.map((r) => ({ cwid: r.cwid, membershipType: "research", ...ACTIVE })),
    );
    mockScholarFindMany.mockImplementation((args: { where: { cwid: { in: string[] } } }) =>
      Promise.resolve(ROWS.filter((r) => args.where.cwid.in.includes(r.cwid))),
    );
  });

  it("attaches `topMesh` from ONE ids query over the page's cwids", async () => {
    mockMeshSearch.mockResolvedValue({
      body: {
        hits: {
          hits: [{ _id: "m1", _source: { topMeshTerms: [{ ui: "D000001", label: "Alpha" }] } }],
        },
      },
    });
    const result = await getCenterMembersFiltered("MESHCTR", {}, 0);
    expect(mockMeshSearch).toHaveBeenCalledTimes(1);
    const req = mockMeshSearch.mock.calls[0][0] as {
      body: { query: { ids: { values: string[] } } };
    };
    expect([...req.body.query.ids.values].sort()).toEqual(["m1", "m2"]);
    const byCwid = new Map(result.hits.map((h) => [h.cwid, h]));
    expect(byCwid.get("m1")?.topMesh).toEqual([{ ui: "D000001", label: "Alpha" }]);
    expect(byCwid.get("m2")).not.toHaveProperty("topMesh");
  });

  it("an OpenSearch failure still returns the page, without chips", async () => {
    // A different cwid set from the test above, so the lookup is not a cache hit.
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "m2", membershipType: "research", ...ACTIVE },
    ]);
    mockMeshSearch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getCenterMembersFiltered("MESHCTR", {}, 0);
    expect(result.hits.map((h) => h.cwid)).toEqual(["m2"]);
    expect(result.hits[0]).not.toHaveProperty("topMesh");
    warn.mockRestore();
  });
});
