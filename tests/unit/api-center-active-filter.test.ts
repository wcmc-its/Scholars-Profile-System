/**
 * #552 Phase 4 — public center page active filter + program grouping.
 *
 *  - isCenterMembershipActive: the § 3.3 predicate over the § 9 boundary rows
 *    4–8, with inclusive endpoints (end=today active, start=today active).
 *  - getCenterMembers: active members only; grouped under program labels in
 *    (sortOrder, label) order; null/dangling program → "Other" last; flat list
 *    when the center has no programs OR no programmed actives (edge 9); dormant
 *    scholar dropped (edge 10).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { isCenterMembershipActive } from "@/lib/api/centers";

const D = (iso: string) => new Date(iso); // "2026-05-28" -> UTC midnight

describe("isCenterMembershipActive — § 3.3 predicate (#552)", () => {
  const TODAY = "2026-05-28";

  it("row 4 — both dates null → active forever", () => {
    expect(isCenterMembershipActive(null, null, TODAY)).toBe(true);
  });

  it("row 5 — null start + past end → inactive", () => {
    expect(isCenterMembershipActive(null, D("2025-01-01"), TODAY)).toBe(false);
  });

  it("row 6 — future start + null end → pending (hidden)", () => {
    expect(isCenterMembershipActive(D("2999-01-01"), null, TODAY)).toBe(false);
  });

  it("row 7 — end = today → active (inclusive upper bound)", () => {
    expect(isCenterMembershipActive(null, D(TODAY), TODAY)).toBe(true);
  });

  it("start = today → active (inclusive lower bound)", () => {
    expect(isCenterMembershipActive(D(TODAY), null, TODAY)).toBe(true);
  });

  it("end = yesterday → inactive", () => {
    expect(isCenterMembershipActive(null, D("2026-05-27"), TODAY)).toBe(false);
  });

  it("start = tomorrow → pending", () => {
    expect(isCenterMembershipActive(D("2026-05-29"), null, TODAY)).toBe(false);
  });

  it("today strictly inside [start, end] → active", () => {
    expect(isCenterMembershipActive(D("2024-07-01"), D("2027-06-30"), TODAY)).toBe(
      true,
    );
  });
});

// --- getCenterMembers grouping ---------------------------------------------

const {
  mockCenterMembershipFindMany,
  mockScholarFindMany,
  mockCenterProgramFindMany,
  mockPublicationTopicGroupBy,
  mockGrantGroupBy,
} = vi.hoisted(() => ({
  mockCenterMembershipFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockCenterProgramFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockGrantGroupBy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    centerMembership: { findMany: mockCenterMembershipFindMany },
    scholar: { findMany: mockScholarFindMany },
    centerProgram: { findMany: mockCenterProgramFindMany },
    publicationTopic: { groupBy: mockPublicationTopicGroupBy },
    grant: { groupBy: mockGrantGroupBy },
  },
}));

import { getCenterMembers } from "@/lib/api/centers";

/** scholar.findMany returns one row per `where.cwid.in` entry NOT in `dormant`. */
function routeScholar(dormant: ReadonlySet<string> = new Set()) {
  return (args?: { where?: { cwid?: { in?: string[] } } }) => {
    const ins = args?.where?.cwid?.in ?? [];
    return Promise.resolve(
      ins
        .filter((c) => !dormant.has(c))
        .sort()
        .map((cwid) => ({
          cwid,
          preferredName: cwid.toUpperCase(),
          slug: cwid,
          primaryTitle: null,
          primaryDepartment: "Medicine",
          roleCategory: "full_time_faculty",
          overview: null,
          department: { name: "Department of Medicine" },
          division: null,
        })),
    );
  };
}

const ACTIVE = { startDate: null, endDate: null }; // null dates = active forever

beforeEach(() => {
  vi.clearAllMocks();
  mockPublicationTopicGroupBy.mockResolvedValue([]);
  mockGrantGroupBy.mockResolvedValue([]);
  mockCenterProgramFindMany.mockResolvedValue([]);
  mockScholarFindMany.mockImplementation(routeScholar());
});

