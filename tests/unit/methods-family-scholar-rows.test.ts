/**
 * #862 — `getFamilyScholarRows`: the supercategory page's per-family "Top scholars"
 * row. The row was empty for any family whose attributed active scholars were all
 * non-faculty (postdocs/fellows/core staff) because the loader pushed a faculty-only
 * `roleCategory` filter into the DB `where`. The fix drops that DB carve, gates on
 * `isPubliclyDisplayed` (keeps doctoral_student/affiliate_alumni out), and — when
 * `METHODS_LENS_FAMILY_ROSTER_FALLBACK` is on — stable-partitions faculty-first so
 * PIs rank above backfilled non-faculty. With the flag OFF (the dark default) the
 * row stays FT-faculty-only, byte-identical to the pre-#862 behavior.
 *
 * Mirrors methods-scholar-families.test.ts's vi.hoisted / vi.mock conventions.
 * Asserts: faculty-first partition + #862 trainee/core backfill (flag on), the
 * FT-faculty-only path + empty-row-when-no-faculty (flag off), the #536
 * hidden-identity exclusion, the lens-off / overlay-suppressed / zero-row hides,
 * and that the DB `where` never carries a roleCategory filter (the filter is
 * in-process so the flag can toggle without re-querying).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarFamilyFindMany,
  mockPublicationAuthorGroupBy,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockLensEnabled,
  mockSensitiveGateOn,
  mockRosterFallbackOn,
} = vi.hoisted(() => ({
  mockScholarFamilyFindMany: vi.fn(),
  mockPublicationAuthorGroupBy: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockLensEnabled: vi.fn(),
  mockSensitiveGateOn: vi.fn(),
  mockRosterFallbackOn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { findMany: mockScholarFamilyFindMany },
    publicationAuthor: { groupBy: mockPublicationAuthorGroupBy },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodsLensEnabled: () => mockLensEnabled(),
  isMethodsLensSensitiveGateOn: () => mockSensitiveGateOn(),
  isMethodPagesEnabled: () => true,
  isMethodsFamilyRosterFallbackOn: () => mockRosterFallbackOn(),
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

import { getFamilyScholarRows } from "@/lib/api/methods";

const SC = "imaging_image_analysis";
const FAMILY = "Deep learning";

type Row = {
  pmidCount: number;
  scholar: {
    cwid: string;
    slug: string;
    preferredName: string;
    primaryTitle: string | null;
    primaryDepartment: string | null;
    roleCategory: string | null;
  };
};

function row(cwid: string, pmidCount: number, roleCategory: string | null): Row {
  return {
    pmidCount,
    scholar: {
      cwid,
      slug: cwid,
      preferredName: cwid.toUpperCase(),
      primaryTitle: "Researcher",
      primaryDepartment: "Radiology",
      roleCategory,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLensEnabled.mockReturnValue(true);
  mockSensitiveGateOn.mockReturnValue(false);
  // Default the roster-fallback flag ON for the partition/backfill cases below;
  // the flag-OFF (FT-faculty-only) path has its own describe block.
  mockRosterFallbackOn.mockReturnValue(true);
  mockSuppressionOverlayFindMany.mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockResolvedValue([]);
  // Total-confirmed-pub count fan-out — irrelevant to ordering, return none.
  mockPublicationAuthorGroupBy.mockResolvedValue([]);
});

describe("getFamilyScholarRows (#862)", () => {
  it("keeps faculty order unchanged for an all-faculty family", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("pi1", 12, "full_time_faculty"),
      row("pi2", 6, "full_time_faculty"),
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out?.map((s) => s.cwid)).toEqual(["pi1", "pi2"]);
  });

  it("does NOT push a roleCategory filter into the DB where", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([row("pi1", 5, "full_time_faculty")]);

    await getFamilyScholarRows(SC, FAMILY);

    const args = mockScholarFamilyFindMany.mock.calls[0][0];
    expect(args.where.scholar).toEqual({ deletedAt: null, status: "active" });
    expect(args.where.scholar.roleCategory).toBeUndefined();
    expect(args.orderBy).toEqual([{ pmidCount: "desc" }, { familyId: "asc" }]);
  });

  it("ranks faculty above a higher-pmidCount non-faculty scholar", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("post1", 40, "postdoc"), // higher count but trainee
      row("pi1", 12, "full_time_faculty"),
      row("fellow1", 9, "fellow"),
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    // Faculty first (preserving their pmidCount order), then non-faculty by count.
    expect(out?.map((s) => s.cwid)).toEqual(["pi1", "post1", "fellow1"]);
  });

  it("renders a NON-EMPTY row when ZERO faculty are attributed (the #862 guard)", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("post1", 8, "postdoc"),
      row("nfa1", 5, "non_faculty_academic"),
      row("fellow1", 3, "fellow"),
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out).not.toBeNull();
    expect(out?.map((s) => s.cwid)).toEqual(["post1", "nfa1", "fellow1"]);
  });

  it("EXCLUDES doctoral_student / affiliate_alumni even when present in the join", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("phd1", 99, "doctoral_student"), // hidden identity class — top count, still dropped
      row("alum1", 50, "affiliate_alumni"), // hidden identity class — dropped
      row("post1", 8, "postdoc"),
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out?.map((s) => s.cwid)).toEqual(["post1"]);
    expect(out?.some((s) => s.cwid === "phd1" || s.cwid === "alum1")).toBe(false);
  });

  it("returns null and does NOT query when the master lens is off", async () => {
    mockLensEnabled.mockReturnValue(false);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out).toBeNull();
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("returns null for an overlay-suppressed family without reading the roster", async () => {
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: FAMILY },
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out).toBeNull();
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("returns null when no attributed scholars survive the carve", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("phd1", 4, "doctoral_student"), // only hidden-class rows -> nothing public
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out).toBeNull();
  });
});

describe("getFamilyScholarRows (#862) — METHODS_LENS_FAMILY_ROSTER_FALLBACK off (dark default)", () => {
  beforeEach(() => {
    mockRosterFallbackOn.mockReturnValue(false);
  });

  it("returns ONLY faculty (no non-faculty backfill) for a mixed family", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("post1", 40, "postdoc"), // higher count but trainee — dropped when flag off
      row("pi1", 12, "full_time_faculty"),
      row("fellow1", 9, "fellow"), // dropped when flag off
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out?.map((s) => s.cwid)).toEqual(["pi1"]);
  });

  it("renders an EMPTY row (null) for a trainee/core-only family — the pre-#862 behavior", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      row("post1", 8, "postdoc"),
      row("nfa1", 5, "non_faculty_academic"),
      row("fellow1", 3, "fellow"),
    ]);

    const out = await getFamilyScholarRows(SC, FAMILY);

    expect(out).toBeNull();
  });

  it("still fetches all active attributed scholars (no DB roleCategory filter) so the flag toggles in-process", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([row("pi1", 5, "full_time_faculty")]);

    await getFamilyScholarRows(SC, FAMILY);

    const args = mockScholarFamilyFindMany.mock.calls[0][0];
    expect(args.where.scholar).toEqual({ deletedAt: null, status: "active" });
    expect(args.where.scholar.roleCategory).toBeUndefined();
  });
});
