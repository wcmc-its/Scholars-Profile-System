/**
 * #1103 — reverse query for the profile "Centers" card.
 *
 * `getScholarCenterAffiliations(cwid)` returns ONLY the scholar's ACTIVE center
 * memberships (§3.3 date filter — lapsed/pending excluded), joined to the
 * center (slug + officialName ?? name), ordered by Center.sortOrder then name,
 * dropping retired (whole-unit-suppressed) centers. PRISMA-SOURCED — adds no
 * search-index/browse-facet key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const D = (iso: string) => new Date(iso);

const { mockCenterMembershipFindMany, mockSuppressionFindFirst } = vi.hoisted(
  () => ({
    mockCenterMembershipFindMany: vi.fn(),
    mockSuppressionFindFirst: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    centerMembership: { findMany: mockCenterMembershipFindMany },
    suppression: { findFirst: mockSuppressionFindFirst },
  },
}));

import { getScholarCenterAffiliations } from "@/lib/api/centers";

/** Build a membership row joined to a center, with sensible defaults. */
function row(
  overrides: Partial<{
    centerCode: string;
    membershipType: "research" | "clinical" | null;
    startDate: Date | null;
    endDate: Date | null;
    center: {
      code: string;
      slug: string;
      name: string;
      officialName: string | null;
      sortOrder: number;
    } | null;
    program: { label: string } | null;
  }> = {},
) {
  const code = overrides.centerCode ?? "MEYER";
  return {
    centerCode: code,
    membershipType: overrides.membershipType ?? null,
    startDate: overrides.startDate ?? null,
    endDate: overrides.endDate ?? null,
    center:
      overrides.center !== undefined
        ? overrides.center
        : {
            code,
            slug: code.toLowerCase(),
            name: `${code} Center`,
            officialName: null,
            sortOrder: 0,
          },
    program: overrides.program ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSuppressionFindFirst.mockResolvedValue(null); // no center suppressed
});

describe("getScholarCenterAffiliations — #1103 reverse query", () => {
  it("returns an active membership, name = officialName ?? name, linked by slug", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({
        centerCode: "MEYER",
        center: {
          code: "MEYER",
          slug: "meyer-cancer-center",
          name: "Meyer Cancer Center",
          officialName: "Sandra and Edward Meyer Cancer Center",
          sortOrder: 0,
        },
      }),
    ]);

    const result = await getScholarCenterAffiliations("abc1234");
    expect(result).toEqual([
      {
        code: "MEYER",
        slug: "meyer-cancer-center",
        name: "Sandra and Edward Meyer Cancer Center",
        programLabel: null,
        membershipType: null,
      },
    ]);
  });

  it("falls back to Center.name when officialName is null", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({
        center: {
          code: "MEYER",
          slug: "meyer",
          name: "Meyer Cancer Center",
          officialName: null,
          sortOrder: 0,
        },
      }),
    ]);
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result[0].name).toBe("Meyer Cancer Center");
  });

  it("EXCLUDES a lapsed membership (past endDate)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({ startDate: null, endDate: D("2000-01-01") }),
    ]);
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result).toEqual([]);
    // short-circuits before checking suppression
    expect(mockSuppressionFindFirst).not.toHaveBeenCalled();
  });

  it("EXCLUDES a pending membership (future startDate)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({ startDate: D("2999-01-01"), endDate: null }),
    ]);
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result).toEqual([]);
  });

  it("INCLUDES an active membership (null dates = active forever)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({ startDate: null, endDate: null }),
    ]);
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result).toHaveLength(1);
  });

  it("surfaces program label + membership type only when present", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({
        membershipType: "research",
        program: { label: "Cancer Biology" },
      }),
    ]);
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result[0].programLabel).toBe("Cancer Biology");
    expect(result[0].membershipType).toBe("research");
  });

  it("orders by Center.sortOrder, then name", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({
        centerCode: "B",
        center: { code: "B", slug: "b", name: "Beta", officialName: null, sortOrder: 20 },
      }),
      row({
        centerCode: "A",
        center: { code: "A", slug: "a", name: "Alpha", officialName: null, sortOrder: 10 },
      }),
      row({
        centerCode: "C",
        center: { code: "C", slug: "c", name: "Cappa", officialName: null, sortOrder: 10 },
      }),
    ]);
    const result = await getScholarCenterAffiliations("abc1234");
    // sortOrder 10 before 20; within 10, "Alpha" before "Cappa".
    expect(result.map((c) => c.code)).toEqual(["A", "C", "B"]);
  });

  it("drops a retired (whole-unit-suppressed) center", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      row({
        centerCode: "LIVE",
        center: { code: "LIVE", slug: "live", name: "Live", officialName: null, sortOrder: 0 },
      }),
      row({
        centerCode: "DEAD",
        center: { code: "DEAD", slug: "dead", name: "Dead", officialName: null, sortOrder: 1 },
      }),
    ]);
    mockSuppressionFindFirst.mockImplementation(
      (args?: { where?: { entityId?: string } }) =>
        Promise.resolve(args?.where?.entityId === "DEAD" ? { id: "s1" } : null),
    );
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result.map((c) => c.code)).toEqual(["LIVE"]);
  });

  it("returns [] when the scholar has no memberships", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([]);
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result).toEqual([]);
  });

  it("drops an orphaned row whose center join is missing", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([row({ center: null })]);
    const result = await getScholarCenterAffiliations("abc1234");
    expect(result).toEqual([]);
  });
});
