/**
 * Tests for lib/api/search-taxonomy.ts — taxonomy-match callout pipeline.
 *
 * Mocks Prisma per the project's vi.hoisted + vi.mock("@/lib/db") pattern.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockTopicFindMany,
  mockSubtopicFindMany,
  mockPubTopicGroupBy,
  mockMeshFindMany,
  mockEtlRunFindFirst,
  mockMeshAnchorFindMany,
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockPubTopicGroupBy: vi.fn(),
  mockMeshFindMany: vi.fn(),
  mockEtlRunFindFirst: vi.fn(),
  mockMeshAnchorFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findMany: mockTopicFindMany },
    subtopic: { findMany: mockSubtopicFindMany },
    publicationTopic: { groupBy: mockPubTopicGroupBy },
    meshDescriptor: { findMany: mockMeshFindMany },
    etlRun: { findFirst: mockEtlRunFindFirst },
    meshCuratedTopicAnchor: { findMany: mockMeshAnchorFindMany },
  },
}));

import {
  _deleteDescendantsForTests,
  _resetMeshMapForTests,
  matchQueryToTaxonomy,
  normalizeForMatch,
  resolveMeshDescriptor,
} from "@/lib/api/search-taxonomy";

beforeEach(() => {
  mockTopicFindMany.mockReset().mockResolvedValue([]);
  mockSubtopicFindMany.mockReset().mockResolvedValue([]);
  mockPubTopicGroupBy.mockReset().mockResolvedValue([]);
  mockMeshFindMany.mockReset().mockResolvedValue([]);
  mockEtlRunFindFirst.mockReset().mockResolvedValue({ manifestSha256: "sha-1" });
  mockMeshAnchorFindMany.mockReset().mockResolvedValue([]);
  _resetMeshMapForTests();
});

describe("normalizeForMatch", () => {
  it("lowercases and strips non-alphanumeric", () => {
    expect(normalizeForMatch("Cardio-Oncology")).toBe("cardiooncology");
    expect(normalizeForMatch("cardio oncology")).toBe("cardiooncology");
    expect(normalizeForMatch("Cardio—Oncology")).toBe("cardiooncology");
    expect(normalizeForMatch("  cardiooncology  ")).toBe("cardiooncology");
  });

  it("returns empty string for non-alphanumeric input", () => {
    expect(normalizeForMatch("---")).toBe("");
    expect(normalizeForMatch("")).toBe("");
  });
});

describe("matchQueryToTaxonomy", () => {
  it("returns none when query is shorter than 3 normalized chars", async () => {
    const r = await matchQueryToTaxonomy("ab");
    expect(r.state).toBe("none");
    expect(mockTopicFindMany).not.toHaveBeenCalled();
  });

  it("returns none when normalized query is empty (punctuation-only input)", async () => {
    const r = await matchQueryToTaxonomy("--");
    expect(r.state).toBe("none");
  });

  it("returns none when no entity matches", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "cancer", label: "Cancer" },
    ]);
    const r = await matchQueryToTaxonomy("nonsense");
    expect(r.state).toBe("none");
  });

  it("matches a parent topic case-insensitively, returns single primary", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "cardiovascular_disease", label: "Cardiovascular Disease" },
    ]);
    mockPubTopicGroupBy.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ cwid: `c${i}` })),
    );

    const r = await matchQueryToTaxonomy("cardiovascular disease");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.entityType).toBe("parentTopic");
    expect(r.primary.id).toBe("cardiovascular_disease");
    expect(r.primary.href).toBe("/topics/cardiovascular_disease");
    expect(r.secondary).toEqual([]);
    expect(r.overflowCount).toBe(0);
  });

  it("substring-matches a parent topic ('cancer' → 'Breast Cancer')", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "breast_cancer", label: "Breast Cancer" },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);

    const r = await matchQueryToTaxonomy("cancer");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.id).toBe("breast_cancer");
  });

  it("substring-matches a subtopic on displayName, builds parent-aware href", async () => {
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue([
      {
        id: "cardio_oncology",
        // Long LLM-canonical label is ignored for matching when displayName is set.
        label: "Conservative management of cardiovascular complications in cancer therapy",
        displayName: "Cardio-oncology",
        parentTopicId: "cardiovascular_disease",
        parentTopic: { label: "Cardiovascular Disease" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);

    const r = await matchQueryToTaxonomy("Cardio-oncology");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.entityType).toBe("subtopic");
    expect(r.primary.name).toBe("Cardio-oncology");
    expect(r.primary.href).toBe(
      "/topics/cardiovascular_disease?subtopic=cardio_oncology",
    );
  });

  it("ignores subtopic label content when displayName is set (precision over recall)", async () => {
    // Common keywords buried in long LLM-canonical labels should NOT trigger the
    // callout when the displayName doesn't carry them — keeps the surface signal-rich
    // even when /search/q=cancer would otherwise match hundreds of subtopic labels.
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue([
      {
        id: "x",
        label: "Conservative management of localized prostate cancer via active surveillance",
        displayName: "Active Surveillance & Focal Therapy",
        parentTopicId: "prostate_cancer",
        parentTopic: { label: "Prostate Cancer" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([]);

    const r = await matchQueryToTaxonomy("cancer");
    expect(r.state).toBe("none");
  });

  it("falls back to subtopic label when displayName is null (long-tail)", async () => {
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue([
      {
        id: "long_tail_sub",
        label: "Cardio-oncology",
        displayName: null,
        parentTopicId: "cv",
        parentTopic: { label: "CV" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([]);

    const r = await matchQueryToTaxonomy("cardio-oncology");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.name).toBe("Cardio-oncology");
  });

  it("ranks parent topic above subtopic when both match the same query", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "stem_cell_biology", label: "Stem Cell Biology" },
    ]);
    mockSubtopicFindMany.mockResolvedValue([
      {
        id: "stem_cell_biology_sub",
        label: "Stem Cell Biology",
        displayName: null,
        parentTopicId: "regenerative_medicine",
        parentTopic: { label: "Regenerative Medicine" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);

    const r = await matchQueryToTaxonomy("Stem Cell Biology");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.entityType).toBe("parentTopic");
    expect(r.secondary).toHaveLength(1);
    expect(r.secondary[0].entityType).toBe("subtopic");
  });

  it("among same-tier matches, ranks by scholar count desc, then similarity, then alpha", async () => {
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue([
      // Equal scholar counts → tie-break on similarity. The exact-name
      // match (similarity 1.0) wins over the longer label (≈0.57).
      {
        id: "a_inflammation",
        label: "Inflammation",
        displayName: "Inflammation",
        parentTopicId: "cancer",
        parentTopic: { label: "Cancer" },
      },
      {
        id: "b_chronic_inflammation",
        label: "Chronic Inflammation",
        displayName: "Chronic Inflammation",
        parentTopicId: "cardiovascular_disease",
        parentTopic: { label: "Cardiovascular Disease" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "x" }]);

    const r = await matchQueryToTaxonomy("inflammation");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.id).toBe("a_inflammation");
    expect(r.secondary).toHaveLength(1);
    expect(r.secondary[0].id).toBe("b_chronic_inflammation");
  });

  it("issue #74: prefers the umbrella parent topic over a more-specific sibling for broad queries", async () => {
    // Both topics substring-match "cancer". The umbrella ("Cancer Biology
    // (General)") has more scholars and should win — even though the
    // narrower sibling has higher similarity.
    mockTopicFindMany.mockResolvedValue([
      { id: "lung_cancer", label: "Lung Cancer" },
      { id: "cancer_biology_general", label: "Cancer Biology (General)" },
    ]);
    mockSubtopicFindMany.mockResolvedValue([]);
    // Return many cwids for the umbrella, few for the specific topic. The
    // mock is keyed by the where clause's parentTopicId.
    mockPubTopicGroupBy.mockImplementation(
      ({ where }: { where: { parentTopicId?: string } }) => {
        if (where.parentTopicId === "cancer_biology_general") {
          return Promise.resolve(
            Array.from({ length: 500 }, (_, i) => ({ cwid: `c${i}` })),
          );
        }
        return Promise.resolve([{ cwid: "c1" }, { cwid: "c2" }]);
      },
    );

    const r = await matchQueryToTaxonomy("cancer");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.id).toBe("cancer_biology_general");
    expect(r.secondary[0]?.id).toBe("lung_cancer");
  });

  it("topics outrank subtopics even when subtopic similarity is higher", async () => {
    mockTopicFindMany.mockResolvedValue([
      // similarity = 6/22 ≈ 0.27
      { id: "cancer_biology_general", label: "Cancer Biology (General)" },
    ]);
    mockSubtopicFindMany.mockResolvedValue([
      // similarity = 6/6 = 1.0 — but topics still win primary by type priority.
      {
        id: "cancer_sub",
        label: "Cancer",
        displayName: "Cancer",
        parentTopicId: "cancer_biology_general",
        parentTopic: { label: "Cancer Biology (General)" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "x" }]);

    const r = await matchQueryToTaxonomy("cancer");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.entityType).toBe("parentTopic");
    expect(r.secondary[0].entityType).toBe("subtopic");
  });

  it("caps secondary at 4 and reports overflowCount for the rest", async () => {
    // 6 substring-matching subtopics: 1 primary + 5 secondary; cap = 4 inline, overflow = 1.
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        id: `sub_${i}`,
        label: `Genomics variant ${i}`,
        displayName: null,
        parentTopicId: `parent_${i}`,
        parentTopic: { label: `Parent ${i}` },
      })),
    );
    // Each call returns 1 row — ensures stable scholar count of 1, alpha tiebreak.
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "x" }]);

    const r = await matchQueryToTaxonomy("genomics");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.secondary).toHaveLength(4);
    expect(r.overflowCount).toBe(1);
  });

  it("normalizes punctuation/whitespace differences for matching", async () => {
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue([
      {
        id: "cardio_oncology",
        label: "Cardio-oncology",
        displayName: "Cardio-oncology",
        parentTopicId: "cv",
        parentTopic: { label: "CV" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([]);

    // Query has different punctuation/case but should normalize identically.
    const r = await matchQueryToTaxonomy("CARDIO ONCOLOGY");
    expect(r.state).toBe("matches");
  });
});

describe("resolveMeshDescriptor (§1.5)", () => {
  const D_EHR = {
    descriptorUi: "D057286",
    name: "Electronic Health Records",
    entryTerms: ["EHR", "Electronic Medical Records"],
    scopeNote: "Media for storing electronic versions of individuals' medical records.",
    dateRevised: new Date("2024-06-01"),
    localPubCoverage: null as number | null,
  };

  it("exact name match → confidence: exact", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const r = await resolveMeshDescriptor("Electronic Health Records");
    expect(r).not.toBeNull();
    expect(r?.descriptorUi).toBe("D057286");
    expect(r?.confidence).toBe("exact");
    expect(r?.matchedForm).toBe("Electronic Health Records");
    expect(r?.curatedTopicAnchors).toEqual([]);
    // SPEC §5.4.2 — fixtures that omit `treeNumbers` resolve with self
    // only. Locks the defensive-parser contract against accidental drift.
    expect(r?.descendantUis).toEqual(["D057286"]);
  });

  it("entry-term match → confidence: entry-term, matchedForm is the entry term", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const r = await resolveMeshDescriptor("EHR");
    expect(r?.descriptorUi).toBe("D057286");
    expect(r?.confidence).toBe("entry-term");
    expect(r?.matchedForm).toBe("EHR");
  });

  it("normalization handles punctuation/whitespace/case", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D000001",
        name: "Cardio-Oncology",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    const r1 = await resolveMeshDescriptor("cardio oncology");
    expect(r1?.descriptorUi).toBe("D000001");
    _resetMeshMapForTests();
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D000001",
        name: "Cardio-Oncology",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    const r2 = await resolveMeshDescriptor("CARDIOONCOLOGY");
    expect(r2?.descriptorUi).toBe("D000001");
  });

  it("returns null when no descriptor matches", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const r = await resolveMeshDescriptor("completely made up term");
    expect(r).toBeNull();
  });

  it("returns null for under-3-char queries (no DB call)", async () => {
    const r = await resolveMeshDescriptor("ab");
    expect(r).toBeNull();
    expect(mockMeshFindMany).not.toHaveBeenCalled();
  });

  it("entryTerms field on resolution carries the full descriptor's terms", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const r = await resolveMeshDescriptor("EHR");
    expect(r?.entryTerms).toEqual(["EHR", "Electronic Medical Records"]);
  });

  it("collision: prefers exact-name match over entry-term match on a different descriptor", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D000A",
        name: "Foo",
        entryTerms: [],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
      },
      {
        descriptorUi: "D000B",
        name: "Bar",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    // D-A is exact-name; D-B is entry-term. Exact wins regardless of dateRevised.
    expect(r?.descriptorUi).toBe("D000A");
    expect(r?.confidence).toBe("exact");
  });

  it("collision: shared entry term across two descriptors, dateRevised tiebreaker", async () => {
    // Realistic case — NLM enforces canonical-name uniqueness, but two
    // descriptors can legitimately share an entry-term surface form.
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D001A",
        name: "Older Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2024-01-01"),
      },
      {
        descriptorUi: "D001B",
        name: "Newer Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D001B");
    expect(r?.confidence).toBe("entry-term");
  });

  it("§1.7 tiebreaker: higher localPubCoverage wins among same-confidence, same-anchor candidates", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_LOW",
        name: "Niche Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: 0.001,
      },
      {
        descriptorUi: "D_HIGH",
        name: "Broad Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        // Older dateRevised — would lose the pre-§1.7 tiebreaker. Coverage
        // is the new key and outranks dateRevised.
        dateRevised: new Date("2020-01-01"),
        localPubCoverage: 0.04,
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D_HIGH");
  });

  it("§1.7: NULL localPubCoverage sorts last (a populated 0 beats NULL)", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_NULL",
        name: "Null Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: null,
      },
      {
        descriptorUi: "D_ZERO",
        name: "Zero Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
        localPubCoverage: 0,
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D_ZERO");
  });

  it("§1.7: tie on coverage falls through to dateRevised", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_OLD",
        name: "Older Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2024-01-01"),
        localPubCoverage: 0.02,
      },
      {
        descriptorUi: "D_NEW",
        name: "Newer Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: 0.02,
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D_NEW");
  });

  it("§1.7: anchor-exists outranks coverage (spec line 220 order)", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_ANCHORED",
        name: "Anchored Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
        localPubCoverage: 0.001,
      },
      {
        descriptorUi: "D_BROAD",
        name: "Broad Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: 0.5,
      },
    ]);
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D_ANCHORED", parentTopicId: "some_topic" },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D_ANCHORED");
  });

  it("§1.7: fully-NULL coverage column degrades to dateRevised (pre-§1.7 ordering)", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_OLD",
        name: "Older Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2024-01-01"),
        localPubCoverage: null,
      },
      {
        descriptorUi: "D_NEW",
        name: "Newer Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: null,
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D_NEW");
  });

  it("collision: shared entry term, no dateRevised, descriptorUi ascending wins", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D050",
        name: "Concept Fifty",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: null,
      },
      {
        descriptorUi: "D040",
        name: "Concept Forty",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D040");
  });

  it("intra-descriptor entry-term collision: first array order wins for matchedForm", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D002",
        name: "E-Cadherin",
        // Both normalize to "ecadherin". Documents the array-order-wins
        // behavior — picking either is fine because they're the same
        // descriptor; only the display string differs.
        entryTerms: ["E-cadherin", "E cadherin"],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    const r = await resolveMeshDescriptor("e cadherin");
    expect(r?.descriptorUi).toBe("D002");
    // Exact-name match wins over either entry-term, so matchedForm is the
    // descriptor's canonical name. The intra-descriptor entry-term collision
    // is only reachable when the canonical name differs from those terms.
    expect(r?.matchedForm).toBe("E-Cadherin");
  });

  it("curatedTopicAnchors is [] when the descriptor has no anchor row", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    // mockMeshAnchorFindMany defaults to [] in beforeEach.
    const r = await resolveMeshDescriptor("EHR");
    expect(r?.curatedTopicAnchors).toEqual([]);
  });

  it("cache reuse when EtlRun manifest sha is unchanged", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    await resolveMeshDescriptor("EHR");
    await resolveMeshDescriptor("Electronic Health Records");
    expect(mockMeshFindMany).toHaveBeenCalledTimes(1);
  });

  it("resolver returns null and does not throw when prisma rejects", async () => {
    mockMeshFindMany.mockRejectedValue(new Error("db down"));
    mockEtlRunFindFirst.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveMeshDescriptor("EHR");
    expect(r).toBeNull();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("mesh_map_load_failed");
    warn.mockRestore();
  });

  it("drops non-string entry terms and logs a warning (ETL contract violation)", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D003",
        name: "Some Concept",
        // Mixed array — the loader keeps strings, drops the rest, warns once.
        entryTerms: ["Valid Term", 42, null, "Another"],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveMeshDescriptor("valid term");
    expect(r?.descriptorUi).toBe("D003");
    expect(r?.entryTerms).toEqual(["Valid Term", "Another"]);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("mesh_map_load_warning");
    expect(logged).toContain("non_string_entry_terms");
    warn.mockRestore();
  });
});

describe("matchQueryToTaxonomy × meshResolution integration (§1.5)", () => {
  it("state: 'none' includes meshResolution: null when neither curated nor MeSH match", async () => {
    const r = await matchQueryToTaxonomy("nothingmatches");
    expect(r.state).toBe("none");
    expect(r.meshResolution).toBeNull();
  });

  it("state: 'none' carries the MeSH resolution when only MeSH matches", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D057286",
        name: "Electronic Health Records",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    const r = await matchQueryToTaxonomy("Electronic Health Records");
    expect(r.state).toBe("none");
    expect(r.meshResolution?.descriptorUi).toBe("D057286");
  });

  it("state: 'matches' carries the MeSH resolution alongside curated matches", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "ehr_topic", label: "Electronic Health Records" },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D057286",
        name: "Electronic Health Records",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    const r = await matchQueryToTaxonomy("Electronic Health Records");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.id).toBe("ehr_topic");
    expect(r.meshResolution?.descriptorUi).toBe("D057286");
  });

  it("curated taxonomy still resolves when MeSH lookup throws", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "ehr_topic", label: "Electronic Health Records" },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);
    mockMeshFindMany.mockRejectedValue(new Error("db down"));
    mockEtlRunFindFirst.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await matchQueryToTaxonomy("Electronic Health Records");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.id).toBe("ehr_topic");
    expect(r.meshResolution).toBeNull();
    warn.mockRestore();
  });

  it("under-3-char query returns state: 'none' with meshResolution: null and no DB calls", async () => {
    const r = await matchQueryToTaxonomy("ab");
    expect(r.state).toBe("none");
    expect(r.meshResolution).toBeNull();
    expect(mockMeshFindMany).not.toHaveBeenCalled();
    expect(mockTopicFindMany).not.toHaveBeenCalled();
  });
});

describe("resolveMeshDescriptor × curatedTopicAnchors (§1.4)", () => {
  const D_EHR = {
    descriptorUi: "D057286",
    name: "Electronic Health Records",
    entryTerms: ["EHR"],
    scopeNote: null,
    dateRevised: new Date("2024-06-01"),
  };

  it("populates curatedTopicAnchors from anchor rows", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D057286", parentTopicId: "biomedical_informatics" },
    ]);
    const r = await resolveMeshDescriptor("Electronic Health Records");
    expect(r?.curatedTopicAnchors).toEqual(["biomedical_informatics"]);
  });

  it("descriptor with multiple anchor rows returns all parent_topic_id values", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D057286", parentTopicId: "biomedical_informatics" },
      { descriptorUi: "D057286", parentTopicId: "digital_health_telemedicine" },
    ]);
    const r = await resolveMeshDescriptor("EHR");
    expect(r?.curatedTopicAnchors.sort()).toEqual([
      "biomedical_informatics",
      "digital_health_telemedicine",
    ]);
  });

  it("anchor-exists tiebreaker: same entry-term confidence, with-anchor wins regardless of dateRevised", async () => {
    // D-X has an anchor and is OLDER (would lose dateRevised);
    // D-Y has no anchor and is NEWER (would win dateRevised).
    // Anchor-exists fires above dateRevised, so D-X must win.
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D-X",
        name: "X Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
      },
      {
        descriptorUi: "D-Y",
        name: "Y Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
      },
    ]);
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D-X", parentTopicId: "some_topic" },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D-X");
    expect(r?.curatedTopicAnchors).toEqual(["some_topic"]);
  });

  it("anchor-exists check is a tie when both candidates have anchors → dateRevised fallback", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D-X",
        name: "X Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
      },
      {
        descriptorUi: "D-Y",
        name: "Y Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
      },
    ]);
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D-X", parentTopicId: "t1" },
      { descriptorUi: "D-Y", parentTopicId: "t2" },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D-Y"); // newer dateRevised
  });

  it("anchor-exists check falls through to dateRevised when neither has anchor", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D-X",
        name: "X Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
      },
      {
        descriptorUi: "D-Y",
        name: "Y Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
      },
    ]);
    // mockMeshAnchorFindMany defaults to [] — no anchors anywhere.
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D-Y"); // dateRevised fallback fires
  });

  it("exact-match confidence beats anchor-exists (confidence is the first tiebreaker)", async () => {
    // D-Anchored is an entry-term match WITH an anchor; D-Exact is the
    // exact-name match WITHOUT an anchor. Exact wins.
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D-Anchored",
        name: "Other Name",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
      },
      {
        descriptorUi: "D-Exact",
        name: "Foo",
        entryTerms: [],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
      },
    ]);
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D-Anchored", parentTopicId: "some_topic" },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descriptorUi).toBe("D-Exact");
    expect(r?.confidence).toBe("exact");
    expect(r?.curatedTopicAnchors).toEqual([]); // exact winner has no anchor
  });

  it("anchor table is loaded once per cache lifetime", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D-1",
        name: "One",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    mockMeshAnchorFindMany.mockResolvedValue([]);
    await resolveMeshDescriptor("one");
    await resolveMeshDescriptor("one");
    expect(mockMeshAnchorFindMany).toHaveBeenCalledTimes(1);
  });

  it("anchor load failure does not break the resolver (fail-closed envelope still fires)", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D-1",
        name: "One",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
      },
    ]);
    mockMeshAnchorFindMany.mockRejectedValue(new Error("anchor table read failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveMeshDescriptor("one");
    expect(r).toBeNull();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("mesh_map_load_failed");
    warn.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #259 / SPEC §5.4.2 — resolver descendant precompute
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveMeshDescriptor — §5.4.2 descendant precompute", () => {
  /**
   * Fixture builder for the §5.4.2 tests. Real descriptors carry
   * `treeNumbers`; these are required for the prefix-index build.
   */
  function descriptor(
    descriptorUi: string,
    name: string,
    treeNumbers: string[],
    extra: Partial<{ entryTerms: string[] }> = {},
  ) {
    return {
      descriptorUi,
      name,
      entryTerms: extra.entryTerms ?? [],
      treeNumbers,
      scopeNote: null,
      dateRevised: null,
      localPubCoverage: null,
    };
  }

  it("§8.3 #1 — one tree number, no children → descendantUis = [self]", async () => {
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_A", "Alpha", ["C14.280.123"]),
    ]);
    const r = await resolveMeshDescriptor("Alpha");
    expect(r?.descendantUis).toEqual(["D_A"]);
  });

  it("§8.3 #2 — one tree with two children → [self, child1, child2] in tn-sorted order", async () => {
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_PARENT", "Parent", ["C14.280"]),
      descriptor("D_CHILD1", "Child1", ["C14.280.123"]),
      descriptor("D_CHILD2", "Child2", ["C14.280.456"]),
    ]);
    const r = await resolveMeshDescriptor("Parent");
    expect(r?.descendantUis).toEqual(["D_PARENT", "D_CHILD1", "D_CHILD2"]);
  });

  it("§8.3 #3 — multiple tree numbers with descendants under each → union, deduped, self at index 0", async () => {
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_MULTI", "Multi", ["C14.280", "G09.330"]),
      descriptor("D_C_CHILD", "CChild", ["C14.280.111"]),
      descriptor("D_G_CHILD", "GChild", ["G09.330.222"]),
    ]);
    const r = await resolveMeshDescriptor("Multi");
    expect(r?.descendantUis?.[0]).toBe("D_MULTI");
    expect(r?.descendantUis?.slice(1).sort()).toEqual(["D_C_CHILD", "D_G_CHILD"]);
    expect(r?.descendantUis?.length).toBe(3);
  });

  it("§8.3 #4 — wide subtree → cap at 200 with self always at index 0", async () => {
    const rows = [descriptor("D_ROOT", "Root", ["C14"])];
    for (let i = 0; i < 250; i++) {
      const idx = String(i).padStart(3, "0");
      rows.push(descriptor(`D_CHILD_${idx}`, `Child${idx}`, [`C14.${idx}`]));
    }
    mockMeshFindMany.mockResolvedValue(rows);
    const r = await resolveMeshDescriptor("Root");
    expect(r?.descendantUis?.length).toBe(200);
    expect(r?.descendantUis?.[0]).toBe("D_ROOT");
  });

  it("§8.3 #5 — hot cache: identical array reference returned on consecutive resolves (eager precompute populated the cache)", async () => {
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_HOT", "Hot", ["A.1"]),
    ]);
    const r1 = await resolveMeshDescriptor("Hot");
    const r2 = await resolveMeshDescriptor("Hot");
    expect(r1?.descendantUis).toBe(r2?.descendantUis);
  });

  it("§8.3 #5b — invariant assertion: throws when descendantsByUi is missing the resolved descriptor", async () => {
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_HOT", "Hot", ["A.1"]),
    ]);
    // Warm the cache so descendantsByUi is populated, then evict the
    // one entry the next resolve would read. This is the only path the
    // throw exercises today; production code never reaches it.
    await resolveMeshDescriptor("Hot");
    _deleteDescendantsForTests("D_HOT");
    await expect(resolveMeshDescriptor("Hot")).rejects.toThrow(
      /invariant violation: descendantsByUi missing entry for D_HOT/,
    );
  });

  it("§8.3 #6 — cache reload (manifest sha changes) → descendants recomputed, no carry-over", async () => {
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_X", "Xenon", ["A.1"]),
    ]);
    const r1 = await resolveMeshDescriptor("Xenon");
    expect(r1?.descendantUis).toEqual(["D_X"]);

    // Simulate a MeSH ETL run that adds a child descriptor under A.1.
    _resetMeshMapForTests();
    mockEtlRunFindFirst.mockResolvedValue({ manifestSha256: "sha-2" });
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_X", "Xenon", ["A.1"]),
      descriptor("D_X_CHILD", "XenonChild", ["A.1.1"]),
    ]);
    const r2 = await resolveMeshDescriptor("Xenon");
    expect(r2?.descendantUis).toEqual(["D_X", "D_X_CHILD"]);
  });

  it("§8.3 #7 — empty treeNumbers in a production-sized load (>100 rows) → [self] + one aggregate warn fires", async () => {
    // Padding rows have plausible tree numbers so they don't all trigger
    // the empty-trees aggregate. Only the one target row has [].
    const rows = [descriptor("D_NOTREES", "Notrees", [])];
    for (let i = 0; i < 120; i++) {
      const idx = String(i).padStart(3, "0");
      rows.push(descriptor(`D_PAD_${idx}`, `Pad${idx}`, [`Z.${idx}`]));
    }
    mockMeshFindMany.mockResolvedValue(rows);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveMeshDescriptor("Notrees");
    expect(r?.descendantUis).toEqual(["D_NOTREES"]);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("empty_tree_numbers");
    expect(logged).toContain('"descriptorsWithEmptyTreeNumbers":1');
    warn.mockRestore();
  });

  it("§8.3 #7 (threshold) — empty treeNumbers in a small (≤100 rows) load → warn does NOT fire", async () => {
    mockMeshFindMany.mockResolvedValue([
      descriptor("D_NOTREES", "Notrees", []),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveMeshDescriptor("Notrees");
    expect(r?.descendantUis).toEqual(["D_NOTREES"]);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("empty_tree_numbers");
    warn.mockRestore();
  });
});
