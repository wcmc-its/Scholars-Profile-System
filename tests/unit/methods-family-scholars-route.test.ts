/**
 * #862 regression / integration — the per-family "Top scholars" route must resolve
 * the BARE `fam_NNNN` id that `FamilyScholarsRow` sends (`familyId={activeFamilyId}`),
 * run `getFamilyScholarRows`, and report `includesNonFaculty`.
 *
 * This is the gap the prior unit tests missed: they exercised `getFamilyScholarRows`
 * in isolation (mocked prisma), so a `getFamily` bare-id resolution hole left the row
 * endpoint returning `{scholars:[]}` for EVERY family — the row never rendered, even
 * with the roster-fallback flag on. This test drives the real route → `getFamily` →
 * `getFamilyScholarRows` chain (only the DB/flag/overlay layers are mocked).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGroupBy,
  mockFindMany,
  mockPubAuthorGroupBy,
  mockLensEnabled,
  mockRosterFallbackOn,
  mockLoadOverlayGate,
  mockIsFamilyVisible,
} = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
  mockFindMany: vi.fn(),
  mockPubAuthorGroupBy: vi.fn(),
  mockLensEnabled: vi.fn(),
  mockRosterFallbackOn: vi.fn(),
  mockLoadOverlayGate: vi.fn(),
  mockIsFamilyVisible: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { groupBy: mockGroupBy, findMany: mockFindMany },
    publicationAuthor: { groupBy: mockPubAuthorGroupBy },
  },
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensEnabled: () => mockLensEnabled(),
  isMethodsFamilyRosterFallbackOn: () => mockRosterFallbackOn(),
  isMethodPagesEnabled: () => true,
  isMethodsLensSensitiveGateOn: () => false,
  isMethodsFamilyDefinitionsOn: () => false,
}));
vi.mock("@/lib/api/methods-overlay", () => ({
  loadFamilyOverlayGate: () => mockLoadOverlayGate(),
  isFamilyPubliclyVisible: (sc: string, label: string, gate: unknown) =>
    mockIsFamilyVisible(sc, label, gate),
}));
vi.mock("@/lib/api/manual-layer", () => ({
  loadHiddenAuthorshipCounts: () => Promise.resolve(new Map()),
  loadPublicationSuppressions: vi.fn(),
  resolveDarkPmids: vi.fn(),
}));
vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn(),
}));

import { GET } from "@/app/api/methods/[supercategory]/families/[familyId]/scholars/route";

const SC_ID = "imaging_image_analysis";
const SC_SLUG = "imaging-image-analysis"; // supercategorySlug(SC_ID)
const FAMILY = "Deep learning";
const FAM_ID = "fam_0009"; // the bare id the FamilyScholarsRow client sends

function scholarRow(cwid: string, pmidCount: number, roleCategory: string) {
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
  mockRosterFallbackOn.mockReturnValue(true);
  mockLoadOverlayGate.mockResolvedValue({ suppressed: new Set(), sensitive: new Set() });
  mockIsFamilyVisible.mockReturnValue(true);
  mockPubAuthorGroupBy.mockResolvedValue([]);
  // getFamily makes two groupBys: by ["supercategory"], then by ["familyLabel"].
  mockGroupBy.mockImplementation((args: { by?: string[] }) => {
    if (args.by?.includes("familyLabel")) {
      return Promise.resolve([{ familyLabel: FAMILY, _max: { familyId: FAM_ID } }]);
    }
    return Promise.resolve([{ supercategory: SC_ID }]);
  });
  // getFamilyScholarRows roster: a trainee + a PI.
  mockFindMany.mockResolvedValue([
    scholarRow("post1", 8, "postdoc"),
    scholarRow("pi1", 5, "full_time_faculty"),
  ]);
});

function call(supercategory: string, familyId: string) {
  return GET({} as never, { params: Promise.resolve({ supercategory, familyId }) });
}

describe("GET /api/methods/[sc]/families/[familyId]/scholars — bare fam id resolution (#862)", () => {
  it("resolves the BARE fam_NNNN the client sends and returns includesNonFaculty + a non-empty roster", async () => {
    const res = await call(SC_SLUG, FAM_ID);
    const body = await res.json();

    // The pre-fix bug: getFamily returned null for the bare id, so this was
    // `{scholars:[]}` with NO includesNonFaculty. Now it resolves end-to-end.
    expect(body.includesNonFaculty).toBe(true);
    // Flag on ⇒ faculty-first, then the non-faculty backfill.
    expect(body.scholars.map((s: { cwid: string }) => s.cwid)).toEqual(["pi1", "post1"]);
  });

  it("400s a malformed family id", async () => {
    const res = await call(SC_SLUG, "Bad Id!");
    expect(res.status).toBe(400);
  });

  it("returns an empty roster (no resolve) for a stale id that is no family's latest", async () => {
    const res = await call(SC_SLUG, "fam_9999");
    const body = await res.json();
    expect(body.scholars).toEqual([]);
  });
});