describe("getCenterMembers — active filter + grouping (#552 §6.2)", () => {
  it("groups programmed members under program labels in (sortOrder) order, Other last", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "a", programCode: "CT", ...ACTIVE },
      { cwid: "b", programCode: "CB", ...ACTIVE },
      { cwid: "c", programCode: null, ...ACTIVE }, // → Other
    ]);
    mockCenterProgramFindMany.mockResolvedValue([
      { code: "CB", label: "Cancer Biology" }, // sortOrder 10 (query-ordered)
      { code: "CT", label: "Cancer Therapeutics" }, // sortOrder 40
    ]);

    const result = await getCenterMembers("MEYER", {});
    expect(result.mode).toBe("grouped");
    if (result.mode !== "grouped") throw new Error("expected grouped");
    expect(result.total).toBe(3);
    expect(result.groups.map((g) => g.label)).toEqual([
      "Cancer Biology",
      "Cancer Therapeutics",
      "Other",
    ]);
    expect(result.groups[0].members.map((m) => m.cwid)).toEqual(["b"]);
    expect(result.groups[1].members.map((m) => m.cwid)).toEqual(["a"]);
    expect(result.groups[2].members.map((m) => m.cwid)).toEqual(["c"]);
  });

  it("omits the Other group when every active member is programmed (edge 8)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "a", programCode: "CT", ...ACTIVE },
      { cwid: "b", programCode: "CB", ...ACTIVE },
    ]);
    mockCenterProgramFindMany.mockResolvedValue([
      { code: "CB", label: "Cancer Biology" },
      { code: "CT", label: "Cancer Therapeutics" },
    ]);

    const result = await getCenterMembers("MEYER", {});
    if (result.mode !== "grouped") throw new Error("expected grouped");
    expect(result.groups.map((g) => g.label)).toEqual([
      "Cancer Biology",
      "Cancer Therapeutics",
    ]);
  });

  it("renders flat (no headers) when programs exist but no active programmed members (edge 9)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "a", programCode: null, ...ACTIVE },
      { cwid: "b", programCode: null, ...ACTIVE },
    ]);
    mockCenterProgramFindMany.mockResolvedValue([
      { code: "CB", label: "Cancer Biology" },
    ]);

    const result = await getCenterMembers("MEYER", {});
    expect(result.mode).toBe("flat");
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.total).toBe(2);
    expect(result.hits.map((m) => m.cwid).sort()).toEqual(["a", "b"]);
  });

  it("renders flat when the center has zero programs (today's behavior)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "a", programCode: null, ...ACTIVE },
    ]);
    // mockCenterProgramFindMany defaults to []

    const result = await getCenterMembers("MEYER", {});
    expect(result.mode).toBe("flat");
  });

  it("excludes inactive (lapsed) and pending memberships before grouping", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "active", programCode: "CB", startDate: null, endDate: null },
      { cwid: "lapsed", programCode: "CB", startDate: null, endDate: D("2000-01-01") },
      { cwid: "pending", programCode: "CB", startDate: D("2999-01-01"), endDate: null },
    ]);
    mockCenterProgramFindMany.mockResolvedValue([
      { code: "CB", label: "Cancer Biology" },
    ]);

    const result = await getCenterMembers("MEYER", {});
    if (result.mode !== "grouped") throw new Error("expected grouped");
    expect(result.total).toBe(1);
    expect(result.groups[0].members.map((m) => m.cwid)).toEqual(["active"]);
    // scholar.findMany only ever asked about the active cwid
    expect(mockScholarFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cwid: { in: ["active"] } }),
      }),
    );
  });

  it("drops a dormant / soft-deleted scholar from the active roster (edge 10)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "live", programCode: null, ...ACTIVE },
      { cwid: "dormant", programCode: null, ...ACTIVE },
    ]);
    mockScholarFindMany.mockImplementation(routeScholar(new Set(["dormant"])));

    const result = await getCenterMembers("MEYER", {});
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.total).toBe(1);
    expect(result.hits.map((m) => m.cwid)).toEqual(["live"]);
  });

  it("returns an empty flat result when no memberships are active", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      { cwid: "lapsed", programCode: null, startDate: null, endDate: D("2000-01-01") },
    ]);

    const result = await getCenterMembers("MEYER", {});
    expect(result).toEqual({
      mode: "flat",
      hits: [],
      total: 0,
      page: 0,
      pageSize: 20,
    });
    // short-circuits before touching Scholar
    expect(mockScholarFindMany).not.toHaveBeenCalled();
  });
});
