/**
 * #962 — `loadPublicFamiliesForMembers`: the ONE batched, overlay-gated fetch of
 * PUBLIC method families for every center member, feeding both the "Methods &
 * tools" facet and the per-row chips on the GROUPED center roster.
 *
 * Mirrors `methods-scholar-families.test.ts`' vi.hoisted / vi.mock conventions.
 * Asserts the security-critical invariant: a #800-suppressed (and, when the
 * sensitivity gate is on, a #801-sensitive) family is dropped BEFORE it enters
 * any member's list and never appears — even with the highest pmidCount. Plus the
 * single batched query shape, pmidCount-desc ordering, the top-N cap, exemplar
 * coercion, and the flag-off / empty-cwid no-query short-circuits.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFamilyFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockFacetEnabled,
  mockSensitiveGateOn,
} = vi.hoisted(() => ({
  mockScholarFamilyFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockFacetEnabled: vi.fn(),
  mockSensitiveGateOn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { findMany: mockScholarFamilyFindMany },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isCenterMethodsFacetEnabled: () => mockFacetEnabled(),
  isMethodsLensSensitiveGateOn: () => mockSensitiveGateOn(),
}));

// centers.ts drags in role-display / headshot / name-sort / manual-layer via its
// import graph; stub the heaviest so this unit resolves without real DB/helpers.
vi.mock("@/lib/api/manual-layer", () => ({
  isAuthorHidden: vi.fn(),
  isUnitSuppressed: vi.fn(),
  loadPublicationSuppressions: vi.fn(),
  resolveActiveGrantSuppression: vi.fn(),
  resolveDarkPmids: vi.fn(),
}));

import { loadPublicFamiliesForMembers } from "@/lib/api/centers";

const SC = "imaging_image_analysis";
const CWIDS = ["abc1234", "def5678"];

type Row = {
  cwid: string;
  supercategory: string;
  familyLabel: string;
  familyId: string;
  pmidCount: number;
  exemplarTools: unknown;
};

function row(
  cwid: string,
  familyLabel: string,
  familyId: string,
  pmidCount: number,
  exemplarTools: unknown = [],
): Row {
  return { cwid, supercategory: SC, familyLabel, familyId, pmidCount, exemplarTools };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFacetEnabled.mockReturnValue(true);
  mockSensitiveGateOn.mockReturnValue(false);
  mockSuppressionOverlayFindMany.mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockResolvedValue([]);
});

describe("loadPublicFamiliesForMembers (#962)", () => {
  it("issues ONE batched scholar_family query keyed on cwid:{in}, pmidCount desc", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("abc1234", "Deep learning", "fam_0001", 12),
      row("abc1234", "MRI", "fam_0002", 6),
      row("def5678", "Deep learning", "fam_0001", 3),
    ]);

    const out = await loadPublicFamiliesForMembers(CWIDS);

    expect(mockScholarFamilyFindMany).toHaveBeenCalledTimes(1);
    const args = mockScholarFamilyFindMany.mock.calls[0][0];
    expect(args.where).toEqual({
      cwid: { in: CWIDS },
      scholar: { deletedAt: null, status: "active" },
    });
    expect(args.orderBy).toEqual([{ pmidCount: "desc" }, { familyId: "asc" }]);

    // Map<cwid, families[]>, pre-sorted pmidCount desc; value = sc::label.
    expect(out.get("abc1234")!.map((f) => f.familyLabel)).toEqual(["Deep learning", "MRI"]);
    expect(out.get("abc1234")!.map((f) => f.value)).toEqual([
      `${SC}::Deep learning`,
      `${SC}::MRI`,
    ]);
    expect(out.get("def5678")!.map((f) => f.familyLabel)).toEqual(["Deep learning"]);
  });

  it("EXCLUDES a #800-suppressed family from BOTH facet membership and chips even at top pmidCount", async () => {
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Secret" },
    ]);
    mockScholarFamilyFindMany.mockResolvedValue([
      row("abc1234", "Secret", "fam_0009", 99), // suppressed — must vanish despite top count
      row("abc1234", "Deep learning", "fam_0001", 12),
    ]);

    const out = await loadPublicFamiliesForMembers(CWIDS);

    expect(out.get("abc1234")!.map((f) => f.familyLabel)).toEqual(["Deep learning"]);
    expect(out.get("abc1234")!.some((f) => f.familyLabel === "Secret")).toBe(false);
  });

  it("EXCLUDES a #801-sensitive family ONLY when the sensitivity gate is on", async () => {
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Sensitive" },
    ]);
    mockScholarFamilyFindMany.mockResolvedValue([
      row("abc1234", "Sensitive", "fam_0008", 20),
      row("abc1234", "Deep learning", "fam_0001", 12),
    ]);

    // Gate OFF → sensitive family is public (overlay never even consulted).
    mockSensitiveGateOn.mockReturnValue(false);
    const off = await loadPublicFamiliesForMembers(CWIDS);
    expect(off.get("abc1234")!.map((f) => f.familyLabel)).toEqual([
      "Sensitive",
      "Deep learning",
    ]);

    // Gate ON → sensitive family is dropped from facet + chips.
    vi.clearAllMocks();
    mockFacetEnabled.mockReturnValue(true);
    mockSuppressionOverlayFindMany.mockResolvedValue([]);
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Sensitive" },
    ]);
    mockSensitiveGateOn.mockReturnValue(true);
    mockScholarFamilyFindMany.mockResolvedValue([
      row("abc1234", "Sensitive", "fam_0008", 20),
      row("abc1234", "Deep learning", "fam_0001", 12),
    ]);
    const on = await loadPublicFamiliesForMembers(CWIDS);
    expect(on.get("abc1234")!.map((f) => f.familyLabel)).toEqual(["Deep learning"]);
  });

  it("returns ALL public families pmidCount desc (chip top-N cap applied downstream)", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("abc1234", "F1", "fam_0001", 70),
      row("abc1234", "F2", "fam_0002", 60),
      row("abc1234", "F3", "fam_0003", 50),
      row("abc1234", "F4", "fam_0004", 40),
    ]);

    const out = await loadPublicFamiliesForMembers(CWIDS);

    // The loader keeps the full set (facet membership); the ≤3 chip cap is taken
    // by `topMethods = families.slice(0, 3)` in getCenterMembers.
    expect(out.get("abc1234")!.map((f) => f.familyLabel)).toEqual(["F1", "F2", "F3", "F4"]);
    expect(out.get("abc1234")!.map((f) => f.pmidCount)).toEqual([70, 60, 50, 40]);
    expect(out.get("abc1234")!.slice(0, 3).map((f) => f.familyLabel)).toEqual([
      "F1",
      "F2",
      "F3",
    ]);
  });

  it("coerces exemplarTools: array passes through, non-array → []", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("abc1234", "F1", "fam_0001", 10, ["CheXpert", "MONAI"]),
      row("abc1234", "F2", "fam_0002", 5, null),
    ]);

    const out = await loadPublicFamiliesForMembers(CWIDS);
    expect(out.get("abc1234")![0].exemplarTools).toEqual(["CheXpert", "MONAI"]);
    expect(out.get("abc1234")![1].exemplarTools).toEqual([]);
  });

  it("returns an empty map and does NOT query when the flag is off", async () => {
    mockFacetEnabled.mockReturnValue(false);

    const out = await loadPublicFamiliesForMembers(CWIDS);

    expect(out.size).toBe(0);
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
    expect(mockSuppressionOverlayFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty map for an empty cwid list without any DB read", async () => {
    const out = await loadPublicFamiliesForMembers([]);

    expect(out.size).toBe(0);
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });
});
