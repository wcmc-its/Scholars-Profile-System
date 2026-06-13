/**
 * #974 Phase 1 — per-member "method chips" (top-3 PUBLIC method families) on the
 * DEPARTMENT and DIVISION roster page hits.
 *
 * Exercises the REAL `loadPublicFamiliesForMembers` (hoisted to
 * `lib/api/methods-roster`) through both loaders, mocking only Prisma + the flag
 * helpers. Asserts:
 *   (a) flag ON → each page hit carries its top-3 public families, pmidCount desc
 *       (dept + division);
 *   (b) the #800/#801 overlay gate drops a SUPPRESSED and a SENSITIVE family from
 *       the chips even at top pmidCount; the public family still shows;
 *   (c) flag OFF (or METHODS_LENS_ENABLED off — the helper ANDs both) → NO
 *       scholar_family query and every hit has `topMethods === undefined`.
 *
 * Mirrors `tests/unit/department-api.test.ts` + `center-methods-facet.test.ts`
 * vi.hoisted / vi.mock conventions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockScholarFindFirst,
  mockScholarFindMany,
  mockScholarCount,
  mockScholarGroupBy,
  mockDivisionFindFirst,
  mockDivisionMembershipFindMany,
  mockPublicationTopicGroupBy,
  mockPublicationAuthorGroupBy,
  mockGrantGroupBy,
  mockSuppressionFindMany,
  mockScholarFamilyFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockChipsEnabled,
  mockSensitiveGateOn,
} = vi.hoisted(() => ({
  mockScholarFindFirst: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockScholarCount: vi.fn(),
  mockScholarGroupBy: vi.fn(),
  mockDivisionFindFirst: vi.fn(),
  mockDivisionMembershipFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockPublicationAuthorGroupBy: vi.fn(),
  mockGrantGroupBy: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockChipsEnabled: vi.fn(),
  mockSensitiveGateOn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findFirst: mockScholarFindFirst,
      findMany: mockScholarFindMany,
      count: mockScholarCount,
      groupBy: mockScholarGroupBy,
    },
    division: { findFirst: mockDivisionFindFirst },
    divisionMembership: { findMany: mockDivisionMembershipFindMany },
    publicationTopic: { groupBy: mockPublicationTopicGroupBy },
    publicationAuthor: { groupBy: mockPublicationAuthorGroupBy },
    grant: { groupBy: mockGrantGroupBy },
    suppression: { findMany: mockSuppressionFindMany },
    scholarFamily: { findMany: mockScholarFamilyFindMany },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
  },
}));

// The ORG_UNIT_METHODS_CHIPS gate (read by dept/division loaders) + the #801
// sensitivity gate (read by the overlay gate inside methods-roster). The helper
// ANDs METHODS_LENS_ENABLED in production, so mocking the helper directly covers
// the "lens off → off" path (case c) without juggling two env vars.
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isOrgUnitMethodsChipsEnabled: () => mockChipsEnabled(),
  isMethodsLensSensitiveGateOn: () => mockSensitiveGateOn(),
}));

import { getDepartmentFaculty } from "@/lib/api/departments";
import { getDivisionFaculty } from "@/lib/api/divisions";

const SC = "imaging_image_analysis";

/** A `scholarFamily.findMany` row (the loader selects these columns). */
function famRow(
  cwid: string,
  familyLabel: string,
  familyId: string,
  pmidCount: number,
  exemplarTools: unknown = [],
) {
  return { cwid, supercategory: SC, familyLabel, familyId, pmidCount, exemplarTools };
}

