/**
 * Unit Page v2 — `loadUnitRosterIndex` (lib/api/unit-roster-index.ts) and the
 * per-surface counts it ranks on (`loadRosterCounts`, lib/api/roster-counts.ts).
 * Mocked Prisma; synthetic cwids/names only. (`cachedRead` is bypassed under
 * vitest, so caching itself is not observable here.)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFindMany,
  mockPubGroupBy,
  mockGrantGroupBy,
  mockGrantFindMany,
  mockAuthorGroupBy,
  mockSuppressionFindMany,
  mockDivisionFindFirst,
  mockDivisionMembershipFindMany,
  mockExternalFindMany,
  mockLoadDivisionMemberCwids,
  mockCornellEnabled,
  mockResolveGrantSuppression,
} = vi.hoisted(() => ({
  mockScholarFindMany: vi.fn(),
  mockPubGroupBy: vi.fn(),
  mockGrantGroupBy: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockAuthorGroupBy: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockExternalFindMany: vi.fn(),
  mockLoadDivisionMemberCwids: vi.fn(),
  mockCornellEnabled: vi.fn(),
  mockResolveGrantSuppression: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: mockScholarFindMany },
    publicationTopic: { groupBy: mockPubGroupBy },
    publicationAuthor: { groupBy: mockAuthorGroupBy },
    grant: { groupBy: mockGrantGroupBy, findMany: mockGrantFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    division: { findFirst: mockDivisionFindFirst },
    divisionMembership: { findMany: mockDivisionMembershipFindMany },
    externalMember: { findMany: mockExternalFindMany },
  },
}));
vi.mock("@/lib/api/divisions", () => ({
  loadDivisionMemberCwids: (...a: unknown[]) => mockLoadDivisionMemberCwids(...a),
}));
vi.mock("@/lib/api/manual-layer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/manual-layer")>(
    "@/lib/api/manual-layer",
  );
  return {
    ...actual,
    resolveActiveGrantSuppression: (...a: unknown[]) => mockResolveGrantSuppression(...a),
  };
});
vi.mock("@/lib/edit/cornell-directory-flag", () => ({
  isCornellDirectoryMembersEnabled: () => mockCornellEnabled(),
}));

import { loadUnitRosterIndex } from "@/lib/api/unit-roster-index";
import { loadRosterCounts } from "@/lib/api/roster-counts";

const row = (cwid: string, preferredName: string, roleCategory = "full_time_faculty") => ({
  cwid,
  preferredName,
  primaryTitle: "Professor",
  roleCategory,
  divCode: "D1",
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPubGroupBy.mockResolvedValue([]);
  mockGrantGroupBy.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockAuthorGroupBy.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockCornellEnabled.mockReturnValue(false);
});

describe("loadUnitRosterIndex — department", () => {
  it("one carved member select; surname key; no count queries for the default sort", async () => {
    mockScholarFindMany.mockResolvedValue([row("x1", "Jane Doe (Radiology)")]);
    const index = await loadUnitRosterIndex("department", "N1");

    expect(mockScholarFindMany).toHaveBeenCalledTimes(1);
    const where = mockScholarFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ deptCode: "N1", deletedAt: null, status: "active" });
    // publicRoleWhere()'s #536 carve rides along.
    expect(where).toHaveProperty("OR");
    expect(index).toEqual([
      expect.objectContaining({ cwid: "x1", lastKey: "doe", pubCount: 0, grantCount: 0 }),
    ]);
    expect(mockPubGroupBy).not.toHaveBeenCalled();
    expect(mockGrantGroupBy).not.toHaveBeenCalled();
  });

  it("withCounts: confirmed-authorship pub count and the active non-RePORTER grant aggregate", async () => {
    mockScholarFindMany.mockResolvedValue([row("x1", "Ann A"), row("x2", "Bo B")]);
    mockAuthorGroupBy.mockResolvedValue([{ cwid: "x1", _count: { _all: 4 } }]);
    mockGrantGroupBy.mockResolvedValue([{ cwid: "x2", _count: { _all: 3 } }]);

    const index = await loadUnitRosterIndex("department", "N1", { withCounts: true });

    expect(index.map((e) => [e.cwid, e.pubCount, e.grantCount])).toEqual([
      ["x1", 4, 0],
      ["x2", 0, 3],
    ]);
    const grantWhere = mockGrantGroupBy.mock.calls[0][0].where;
    expect(grantWhere.source).toEqual({ not: "RePORTER" });
    expect(grantWhere.endDate.gte).toBeInstanceOf(Date);
    expect(grantWhere.cwid.in).toEqual(["x1", "x2"]);
    // Pub counts never read publication_topic (one row per parent topic).
    expect(mockPubGroupBy).not.toHaveBeenCalled();
  });
});

describe("loadUnitRosterIndex — division", () => {
  it("re-carves loadDivisionMemberCwids and appends Cornell externals with zero counts", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue(["d1", "hidden1"]);
    mockScholarFindMany.mockResolvedValue([row("d1", "Dana Diaz")]);
    mockCornellEnabled.mockReturnValue(true);
    mockDivisionFindFirst.mockResolvedValue({ source: "manual" });
    mockDivisionMembershipFindMany.mockResolvedValue([{ cwid: "ab123" }]);
    mockExternalFindMany.mockResolvedValue([
      {
        cuid: "ab123",
        displayName: "Ada Byron",
        title: "Research Associate",
        dept: "Computer Science",
        affiliation: "staff",
        source: "cornell-ithaca",
      },
    ]);
    mockAuthorGroupBy.mockResolvedValue([{ cwid: "d1", _count: { _all: 6 } }]);
    mockSuppressionFindMany.mockResolvedValue([{ contributorCwid: "d1" }]);

    const index = await loadUnitRosterIndex("division", "D1", { withCounts: true });

    const where = mockScholarFindMany.mock.calls[0][0].where;
    expect(where.cwid.in).toEqual(["d1", "hidden1"]);
    expect(where).toHaveProperty("OR");
    // Division pub count = confirmed authorships minus the scholar's #356 hides.
    expect(index.find((e) => e.cwid === "d1")).toMatchObject({ pubCount: 5, lastKey: "diaz" });
    const ext = index.find((e) => e.cwid === "ab123");
    expect(ext).toMatchObject({ pubCount: 0, grantCount: 0, lastKey: "byron" });
    expect(ext?.externalHit).toMatchObject({ isExternal: true });
    // Counts are never requested for the external's NetID.
    expect(mockAuthorGroupBy.mock.calls[0][0].where.cwid.in).toEqual(["d1"]);
  });

  it("skips the Cornell lookup when the flag is off", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue(["d1"]);
    mockScholarFindMany.mockResolvedValue([row("d1", "Dana Diaz")]);
    await loadUnitRosterIndex("division", "D1");
    expect(mockDivisionFindFirst).not.toHaveBeenCalled();
    expect(mockExternalFindMany).not.toHaveBeenCalled();
  });
});

describe("loadRosterCounts — center", () => {
  it("drops #160-suppressed grants from the count", async () => {
    mockGrantFindMany.mockResolvedValue([
      { cwid: "c1", externalId: "KEEP", id: "1" },
      { cwid: "c1", externalId: "HIDE", id: "2" },
    ]);
    mockResolveGrantSuppression.mockResolvedValue({ suppressed: new Set(["HIDE"]) });
    const { grants } = await loadRosterCounts("center", ["c1"]);
    expect(grants.get("c1")).toBe(1);
    expect(mockGrantFindMany.mock.calls[0][0].where.source).toEqual({ not: "RePORTER" });
  });

  it("issues no queries for an empty cwid list", async () => {
    await loadRosterCounts("department", []);
    expect(mockPubGroupBy).not.toHaveBeenCalled();
    expect(mockAuthorGroupBy).not.toHaveBeenCalled();
    expect(mockGrantGroupBy).not.toHaveBeenCalled();
  });
});
