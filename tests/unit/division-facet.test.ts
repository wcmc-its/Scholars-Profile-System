/**
 * #974 Phase 2 — getDivisionFaculty attaches `methodFacet` only when the facet flag
 * is on, feeding the FULL active member cwid set (already loaded for the roster) to
 * the aggregation WITHOUT an extra cwid query (the division path is cheaper than the
 * dept path). Flag off → no aggregation, no methodFacet in the serialized payload.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockDivisionFindFirst,
  mockScholarFindMany,
  mockScholarFindFirst,
  mockScholarGroupBy,
  mockScholarFamilyGroupBy,
  mockScholarFamilyFindMany,
  mockPubAuthorGroupBy,
  mockGrantGroupBy,
  mockDivisionMembershipFindMany,
  mockLoadOverlayGate,
  mockLoadHiddenAuthorshipCounts,
  mockFacetEnabled,
  mockChipsEnabled,
} = vi.hoisted(() => ({
  mockDivisionFindFirst: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarFindFirst: vi.fn(),
  mockScholarGroupBy: vi.fn(),
  mockScholarFamilyGroupBy: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockPubAuthorGroupBy: vi.fn(),
  mockGrantGroupBy: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockLoadOverlayGate: vi.fn(),
  mockLoadHiddenAuthorshipCounts: vi.fn(),
  mockFacetEnabled: vi.fn(),
  mockChipsEnabled: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    division: { findFirst: mockDivisionFindFirst },
    scholar: {
      findMany: mockScholarFindMany,
      findFirst: mockScholarFindFirst,
      groupBy: mockScholarGroupBy,
    },
    scholarFamily: {
      groupBy: mockScholarFamilyGroupBy,
      findMany: mockScholarFamilyFindMany,
    },
    publicationAuthor: { groupBy: mockPubAuthorGroupBy },
    grant: { groupBy: mockGrantGroupBy },
    divisionMembership: { findMany: mockDivisionMembershipFindMany },
  },
}));
vi.mock("@/lib/api/methods-overlay", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/methods-overlay")>(
    "@/lib/api/methods-overlay",
  );
  return { ...actual, loadFamilyOverlayGate: () => mockLoadOverlayGate() };
});
vi.mock("@/lib/api/manual-layer", () => ({
  loadHiddenAuthorshipCounts: () => mockLoadHiddenAuthorshipCounts(),
  isUnitSuppressed: vi.fn(),
  loadUnitFieldOverrides: vi.fn(),
  mergeUnitFields: vi.fn(),
  resolveActiveGrantSuppression: vi.fn(),
  loadPublicationSuppressions: vi.fn(),
  resolveDarkPmids: vi.fn(),
  isAuthorHidden: vi.fn(),
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isOrgUnitMethodsChipsEnabled: () => mockChipsEnabled(),
  isOrgUnitMethodsFacetEnabled: () => mockFacetEnabled(),
  isMethodsLensEnabled: () => false,
  isMethodsLensSensitiveGateOn: () => false,
}));

import { getDivisionFaculty } from "@/lib/api/divisions";

function scholarRow(cwid: string) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: "Professor",
    roleCategory: "full_time_faculty",
    overview: null,
    department: { name: "Department of Medicine" },
    division: { name: "Cardiology" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChipsEnabled.mockReturnValue(false);
  mockFacetEnabled.mockReturnValue(false);
  mockLoadOverlayGate.mockResolvedValue({ suppressed: new Set(), sensitive: new Set() });
  mockLoadHiddenAuthorshipCounts.mockResolvedValue(new Map());
  mockDivisionFindFirst.mockResolvedValue({ chiefCwid: null, source: "ED" });
  mockScholarGroupBy.mockResolvedValue([]);
  mockPubAuthorGroupBy.mockResolvedValue([]);
  mockGrantGroupBy.mockResolvedValue([]);
  // loadDivisionMemberCwids (source=ED) → first findMany returns the member cwids;
  // the second (page rows, with `include`) returns the page scholar rows.
  mockScholarFindMany.mockImplementation((args: { include?: unknown }) =>
    "include" in args
      ? Promise.resolve(
          (args as { where: { cwid: { in: string[] } } }).where.cwid.in.map(scholarRow),
        )
      : Promise.resolve([{ cwid: "d1" }, { cwid: "d2" }]),
  );
});

describe("getDivisionFaculty — #974 Phase 2 facet", () => {
  it("flag OFF: no methodFacet in payload, no scholarFamily.groupBy", async () => {
    const result = await getDivisionFaculty("N2466", {});
    expect(result.methodFacet).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("methodFacet");
    expect(mockScholarFamilyGroupBy).not.toHaveBeenCalled();
  });

  it("flag ON: methodFacet aggregated from member cwids with NO extra cwid query", async () => {
    mockFacetEnabled.mockReturnValue(true);
    mockScholarFamilyGroupBy.mockResolvedValue([
      { supercategory: "imaging_x", familyLabel: "Segmentation", _count: { cwid: 4 } },
    ]);

    const result = await getDivisionFaculty("N2466", {});

    expect(result.methodFacet).toEqual([
      { value: "imaging_x::Segmentation", label: "Segmentation", count: 4 },
    ]);
    // The aggregation reuses the in-hand memberCwids — only the member-cwid query
    // (loadDivisionMemberCwids) + the page-rows query ran; no third cwid select.
    const cwidOnlyCalls = mockScholarFindMany.mock.calls.filter(
      (c) => !("include" in (c[0] ?? {})),
    );
    expect(cwidOnlyCalls).toHaveLength(1);
    // The aggregation received the in-hand member cwid set.
    expect(mockScholarFamilyGroupBy.mock.calls[0][0].where.cwid.in).toEqual(["d1", "d2"]);
  });
});
