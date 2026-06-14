/**
 * #974 Phase 2 — `getUnitMembersByMethods` (lib/api/unit-members.ts).
 *
 * The filtered-roster loader behind the uncacheable /api/units route. Asserts:
 *  - department path resolves full active cwids via scholar.findMany(deptCode);
 *  - the selected sc::label keys become an OR set of (supercategory, familyLabel)
 *    pairs (OR within facet) — a TAMPERED key for a suppressed/sensitive family is
 *    dropped BEFORE the scholarFamily.findMany (never selects a non-public family);
 *  - the filtered cwid set is paginated (page 0 vs 1);
 *  - returned hits carry public-gated `topMethods` chips.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFindMany,
  mockFamilyFindMany,
  mockPubGroupBy,
  mockGrantGroupBy,
  mockLoadOverlayGate,
  mockLoadDivisionMemberCwids,
} = vi.hoisted(() => ({
  mockScholarFindMany: vi.fn(),
  mockFamilyFindMany: vi.fn(),
  mockPubGroupBy: vi.fn(),
  mockGrantGroupBy: vi.fn(),
  mockLoadOverlayGate: vi.fn(),
  mockLoadDivisionMemberCwids: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: mockScholarFindMany },
    scholarFamily: { findMany: mockFamilyFindMany },
    publicationTopic: { groupBy: mockPubGroupBy },
    grant: { groupBy: mockGrantGroupBy },
  },
}));
vi.mock("@/lib/api/methods-overlay", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/methods-overlay")>(
    "@/lib/api/methods-overlay",
  );
  return { ...actual, loadFamilyOverlayGate: () => mockLoadOverlayGate() };
});
vi.mock("@/lib/api/divisions", () => ({
  loadDivisionMemberCwids: (...a: unknown[]) => mockLoadDivisionMemberCwids(...a),
}));
// loadPublicFamiliesForMembers (chips) is exercised via the real methods-roster
// module against the mocked scholarFamily.findMany below.

import { getUnitMembersByMethods } from "@/lib/api/unit-members";

const SC = "imaging_x";

function scholarRow(cwid: string) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: "Professor",
    roleCategory: "full_time_faculty",
    overview: null,
    primaryDepartment: "Radiology",
    department: { name: "Department of Radiology" },
    division: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadOverlayGate.mockResolvedValue({ suppressed: new Set(), sensitive: new Set() });
  mockPubGroupBy.mockResolvedValue([]);
  mockGrantGroupBy.mockResolvedValue([]);
});

describe("getUnitMembersByMethods — department", () => {
  it("OR-filters members across selected families, paginates, returns chips", async () => {
    // scholar.findMany is called twice: (step 1) member-cwid select (no `include`),
    // and (step 4) the page row assembly (`include` present). Route by `include`.
    mockScholarFindMany.mockImplementation((args: { include?: unknown }) =>
      "include" in args
        ? Promise.resolve(
            (args as { where: { cwid: { in: string[] } } }).where.cwid.in.map(scholarRow),
          )
        : Promise.resolve([{ cwid: "m1" }, { cwid: "m2" }, { cwid: "m3" }, { cwid: "m4" }]),
    );
    // scholarFamily.findMany is called twice: the OR-filter (distinct cwid) → matched
    // members; the chip load (no distinct) → family rows for the page.
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) => {
      if (args.distinct?.includes("cwid")) {
        return Promise.resolve([{ cwid: "m1" }, { cwid: "m2" }, { cwid: "m3" }]);
      }
      return Promise.resolve([
        {
          cwid: "m1",
          supercategory: SC,
          familyLabel: "Deep learning",
          pmidCount: 9,
          exemplarTools: ["PyTorch"],
        },
      ]);
    });

    const result = await getUnitMembersByMethods(
      "department",
      "N1140",
      [`${SC}::Deep learning`, `${SC}::Segmentation`],
      0,
    );

    // Total = distinct matched members (3), not the page count.
    expect(result.total).toBe(3);
    // OR set forwarded to the filter findMany.
    const filterCall = mockFamilyFindMany.mock.calls.find(
      (c) => c[0]?.distinct?.includes("cwid"),
    )![0];
    expect(filterCall.where.OR).toEqual([
      { supercategory: SC, familyLabel: "Deep learning" },
      { supercategory: SC, familyLabel: "Segmentation" },
    ]);
    // The matched cwids drive the member-cwid `in` filter.
    expect(filterCall.where.cwid.in).toEqual(["m1", "m2", "m3", "m4"]);
    // Page chips: m1 carries the public Deep-learning chip.
    const m1 = result.hits.find((h) => h.cwid === "m1");
    expect(m1?.topMethods?.[0].familyLabel).toBe("Deep learning");
  });

  it("drops a tampered suppressed key BEFORE the filter query (never selects it)", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "m1" }, { cwid: "m2" }]);
    mockLoadOverlayGate.mockResolvedValue({
      suppressed: new Set([`${SC}::Secret`]),
      sensitive: new Set(),
    });
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve([{ cwid: "m1" }])
        : Promise.resolve([]),
    );

    const result = await getUnitMembersByMethods(
      "department",
      "N1140",
      [`${SC}::Deep learning`, `${SC}::Secret`],
      0,
    );

    const filterCall = mockFamilyFindMany.mock.calls.find(
      (c) => c[0]?.distinct?.includes("cwid"),
    )![0];
    // Only the public pair survives the gate; the suppressed key is never queried.
    expect(filterCall.where.OR).toEqual([
      { supercategory: SC, familyLabel: "Deep learning" },
    ]);
    expect(result.total).toBe(1);
  });

  it("returns empty (no family query) when EVERY selected key is non-public", async () => {
    mockScholarFindMany.mockResolvedValue([{ cwid: "m1" }]);
    mockLoadOverlayGate.mockResolvedValue({
      suppressed: new Set([`${SC}::Secret`]),
      sensitive: new Set(),
    });
    const result = await getUnitMembersByMethods("department", "N1140", [`${SC}::Secret`], 0);
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
    // No OR-filter query ran (publicPairs empty short-circuits).
    expect(mockFamilyFindMany).not.toHaveBeenCalled();
  });

  it("paginates the filtered set (page 1 takes the next slice)", async () => {
    mockScholarFindMany.mockImplementation((args: { include?: unknown }) =>
      "include" in args
        ? // chip-less page assembly: return the page's scholar rows
          Promise.resolve(
            (args as { where: { cwid: { in: string[] } } }).where.cwid.in.map(scholarRow),
          )
        : Promise.resolve(
            Array.from({ length: 25 }, (_, i) => ({ cwid: `m${String(i).padStart(2, "0")}` })),
          ),
    );
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve(
            Array.from({ length: 25 }, (_, i) => ({ cwid: `m${String(i).padStart(2, "0")}` })),
          )
        : Promise.resolve([]),
    );

    const page1 = await getUnitMembersByMethods("department", "N1140", [`${SC}::A`], 1);
    expect(page1.total).toBe(25);
    expect(page1.page).toBe(1);
    // 25 members, 20/page → page 1 has the remaining 5.
    expect(page1.hits).toHaveLength(5);
  });
});

describe("getUnitMembersByMethods — division", () => {
  it("resolves member cwids via loadDivisionMemberCwids", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue(["d1", "d2"]);
    mockFamilyFindMany.mockImplementation((args: { distinct?: string[] }) =>
      args.distinct?.includes("cwid")
        ? Promise.resolve([{ cwid: "d1" }])
        : Promise.resolve([]),
    );
    mockScholarFindMany.mockResolvedValue([scholarRow("d1")]);

    const result = await getUnitMembersByMethods("division", "N2466", [`${SC}::A`], 0);
    expect(mockLoadDivisionMemberCwids).toHaveBeenCalledWith("N2466");
    expect(result.total).toBe(1);
    expect(result.hits[0].cwid).toBe("d1");
  });

  it("returns empty when the division has no members", async () => {
    mockLoadDivisionMemberCwids.mockResolvedValue([]);
    const result = await getUnitMembersByMethods("division", "N2466", [`${SC}::A`], 0);
    expect(result.total).toBe(0);
    expect(mockFamilyFindMany).not.toHaveBeenCalled();
  });
});