/** A Scholar roster row with the department + division includes. */
function scholarRow(cwid: string, preferredName = `Scholar ${cwid}`) {
  return {
    cwid,
    preferredName,
    slug: `scholar-${cwid}`,
    primaryTitle: "Professor",
    roleCategory: "full_time_faculty",
    primaryDepartment: "Department of Medicine",
    overview: null,
    status: "active",
    deletedAt: null,
    department: { name: "Department of Medicine" },
    division: { name: "Cardiology" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChipsEnabled.mockReturnValue(true);
  mockSensitiveGateOn.mockReturnValue(false);
  // Roster scaffolding (pub/grant/role counts) defaults to empty so the loaders
  // hydrate hits without extra setup; the family attach is what we assert on.
  mockScholarGroupBy.mockResolvedValue([]);
  mockPublicationTopicGroupBy.mockResolvedValue([]);
  mockPublicationAuthorGroupBy.mockResolvedValue([]);
  mockGrantGroupBy.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  // Overlay gate defaults to "nothing suppressed / nothing sensitive".
  mockSuppressionOverlayFindMany.mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockResolvedValue([]);
});

describe("getDepartmentFaculty method chips (#974)", () => {
  it("attaches the top-3 PUBLIC families (pmidCount desc) to the page hits when the flag is on", async () => {
    mockScholarCount.mockResolvedValue(1);
    mockDivisionFindFirst.mockResolvedValue(null); // no divCode
    mockScholarFindMany.mockResolvedValue([scholarRow("abc1234")]);
    // 4 public families — only the top 3 by pmidCount become chips.
    mockScholarFamilyFindMany.mockResolvedValue([
      famRow("abc1234", "F1", "fam_0001", 70),
      famRow("abc1234", "F2", "fam_0002", 60),
      famRow("abc1234", "F3", "fam_0003", 50),
      famRow("abc1234", "F4", "fam_0004", 40),
    ]);

    const result = await getDepartmentFaculty("MED", {});
    const hit = result.hits[0];

    expect(hit.topMethods?.map((f) => f.familyLabel)).toEqual(["F1", "F2", "F3"]);
    expect(hit.topMethods?.map((f) => f.pmidCount)).toEqual([70, 60, 50]);
    expect(hit.topMethods).toHaveLength(3);
    // The attach is keyed on the visible page's CWIDs only (no whole-dataset agg).
    const famWhere = mockScholarFamilyFindMany.mock.calls[0][0].where;
    expect(famWhere.cwid).toEqual({ in: ["abc1234"] });
  });

  it("drops a #800-suppressed AND a #801-sensitive family from the chips, keeps the public one", async () => {
    mockSensitiveGateOn.mockReturnValue(true);
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Suppressed" },
    ]);
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Sensitive" },
    ]);
    mockScholarCount.mockResolvedValue(1);
    mockDivisionFindFirst.mockResolvedValue(null);
    mockScholarFindMany.mockResolvedValue([scholarRow("abc1234")]);
    mockScholarFamilyFindMany.mockResolvedValue([
      famRow("abc1234", "Suppressed", "fam_0009", 99), // gated out despite top count
      famRow("abc1234", "Sensitive", "fam_0008", 88), // gated out (gate on)
      famRow("abc1234", "Public", "fam_0001", 12),
    ]);

    const result = await getDepartmentFaculty("MED", {});
    const labels = result.hits[0].topMethods?.map((f) => f.familyLabel) ?? [];

    expect(labels).toEqual(["Public"]);
    expect(labels).not.toContain("Suppressed");
    expect(labels).not.toContain("Sensitive");
  });

  it("attaches NOTHING and issues NO scholar_family query when the flag is off", async () => {
    mockChipsEnabled.mockReturnValue(false);
    mockScholarCount.mockResolvedValue(1);
    mockDivisionFindFirst.mockResolvedValue(null);
    mockScholarFindMany.mockResolvedValue([scholarRow("abc1234")]);

    const result = await getDepartmentFaculty("MED", {});

    expect(result.hits[0].topMethods).toBeUndefined();
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
    expect(mockSuppressionOverlayFindMany).not.toHaveBeenCalled();
  });
});

describe("getDivisionFaculty method chips (#974)", () => {
  it("attaches the top-3 PUBLIC families (pmidCount desc) to the page hits when the flag is on", async () => {
    // Non-manual division → member CWIDs come from the scholar.findMany LDAP read.
    mockDivisionFindFirst.mockResolvedValue({ chiefCwid: null, source: "ED" });
    mockScholarFindMany
      .mockResolvedValueOnce([{ cwid: "div00001" }]) // loadDivisionMemberCwids LDAP read
      .mockResolvedValueOnce([scholarRow("div00001")]); // the page rows
    mockScholarFamilyFindMany.mockResolvedValue([
      famRow("div00001", "G1", "fam_0001", 30),
      famRow("div00001", "G2", "fam_0002", 20),
      famRow("div00001", "G3", "fam_0003", 10),
      famRow("div00001", "G4", "fam_0004", 5),
    ]);

    const result = await getDivisionFaculty("CARDIO", {});
    const hit = result.hits[0];

    expect(hit.topMethods?.map((f) => f.familyLabel)).toEqual(["G1", "G2", "G3"]);
    expect(hit.topMethods?.map((f) => f.pmidCount)).toEqual([30, 20, 10]);
    expect(hit.topMethods).toHaveLength(3);
    const famWhere = mockScholarFamilyFindMany.mock.calls[0][0].where;
    expect(famWhere.cwid).toEqual({ in: ["div00001"] });
  });

  it("drops a #800-suppressed AND a #801-sensitive family from the chips, keeps the public one", async () => {
    mockSensitiveGateOn.mockReturnValue(true);
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Suppressed" },
    ]);
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: SC, familyLabel: "Sensitive" },
    ]);
    mockDivisionFindFirst.mockResolvedValue({ chiefCwid: null, source: "ED" });
    mockScholarFindMany
      .mockResolvedValueOnce([{ cwid: "div00001" }])
      .mockResolvedValueOnce([scholarRow("div00001")]);
    mockScholarFamilyFindMany.mockResolvedValue([
      famRow("div00001", "Suppressed", "fam_0009", 99),
      famRow("div00001", "Sensitive", "fam_0008", 88),
      famRow("div00001", "Public", "fam_0001", 7),
    ]);

    const result = await getDivisionFaculty("CARDIO", {});
    const labels = result.hits[0].topMethods?.map((f) => f.familyLabel) ?? [];

    expect(labels).toEqual(["Public"]);
  });

  it("attaches NOTHING and issues NO scholar_family query when the flag is off", async () => {
    mockChipsEnabled.mockReturnValue(false);
    mockDivisionFindFirst.mockResolvedValue({ chiefCwid: null, source: "ED" });
    mockScholarFindMany
      .mockResolvedValueOnce([{ cwid: "div00001" }])
      .mockResolvedValueOnce([scholarRow("div00001")]);

    const result = await getDivisionFaculty("CARDIO", {});

    expect(result.hits[0].topMethods).toBeUndefined();
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });
});
