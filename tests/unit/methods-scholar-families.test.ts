/**
 * #853 — `getScholarMethodFamilies`: a single scholar's prominent method families
 * for the PersonPopover section, ranked by `pmidCount` desc and overlay-gated.
 *
 * Mirrors the methods-rollup test's vi.hoisted / vi.mock conventions. Asserts the
 * security-critical invariant: a #800-suppressed (and, when the sensitivity gate
 * is on, a #801-sensitive) family is dropped BEFORE ranking and never appears in
 * the result — even with the highest pmidCount. Plus ranking, the 5-cap, and the
 * lens-off / empty-cwid short-circuits.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  familySlug,
  supercategorySlug,
} from "@/lib/method-url";

const {
  mockScholarFamilyFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockLensEnabled,
  mockSensitiveGateOn,
} = vi.hoisted(() => ({
  mockScholarFamilyFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockLensEnabled: vi.fn(),
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
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodsLensEnabled: () => mockLensEnabled(),
  isMethodsLensSensitiveGateOn: () => mockSensitiveGateOn(),
  isMethodPagesEnabled: () => true,
}));

// methods.ts pulls in these via topics.ts / manual-layer — stub so the import
// graph resolves without dragging real DB/helpers into this unit.
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: vi.fn(),
  resolveDarkPmids: vi.fn(),
  loadHiddenAuthorshipCounts: () => Promise.resolve(new Map()),
}));
vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn(),
}));

import { getScholarMethodFamilies } from "@/lib/api/methods";

const SC = "imaging_image_analysis";
const CWID = "abc1234";

type Row = {
  supercategory: string;
  familyLabel: string;
  familyId: string;
  pmidCount: number;
};

function row(familyLabel: string, familyId: string, pmidCount: number): Row {
  return { supercategory: SC, familyLabel, familyId, pmidCount };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLensEnabled.mockReturnValue(true);
  mockSensitiveGateOn.mockReturnValue(false);
  mockSuppressionOverlayFindMany.mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockResolvedValue([]);
});

describe("getScholarMethodFamilies", () => {
  it("ranks by pmidCount desc and maps the canonical /methods family href", async () => {
    // Feed pre-ordered rows (the loader trusts the DB orderBy); assert order +
    // href shape `/methods/{scSlug}/{labelSlug}-{familyId}`.
    mockScholarFamilyFindMany.mockResolvedValue([
      row("Deep learning", "fam_0001", 12),
      row("MRI", "fam_0002", 6),
    ]);

    const out = await getScholarMethodFamilies(CWID);

    expect(out.map((f) => f.familyLabel)).toEqual(["Deep learning", "MRI"]);
    expect(out.map((f) => f.pmidCount)).toEqual([12, 6]);
    expect(out[0].href).toBe(
      `/methods/${supercategorySlug(SC)}/${familySlug("Deep learning", "fam_0001")}`,
    );
    expect(out[0].href).toBe("/methods/imaging-image-analysis/deep-learning-fam_0001");

    // Ranked per-scholar query: filtered to active/non-deleted, ordered desc.
    const args = mockScholarFamilyFindMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      cwid: CWID,
      scholar: { deletedAt: null, status: "active" },
    });
    expect(args.orderBy).toEqual([{ pmidCount: "desc" }, { familyId: "asc" }]);
  });

  it("EXCLUDES a #800-suppressed family even when it has the highest pmidCount", async () => {
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Secret" },
    ]);
    mockScholarFamilyFindMany.mockResolvedValue([
      row("Secret", "fam_0009", 99), // suppressed — must not appear despite top count
      row("Deep learning", "fam_0001", 12),
      row("MRI", "fam_0002", 6),
    ]);

    const out = await getScholarMethodFamilies(CWID);

    expect(out.map((f) => f.familyLabel)).toEqual(["Deep learning", "MRI"]);
    expect(out.some((f) => f.familyLabel === "Secret")).toBe(false);
  });

  it("EXCLUDES a #801-sensitive family ONLY when the sensitivity gate is on", async () => {
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Sensitive" },
    ]);
    mockScholarFamilyFindMany.mockResolvedValue([
      row("Sensitive", "fam_0008", 20),
      row("Deep learning", "fam_0001", 12),
    ]);

    // Gate OFF → sensitive family is public (overlay never even consulted).
    mockSensitiveGateOn.mockReturnValue(false);
    const offResult = await getScholarMethodFamilies(CWID);
    expect(offResult.map((f) => f.familyLabel)).toEqual(["Sensitive", "Deep learning"]);

    // Gate ON → sensitive family is dropped.
    mockSensitiveGateOn.mockReturnValue(true);
    const onResult = await getScholarMethodFamilies(CWID);
    expect(onResult.map((f) => f.familyLabel)).toEqual(["Deep learning"]);
  });

  it("caps the result at 5, keeping the 5 highest pmidCount families", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("F1", "fam_0001", 70),
      row("F2", "fam_0002", 60),
      row("F3", "fam_0003", 50),
      row("F4", "fam_0004", 40),
      row("F5", "fam_0005", 30),
      row("F6", "fam_0006", 20),
      row("F7", "fam_0007", 10),
    ]);

    const out = await getScholarMethodFamilies(CWID);

    expect(out).toHaveLength(5);
    expect(out.map((f) => f.familyLabel)).toEqual(["F1", "F2", "F3", "F4", "F5"]);
  });

  it("returns [] and does NOT query when the master lens is off", async () => {
    mockLensEnabled.mockReturnValue(false);

    const out = await getScholarMethodFamilies(CWID);

    expect(out).toEqual([]);
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
    expect(mockSuppressionOverlayFindMany).not.toHaveBeenCalled();
  });

  it("returns [] for an empty cwid without any DB read", async () => {
    const out = await getScholarMethodFamilies("");

    expect(out).toEqual([]);
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });
});
