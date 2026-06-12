/**
 * #863 — `loadMethodFamilyCandidates` surfaces a method family when the typed
 * term matches one of its MEMBER TOOL names, not only when it matches the family
 * LABEL. `scholar_tool.category` is the tool's `method_family_label` (etl/tools/
 * scholar-tool-mapper-s3), i.e. the same string surfaced as
 * `scholar_family.familyLabel`, so a contains-match over `toolName` resolves to
 * family labels that get OR'd into the family groupBy.
 *
 * Mirrors the search-api / methods-rollup vi.hoisted + vi.mock conventions. Asserts:
 *   - the Method-pages flag still hard-gates (off ⇒ `[]`, no DB calls);
 *   - a tool-name match whose family LABEL does NOT contain the term still surfaces
 *     the family (the regression #863 fixes);
 *   - the resolved family labels are OR'd into the groupBy `where`;
 *   - the #800/#801 overlay gate still drops a suppressed family even when it was
 *     matched via a member tool;
 *   - no member-tool match ⇒ the groupBy `where` carries only the label clause.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockScholarToolFindMany,
  mockScholarFamilyGroupBy,
  mockMethodPagesEnabled,
  mockLoadFamilyOverlayGate,
  mockIsFamilyPubliclyVisible,
} = vi.hoisted(() => ({
  mockScholarToolFindMany: vi.fn(),
  mockScholarFamilyGroupBy: vi.fn(),
  mockMethodPagesEnabled: vi.fn(),
  mockLoadFamilyOverlayGate: vi.fn(),
  mockIsFamilyPubliclyVisible: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarTool: { findMany: mockScholarToolFindMany },
    scholarFamily: { groupBy: mockScholarFamilyGroupBy },
  },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodPagesEnabled: () => mockMethodPagesEnabled(),
}));

vi.mock("@/lib/api/methods-overlay", () => ({
  loadFamilyOverlayGate: () => mockLoadFamilyOverlayGate(),
  isFamilyPubliclyVisible: (sc: string, label: string, gate: unknown) =>
    mockIsFamilyPubliclyVisible(sc, label, gate),
}));

// search.ts imports the OpenSearch wrapper at module load; stub it (same shape as
// search-api.test.ts) so importing the module never touches a real client.
vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.3,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 1,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_DEPT_LEADERSHIP_CHAIR_WEIGHT: 1,
  PEOPLE_DEPT_LEADERSHIP_CHIEF_WEIGHT: 1,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  MESH_ADMIT_WEIGHT: 1,
  MESH_ATTRIBUTION_WEIGHT: 1,
  MESH_ESCALATION_THRESHOLD: 1,
  MESH_MIN_MATCHED_FORM_LEN: 3,
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({}),
}));

import { loadMethodFamilyCandidates } from "@/lib/api/search";

const SC = "genome_editing";

type Group = {
  supercategory: string;
  familyLabel: string;
  _max: { familyId: string | null };
  _count: { cwid: number };
};

const group = (familyLabel: string, familyId: string, cwid: number): Group => ({
  supercategory: SC,
  familyLabel,
  _max: { familyId },
  _count: { cwid },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockMethodPagesEnabled.mockReturnValue(true);
  mockScholarToolFindMany.mockResolvedValue([]);
  mockScholarFamilyGroupBy.mockResolvedValue([]);
  // Default gate: nothing suppressed/sensitive — everything visible.
  mockLoadFamilyOverlayGate.mockResolvedValue({
    suppressed: new Set<string>(),
    sensitive: new Set<string>(),
  });
  mockIsFamilyPubliclyVisible.mockReturnValue(true);
});

describe("#863 loadMethodFamilyCandidates — member-tool-name match", () => {
  it("returns [] without touching the DB when the Method-pages flag is off", async () => {
    mockMethodPagesEnabled.mockReturnValue(false);
    const out = await loadMethodFamilyCandidates("crispr", 5);
    expect(out).toEqual([]);
    expect(mockScholarToolFindMany).not.toHaveBeenCalled();
    expect(mockScholarFamilyGroupBy).not.toHaveBeenCalled();
  });

  it("surfaces a family matched only by a member tool name (label does NOT contain the term)", async () => {
    // Typed "crispr"; the family LABEL is "Gene Knockout" (no "crispr"), but a
    // member tool is named "CRISPR-Cas9". scholar_tool.category === familyLabel.
    mockScholarToolFindMany.mockResolvedValue([{ category: "Gene Knockout" }]);
    mockScholarFamilyGroupBy.mockResolvedValue([group("Gene Knockout", "fam_0009", 7)]);

    const out = await loadMethodFamilyCandidates("crispr", 5);

    expect(out).toEqual([
      { supercategory: SC, familyId: "fam_0009", familyLabel: "Gene Knockout", scholarCount: 7 },
    ]);

    // The resolved tool family label is OR'd into the groupBy `where`.
    const where = mockScholarFamilyGroupBy.mock.calls[0]![0].where;
    expect(where.OR).toEqual([
      { familyLabel: { contains: "crispr" } },
      { familyLabel: { in: ["Gene Knockout"] } },
    ]);

    // The tool prefilter is a contains-match over toolName, non-null category,
    // distinct on category, and bounded by `take`.
    const toolArgs = mockScholarToolFindMany.mock.calls[0]![0];
    expect(toolArgs.where).toEqual({
      toolName: { contains: "crispr" },
      category: { not: null },
    });
    expect(toolArgs.distinct).toEqual(["category"]);
    expect(typeof toolArgs.take).toBe("number");
  });

  it("groupBy `where` carries only the label clause when no member tool matches", async () => {
    mockScholarToolFindMany.mockResolvedValue([]);
    mockScholarFamilyGroupBy.mockResolvedValue([group("Flow Cytometry", "fam_0001", 3)]);

    const out = await loadMethodFamilyCandidates("flow", 5);
    expect(out).toHaveLength(1);

    const where = mockScholarFamilyGroupBy.mock.calls[0]![0].where;
    expect(where.OR).toEqual([{ familyLabel: { contains: "flow" } }]);
  });

  it("dedupes the OR `in` list to distinct tool family labels", async () => {
    // Two distinct tools resolving to two distinct family labels.
    mockScholarToolFindMany.mockResolvedValue([
      { category: "Gene Knockout" },
      { category: "Base Editing" },
    ]);
    mockScholarFamilyGroupBy.mockResolvedValue([]);

    await loadMethodFamilyCandidates("editing", 5);

    const where = mockScholarFamilyGroupBy.mock.calls[0]![0].where;
    expect(where.OR).toEqual([
      { familyLabel: { contains: "editing" } },
      { familyLabel: { in: ["Gene Knockout", "Base Editing"] } },
    ]);
  });

  it("still drops a #800/#801-suppressed family even when matched via a member tool", async () => {
    mockScholarToolFindMany.mockResolvedValue([{ category: "Suppressed Family" }]);
    mockScholarFamilyGroupBy.mockResolvedValue([
      group("Suppressed Family", "fam_0042", 99),
      group("Gene Knockout", "fam_0009", 7),
    ]);
    // Gate hides only the suppressed family.
    mockIsFamilyPubliclyVisible.mockImplementation(
      (_sc: string, label: string) => label !== "Suppressed Family",
    );

    const out = await loadMethodFamilyCandidates("crispr", 5);
    expect(out.map((c) => c.familyLabel)).toEqual(["Gene Knockout"]);
    expect(out.map((c) => c.familyLabel)).not.toContain("Suppressed Family");
  });
});
