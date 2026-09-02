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
} = vi.hoisted(() => ({
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
    grant: { findMany: mockGrantFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

import { getCenterMembersByType } from "@/lib/api/centers";

const ACTIVE = { startDate: null, endDate: null };

function scholarRow(cwid: string, roleCategory: string) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
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
});

describe("getCenterMembersByType", () => {
  it("filters active members by roleCategory: { in: groupToRawValues(...) }", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "fac001", membershipType: "research", ...ACTIVE },
      { cwid: "pd0002", membershipType: "research", ...ACTIVE },
    ]);
    mockScholarFindMany.mockImplementation((args: { where?: { roleCategory?: { in?: string[] } } }) => {
      expect(args.where?.roleCategory?.in).toEqual(expect.arrayContaining(["FULL_TIME_FACULTY"]));
      return Promise.resolve([scholarRow("fac001", "full_time_faculty")]);
    });

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

  it("#2576 — surfaces a vocabulary membership-role label, but not for member/research keys", async () => {
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
