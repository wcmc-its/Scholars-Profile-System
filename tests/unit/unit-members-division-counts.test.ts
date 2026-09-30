/**
 * Unit Page v2 — `getDepartmentDivisionMemberCounts` (lib/api/unit-members.ts).
 *
 * The public per-division counts behind a department page's hero division
 * chips and roster Division facet. They must agree with the Division facet
 * filter in `getUnitMembersFiltered`: dept public members (`publicRoleWhere`)
 * ∩ `loadDivisionMemberCwids` (LDAP divCode ∪ manual roster for a manual
 * division) — NOT the ETL's `Division.scholarCount`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockScholarFindMany, mockDivisionFindMany, mockMembershipFindMany } = vi.hoisted(
  () => ({
    mockScholarFindMany: vi.fn(),
    mockDivisionFindMany: vi.fn(),
    mockMembershipFindMany: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: mockScholarFindMany },
    division: { findMany: mockDivisionFindMany },
    divisionMembership: { findMany: mockMembershipFindMany },
  },
}));
vi.mock("@/lib/api/swr-cache", () => ({
  cachedRead: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/api/divisions", () => ({ loadDivisionMemberCwids: vi.fn() }));

import { getDepartmentDivisionMemberCounts } from "@/lib/api/unit-members";
import { publicRoleWhere } from "@/lib/eligibility";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDepartmentDivisionMemberCounts", () => {
  it("counts dept public members per division, unioning a manual division's roster", async () => {
    // The scholar query is the dept public-member set (publicRoleWhere-gated),
    // so a hidden/student member never reaches the counts.
    mockScholarFindMany.mockResolvedValue([
      { cwid: "a", divCode: "CARD" },
      { cwid: "b", divCode: "CARD" },
      { cwid: "c", divCode: "GI" },
      { cwid: "d", divCode: null },
      // divCode outside this dept's divisions — never counted.
      { cwid: "e", divCode: "OTHER_DEPT_DIV" },
    ]);
    mockDivisionFindMany.mockResolvedValue([
      { code: "CARD", source: "ED" },
      { code: "GI", source: "manual" },
      { code: "EMPTY", source: "ED" },
    ]);
    // Manual GI roster: "c" is also its LDAP member (counts once); "d" is a
    // manual-only dept member.
    mockMembershipFindMany.mockResolvedValue([
      { divisionCode: "GI", cwid: "c" },
      { divisionCode: "GI", cwid: "d" },
    ]);

    const counts = await getDepartmentDivisionMemberCounts("MED");

    expect(Object.fromEntries(counts)).toEqual({ CARD: 2, GI: 2 });
    expect(counts.has("EMPTY")).toBe(false);

    const scholarWhere = mockScholarFindMany.mock.calls[0][0].where;
    expect(scholarWhere).toMatchObject({
      deptCode: "MED",
      deletedAt: null,
      status: "active",
      ...publicRoleWhere(),
    });
    // Manual roster read is limited to manual divisions AND dept public
    // members, so a non-public / other-dept roster cwid can't inflate a count.
    const membershipWhere = mockMembershipFindMany.mock.calls[0][0].where;
    expect(membershipWhere.divisionCode).toEqual({ in: ["GI"] });
    expect(membershipWhere.cwid).toEqual({ in: ["a", "b", "c", "d", "e"] });
  });

  it("skips the manual-roster query when no division is manual (2 queries, not N+1)", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "a", divCode: "CARD" }]);
    mockDivisionFindMany.mockResolvedValue([
      { code: "CARD", source: "ED" },
      { code: "GI", source: "ED" },
    ]);

    const counts = await getDepartmentDivisionMemberCounts("MED");

    expect(Object.fromEntries(counts)).toEqual({ CARD: 1 });
    expect(mockScholarFindMany).toHaveBeenCalledTimes(1);
    expect(mockDivisionFindMany).toHaveBeenCalledTimes(1);
    expect(mockMembershipFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty map when the dept has no public members", async () => {
    mockScholarFindMany.mockResolvedValue([]);
    mockDivisionFindMany.mockResolvedValue([{ code: "GI", source: "manual" }]);

    const counts = await getDepartmentDivisionMemberCounts("MED");

    expect(counts.size).toBe(0);
    expect(mockMembershipFindMany).not.toHaveBeenCalled();
  });
});
