/**
 * Tests for lib/api/search-taxonomy.ts — taxonomy-match callout pipeline.
 *
 * Mocks Prisma per the project's vi.hoisted + vi.mock("@/lib/db") pattern.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockTopicFindMany,
  mockSubtopicFindMany,
  mockSubtopicGroupBy,
  mockPubTopicGroupBy,
  mockMeshFindMany,
  mockEtlRunFindFirst,
  mockMeshAnchorFindMany,
  mockMeshAliasFindMany,
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockSubtopicGroupBy: vi.fn(),
  mockPubTopicGroupBy: vi.fn(),
  mockMeshFindMany: vi.fn(),
  mockEtlRunFindFirst: vi.fn(),
  mockMeshAnchorFindMany: vi.fn(),
  mockMeshAliasFindMany: vi.fn(),
}));

// #709 — loadEntityCandidates now also groupBy's subtopics for the child count.
mockSubtopicGroupBy.mockResolvedValue([]);

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findMany: mockTopicFindMany },
    subtopic: { findMany: mockSubtopicFindMany, groupBy: mockSubtopicGroupBy },
    publicationTopic: { groupBy: mockPubTopicGroupBy },
    meshDescriptor: { findMany: mockMeshFindMany },
    etlRun: { findFirst: mockEtlRunFindFirst },
    meshCuratedTopicAnchor: { findMany: mockMeshAnchorFindMany },
    meshCuratedAlias: { findMany: mockMeshAliasFindMany },
  },
}));

import {
  _clearDescendantsForTests,
  _resetMeshMapForTests,
  matchQueryToTaxonomy,
  normalizeForMatch,
  resolveMeshDescriptor,
  suggestMeshConcepts,
} from "@/lib/api/search-taxonomy";
import {
  matchesAtTokenBoundary,
  normalizeWithTokenStarts,
  singularizeForMatch,
} from "@/lib/api/normalize";

beforeEach(() => {
  mockTopicFindMany.mockReset().mockResolvedValue([]);
  mockSubtopicFindMany.mockReset().mockResolvedValue([]);
  mockSubtopicGroupBy.mockReset().mockResolvedValue([]);
  mockPubTopicGroupBy.mockReset().mockResolvedValue([]);
  mockMeshFindMany.mockReset().mockResolvedValue([]);
  mockEtlRunFindFirst.mockReset().mockResolvedValue({ manifestSha256: "sha-1" });
  mockMeshAnchorFindMany.mockReset().mockResolvedValue([]);
  mockMeshAliasFindMany.mockReset().mockResolvedValue([]);
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

  it("drops the standalone connector word 'and' so it collapses like '&' (#690)", () => {
    // "&" already strips to nothing (non-alphanumeric); the literal word "and"
    // now does too, so the two surface forms of one concept normalize alike.
    expect(normalizeForMatch("Pathology and Laboratory Medicine")).toBe(
      "pathologylaboratorymedicine",
    );
    expect(normalizeForMatch("Pathology & Laboratory Medicine")).toBe(
      "pathologylaboratorymedicine",
    );
    expect(normalizeForMatch("Biochemistry and Biophysics")).toBe(
      normalizeForMatch("Biochemistry & Biophysics"),
    );
  });

  it("only drops 'and' as a whole word, never as a substring (#690)", () => {
    expect(normalizeForMatch("Andrology")).toBe("andrology");
    expect(normalizeForMatch("island")).toBe("island");
    expect(normalizeForMatch("command")).toBe("command");
    expect(normalizeForMatch("Anderson")).toBe("anderson");
    expect(normalizeForMatch("Brand")).toBe("brand");
  });
});

describe("normalizeWithTokenStarts / matchesAtTokenBoundary (#1255)", () => {
  it("records each token's start offset in the space-stripped key", () => {
    expect(normalizeWithTokenStarts("Breast Cancer")).toEqual({
      matchKey: "breastcancer",
      tokenStarts: [0, 6],
    });
    // "&" is non-alphanumeric and drops out, like a space.
    expect(normalizeWithTokenStarts("Aging & Geroscience")).toEqual({
      matchKey: "aginggeroscience",
      tokenStarts: [0, 5],
    });
    expect(normalizeWithTokenStarts("")).toEqual({ matchKey: "", tokenStarts: [] });
  });

  it("matches at a token boundary but not mid-token", () => {
    const imaging = normalizeWithTokenStarts("Medical Imaging");
    // The bug: "aging" is a substring of "imaging" but starts mid-token.
    expect(
      matchesAtTokenBoundary(imaging.matchKey, imaging.tokenStarts, "aging"),
    ).toBe(false);

    const aging = normalizeWithTokenStarts("Aging & Geroscience");
    expect(
      matchesAtTokenBoundary(aging.matchKey, aging.tokenStarts, "aging"),
    ).toBe(true);
  });

  it("still allows token-prefix and whole-word matches", () => {
    const cv = normalizeWithTokenStarts("Cardiovascular Disease");
    // token-0 prefix
    expect(matchesAtTokenBoundary(cv.matchKey, cv.tokenStarts, "cardio")).toBe(true);
    const breast = normalizeWithTokenStarts("Breast Cancer");
    // whole second token
    expect(matchesAtTokenBoundary(breast.matchKey, breast.tokenStarts, "cancer")).toBe(
      true,
    );
    // empty query never matches
    expect(matchesAtTokenBoundary(breast.matchKey, breast.tokenStarts, "")).toBe(false);
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

  it("#1257 — collapses chip-row areas that share a display name", async () => {
    // Two distinct subtopic records reuse the same display_name under different
    // parents — the chip row should show one, not three.
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue([
      {
        id: "amr_steward_a",
        label: "Antimicrobial Resistance & Stewardship",
        displayName: "Antimicrobial Resistance & Stewardship",
        parentTopicId: "infectious_disease",
        parentTopic: { label: "Infectious Disease" },
      },
      {
        id: "amr_steward_b",
        label: "Antimicrobial Resistance & Stewardship",
        displayName: "Antimicrobial Resistance & Stewardship",
        parentTopicId: "critical_care",
        parentTopic: { label: "Critical Care" },
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }, { cwid: "c2" }]);

    const r = await matchQueryToTaxonomy("antimicrobial resistance");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    const amr = r.areas.filter(
      (a) => a.name === "Antimicrobial Resistance & Stewardship",
    );
    expect(amr).toHaveLength(1);
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

  it("#690: a department query with 'and' substring-matches the '&'-spelled topic", async () => {
    // "Gastroenterology and Hepatology" (a WCM division) now resolves to the
    // existing "...&..." topic. Before the standalone-"and" drop the surviving
    // "and" blocked the substring match. Regression guard for #690 Bucket A.
    mockTopicFindMany.mockResolvedValue([
      {
        id: "gastroenterology_hepatology",
        label: "Gastroenterology, Hepatology & Pancreatic Disease",
      },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);

    const r = await matchQueryToTaxonomy("Gastroenterology and Hepatology");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.id).toBe("gastroenterology_hepatology");
  });

  it("#1255 — 'aging' matches 'Aging & Geroscience' but not mid-word in 'Medical Imaging'", async () => {
    mockTopicFindMany.mockResolvedValue([
      { id: "aging_geroscience", label: "Aging & Geroscience" },
      { id: "medical_imaging", label: "Medical Imaging" },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);

    const r = await matchQueryToTaxonomy("aging");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    // "Medical Imaging" ("im-aging") must NOT match; only Aging & Geroscience does.
    expect(r.primary.id).toBe("aging_geroscience");
    expect(r.secondary).toHaveLength(0);
  });

  it("#1258 — folds a curated MeSH topic anchor in as a synonym match (longevity → Aging & Geroscience)", async () => {
    _resetMeshMapForTests();
    // The research area exists as a parent topic, but its name does NOT contain
    // the query — so without the anchor fold-in there is zero name match.
    mockTopicFindMany.mockResolvedValue([
      { id: "aging_geroscience", label: "Aging & Geroscience", description: null },
    ]);
    // "longevity" (D008136) resolves to a descriptor whose curated anchor is that area.
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D008136",
        name: "Longevity",
        entryTerms: [],
        scopeNote: null,
        dateRevised: new Date("2024-01-01"),
        localPubCoverage: null,
        treeNumbers: ["G07.345.500"],
      },
    ]);
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D008136", parentTopicId: "aging_geroscience" },
    ]);
    mockPubTopicGroupBy.mockResolvedValue([{ cwid: "c1" }]);

    const r = await matchQueryToTaxonomy("longevity");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.areas.map((a) => a.id)).toContain("aging_geroscience");
    const area = r.areas.find((a) => a.id === "aging_geroscience")!;
    expect(area.href).toBe("/topics/aging_geroscience");
    expect(area.scholarCount).toBe(1);
  });

  it("#1258 negative — anchor whose id matches no parentTopic candidate stays state:none (no name match)", async () => {
    _resetMeshMapForTests();
    mockTopicFindMany.mockResolvedValue([
      { id: "aging_geroscience", label: "Aging & Geroscience", description: null },
    ]);
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D000999",
        name: "Unrelated Concept",
        entryTerms: [],
        scopeNote: null,
        dateRevised: new Date("2024-01-01"),
        localPubCoverage: null,
        treeNumbers: ["Z99.999.999"],
      },
    ]);
    // Anchor IS present (so the fold-in loop runs), but points at a topic id that
    // is NOT among the candidates (a stale/non-area anchor) — must not fabricate a
    // match. Exercises the fold-in's miss path, not just an empty-anchor short-circuit.
    mockMeshAnchorFindMany.mockResolvedValue([
      { descriptorUi: "D000999", parentTopicId: "no_such_topic" },
    ]);

    const r = await matchQueryToTaxonomy("unrelated concept");
    expect(r.state).toBe("none");
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
    // §5.4.2 — synthetic single-tn (leaf in its own subtree). Empty arrays
    // would trip the empty_tree_numbers warn on every cache load and pollute
    // unrelated console.warn spies; per-fixture unique tns keep that path silent.
    treeNumbers: ["L01.700.508"],
  };

  it("exact name match → confidence: exact", async () => {
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const r = await resolveMeshDescriptor("Electronic Health Records");
    expect(r).not.toBeNull();
    expect(r?.descriptorUi).toBe("D057286");
    expect(r?.confidence).toBe("exact");
    expect(r?.matchedForm).toBe("Electronic Health Records");
    expect(r?.curatedTopicAnchors).toEqual([]);
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
        treeNumbers: ["C04.999.100"],
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
        treeNumbers: ["C04.999.100"],
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
        treeNumbers: ["A01.001"],
      },
      {
        descriptorUi: "D000B",
        name: "Bar",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        treeNumbers: ["A01.002"],
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
        treeNumbers: ["B01.001"],
      },
      {
        descriptorUi: "D001B",
        name: "Newer Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        treeNumbers: ["B01.002"],
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
        treeNumbers: ["E01.001"],
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
        treeNumbers: ["E01.002"],
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
        treeNumbers: ["E02.001"],
      },
      {
        descriptorUi: "D_ZERO",
        name: "Zero Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
        localPubCoverage: 0,
        treeNumbers: ["E02.002"],
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
        treeNumbers: ["E03.001"],
      },
      {
        descriptorUi: "D_NEW",
        name: "Newer Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: 0.02,
        treeNumbers: ["E03.002"],
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
        treeNumbers: ["E04.001"],
      },
      {
        descriptorUi: "D_BROAD",
        name: "Broad Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: 0.5,
        treeNumbers: ["E04.002"],
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
        treeNumbers: ["E05.001"],
      },
      {
        descriptorUi: "D_NEW",
        name: "Newer Concept",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        localPubCoverage: null,
        treeNumbers: ["E05.002"],
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
        treeNumbers: ["E06.001"],
      },
      {
        descriptorUi: "D040",
        name: "Concept Forty",
        entryTerms: ["Foo"],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["E06.002"],
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
        treeNumbers: ["G01.001"],
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
        treeNumbers: ["G02.001"],
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
        treeNumbers: ["L01.700.508"],
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
        treeNumbers: ["L01.700.508"],
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
    treeNumbers: ["L01.700.508"],
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
        treeNumbers: ["H01.001"],
      },
      {
        descriptorUi: "D-Y",
        name: "Y Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        treeNumbers: ["H01.002"],
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
        treeNumbers: ["H01.001"],
      },
      {
        descriptorUi: "D-Y",
        name: "Y Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        treeNumbers: ["H01.002"],
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
        treeNumbers: ["H01.001"],
      },
      {
        descriptorUi: "D-Y",
        name: "Y Concept",
        entryTerms: ["foo"],
        scopeNote: null,
        dateRevised: new Date("2026-01-01"),
        treeNumbers: ["H01.002"],
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
        treeNumbers: ["H02.001"],
      },
      {
        descriptorUi: "D-Exact",
        name: "Foo",
        entryTerms: [],
        scopeNote: null,
        dateRevised: new Date("2020-01-01"),
        treeNumbers: ["H02.002"],
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
        treeNumbers: ["I01.001"],
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
        treeNumbers: ["I01.001"],
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

describe("resolveMeshDescriptor × descendantUis (§5.4.2)", () => {
  it("descendantUis: [self] when no descendants exist", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D000001",
        name: "Foo",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280.123"],
      },
    ]);
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descendantUis).toEqual(["D000001"]);
  });

  it("single-tree-number descendant set in tn-asc order", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_PARENT",
        name: "Parent",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280"],
      },
      {
        descriptorUi: "D_CHILD_456",
        name: "Child 456",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280.456"],
      },
      {
        descriptorUi: "D_CHILD_123",
        name: "Child 123",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280.123"],
      },
    ]);
    const r = await resolveMeshDescriptor("parent");
    expect(r?.descendantUis).toEqual(["D_PARENT", "D_CHILD_123", "D_CHILD_456"]);
  });

  it("multi-tree-number union is deduped; parent first, then per-tn subtrees in tn-asc order", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_PARENT",
        name: "Parent",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280", "G09.330"],
      },
      {
        descriptorUi: "D_C14_ONLY",
        name: "C14 child",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280.123"],
      },
      {
        descriptorUi: "D_G09_ONLY",
        name: "G09 child",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["G09.330.500"],
      },
      {
        descriptorUi: "D_OVERLAP",
        name: "Overlap",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280.555", "G09.330.999"],
      },
    ]);
    const r = await resolveMeshDescriptor("parent");
    // Parent first; C14 subtree walked first (tn-asc), G09 subtree second.
    // Overlap appears once — first time reached via C14.
    expect(r?.descendantUis).toEqual([
      "D_PARENT",
      "D_C14_ONLY",
      "D_OVERLAP",
      "D_G09_ONLY",
    ]);
  });

  it("cap saturation at DESCENDANT_HARD_CAP (200)", async () => {
    // 500 children under one parent. Tree numbers zero-padded so lex sort is
    // numerically meaningful: A01.001 … A01.500. The cap takes the first 199
    // descendants (A01.001 … A01.199) plus the parent at index 0.
    const parent = {
      descriptorUi: "D_PARENT",
      name: "Parent",
      entryTerms: [],
      scopeNote: null,
      dateRevised: null,
      treeNumbers: ["A01"],
    };
    const children = Array.from({ length: 500 }, (_, i) => {
      const n = String(i + 1).padStart(3, "0");
      return {
        descriptorUi: `D_C_${n}`,
        name: `Child ${n}`,
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: [`A01.${n}`],
      };
    });
    mockMeshFindMany.mockResolvedValue([parent, ...children]);
    const r = await resolveMeshDescriptor("parent");
    expect(r?.descendantUis).toHaveLength(200);
    expect(r?.descendantUis[0]).toBe("D_PARENT");
    expect(r?.descendantUis[1]).toBe("D_C_001");
    expect(r?.descendantUis[199]).toBe("D_C_199");
  });

  it("cache reuse: precompute runs once per cache load", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D000001",
        name: "Foo",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280"],
      },
    ]);
    const r1 = await resolveMeshDescriptor("foo");
    const r2 = await resolveMeshDescriptor("foo");
    expect(mockMeshFindMany).toHaveBeenCalledTimes(1);
    expect(r1?.descendantUis).toEqual(r2?.descendantUis);
  });

  it("cache reload on manifest sha change rebuilds descendantUis", async () => {
    vi.useFakeTimers();
    try {
      mockMeshFindMany.mockResolvedValue([
        {
          descriptorUi: "D_PARENT",
          name: "Parent",
          entryTerms: [],
          scopeNote: null,
          dateRevised: null,
          treeNumbers: ["C14.280"],
        },
        {
          descriptorUi: "D_OLD_CHILD",
          name: "Old Child",
          entryTerms: [],
          scopeNote: null,
          dateRevised: null,
          treeNumbers: ["C14.280.001"],
        },
      ]);
      const r1 = await resolveMeshDescriptor("parent");
      expect(r1?.descendantUis).toEqual(["D_PARENT", "D_OLD_CHILD"]);

      // Past the 1h refresh interval AND the manifest sha differs → full reload.
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      mockEtlRunFindFirst.mockResolvedValue({ manifestSha256: "sha-2" });
      mockMeshFindMany.mockResolvedValue([
        {
          descriptorUi: "D_PARENT",
          name: "Parent",
          entryTerms: [],
          scopeNote: null,
          dateRevised: null,
          treeNumbers: ["C14.280"],
        },
        // Old child removed from corpus; new child added.
        {
          descriptorUi: "D_NEW_CHILD",
          name: "New Child",
          entryTerms: [],
          scopeNote: null,
          dateRevised: null,
          treeNumbers: ["C14.280.002"],
        },
      ]);
      const r2 = await resolveMeshDescriptor("parent");
      expect(r2?.descendantUis).toEqual(["D_PARENT", "D_NEW_CHILD"]);
      expect(r2?.descendantUis).not.toContain("D_OLD_CHILD");
      expect(mockMeshFindMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("empty treeNumbers: [] data anomaly produces [self] and emits aggregate warn", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D000001",
        name: "Foo",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: [],
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveMeshDescriptor("foo");
    expect(r?.descendantUis).toEqual(["D000001"]);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("mesh_map_load_warning");
    expect(logged).toContain("empty_tree_numbers");
    expect(logged).toContain('"descriptorsAffected":1');
    warn.mockRestore();
  });

  it("lazy-compute fallback: when descendantsByUi entry is cleared, resolver recomputes from the persisted prefix index", async () => {
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D_PARENT",
        name: "Parent",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280"],
      },
      {
        descriptorUi: "D_CHILD",
        name: "Child",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        treeNumbers: ["C14.280.001"],
      },
    ]);
    const r1 = await resolveMeshDescriptor("parent");
    const expected = r1?.descendantUis;
    expect(expected).toEqual(["D_PARENT", "D_CHILD"]);

    // Wipe the precomputed entry; do NOT reset the cache. Second resolve
    // call exercises the lazy-compute path against the persisted prefix index.
    _clearDescendantsForTests("D_PARENT");
    const r2 = await resolveMeshDescriptor("parent");
    expect(r2?.descendantUis).toEqual(expected);
    // findMany still only called once — cache load was not re-triggered.
    expect(mockMeshFindMany).toHaveBeenCalledTimes(1);
  });
});

describe("resolveMeshDescriptor — curated aliases (#642)", () => {
  const D_THORACIC = {
    descriptorUi: "D013903",
    name: "Thoracic Surgery",
    entryTerms: ["Cardiac Surgery", "Heart Surgery"],
    scopeNote: null as string | null,
    dateRevised: null as Date | null,
    localPubCoverage: null as number | null,
    treeNumbers: ["G02.403.810"],
  };

  it("resolves a curated alias to its descriptor as confidence: entry-term", async () => {
    mockMeshFindMany.mockResolvedValue([D_THORACIC]);
    mockMeshAliasFindMany.mockResolvedValue([
      { alias: "Cardiothoracic Surgery", descriptorUi: "D013903" },
    ]);
    const r = await resolveMeshDescriptor("Cardiothoracic Surgery");
    expect(r?.descriptorUi).toBe("D013903");
    expect(r?.confidence).toBe("entry-term");
  });

  it("a real NLM name wins over a conflicting alias (alias fills gaps only)", async () => {
    // Alias tries to point "Thoracic Surgery" at a different UI; the real
    // descriptor name must win because aliases merge after descriptors.
    mockMeshFindMany.mockResolvedValue([D_THORACIC]);
    mockMeshAliasFindMany.mockResolvedValue([
      { alias: "Thoracic Surgery", descriptorUi: "D999999" },
    ]);
    const r = await resolveMeshDescriptor("Thoracic Surgery");
    expect(r?.descriptorUi).toBe("D013903");
    expect(r?.confidence).toBe("exact");
  });

  it("skips an alias whose descriptor_ui is stale (absent from the descriptor table)", async () => {
    mockMeshFindMany.mockResolvedValue([D_THORACIC]);
    mockMeshAliasFindMany.mockResolvedValue([
      { alias: "Cardiothoracic Surgery", descriptorUi: "D000000" },
    ]);
    const r = await resolveMeshDescriptor("Cardiothoracic Surgery");
    expect(r).toBeNull();
  });

  it("matches an alias across punctuation/case variants (same normalization)", async () => {
    mockMeshFindMany.mockResolvedValue([D_THORACIC]);
    mockMeshAliasFindMany.mockResolvedValue([
      { alias: "Cardiothoracic Surgery", descriptorUi: "D013903" },
    ]);
    const r = await resolveMeshDescriptor("cardiothoracic-surgery");
    expect(r?.descriptorUi).toBe("D013903");
    expect(r?.confidence).toBe("entry-term");
  });

  it("#690: an alias whose surface form contains 'and' still resolves (key computed post-drop)", async () => {
    // Both the alias key (load time) and the query (resolve time) drop the
    // standalone "and", so they still meet. Guards the existing #667 aliases
    // ("Plastic and Reconstructive Surgery" etc.) against the #690 change.
    mockMeshFindMany.mockResolvedValue([
      {
        descriptorUi: "D013518",
        name: "Surgery, Plastic",
        entryTerms: [],
        scopeNote: null,
        dateRevised: null,
        localPubCoverage: null,
        treeNumbers: ["E04.555.500"],
      },
    ]);
    mockMeshAliasFindMany.mockResolvedValue([
      { alias: "Plastic and Reconstructive Surgery", descriptorUi: "D013518" },
    ]);
    const r = await resolveMeshDescriptor("Plastic and Reconstructive Surgery");
    expect(r?.descriptorUi).toBe("D013518");
    expect(r?.confidence).toBe("entry-term");
  });
});

describe("suggestMeshConcepts (#878)", () => {
  const D_EHR = {
    descriptorUi: "D057286",
    name: "Electronic Health Records",
    entryTerms: ["EHR", "Electronic Medical Records"],
    scopeNote: "Media for storing electronic versions of individuals' medical records.",
    dateRevised: new Date("2024-06-01"),
    localPubCoverage: null as number | null,
    treeNumbers: ["L01.700.508"],
  };

  afterEach(() => {
    delete process.env.SEARCH_SUGGEST_MESH_CONCEPT;
  });

  it("flag off → [] and never touches the MeSH map", async () => {
    delete process.env.SEARCH_SUGGEST_MESH_CONCEPT;
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const out = await suggestMeshConcepts("Electronic Health Records", 5);
    expect(out).toEqual([]);
    expect(mockMeshFindMany).not.toHaveBeenCalled();
  });

  it("exact name match → one candidate, confidence exact", async () => {
    process.env.SEARCH_SUGGEST_MESH_CONCEPT = "on";
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const out = await suggestMeshConcepts("Electronic Health Records", 5);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      descriptorUi: "D057286",
      name: "Electronic Health Records",
      confidence: "exact",
      matchedForm: "Electronic Health Records",
    });
  });

  it("entry-term/synonym match carries the verbatim matchedForm (the FACS case)", async () => {
    process.env.SEARCH_SUGGEST_MESH_CONCEPT = "on";
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    // "EHR" is an entry term of "Electronic Health Records" — the descriptor
    // NAME doesn't start with the query, yet it must resolve (cf. FACS → Flow
    // Cytometry), with the matched synonym preserved for the subtitle.
    const out = await suggestMeshConcepts("EHR", 5);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      descriptorUi: "D057286",
      name: "Electronic Health Records",
      confidence: "entry-term",
      matchedForm: "EHR",
    });
  });

  it("query shorter than the 3-char minimum → [] without touching the map", async () => {
    process.env.SEARCH_SUGGEST_MESH_CONCEPT = "on";
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const out = await suggestMeshConcepts("eh", 5);
    expect(out).toEqual([]);
    expect(mockMeshFindMany).not.toHaveBeenCalled();
  });

  it("a cold/failed MeSH map load contributes [] (never throws)", async () => {
    process.env.SEARCH_SUGGEST_MESH_CONCEPT = "on";
    mockMeshFindMany.mockRejectedValue(new Error("db down"));
    await expect(
      suggestMeshConcepts("Electronic Health Records", 5),
    ).resolves.toEqual([]);
  });

  it("no descriptor matches the normalized query → []", async () => {
    process.env.SEARCH_SUGGEST_MESH_CONCEPT = "on";
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const out = await suggestMeshConcepts("nonexistent concept xyz", 5);
    expect(out).toEqual([]);
  });
});

describe("resolveMeshDescriptor — decompose-and-resolve fallback (SEARCH_MESH_RESOLUTION_FALLBACK)", () => {
  const D_WEARABLE = {
    descriptorUi: "D000076251",
    name: "Wearable Electronic Devices",
    entryTerms: ["Wearable Devices"],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["J01.637.100"],
  };
  const D_MATMORT = {
    descriptorUi: "D008428",
    name: "Maternal Mortality",
    entryTerms: [],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["N01.224.100"],
  };
  const D_MORBIDITY = {
    descriptorUi: "D009017",
    name: "Morbidity",
    entryTerms: [],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["N01.224.200"],
  };
  // Homonym trap: the single common word "Seahorse" is only an ENTRY TERM here.
  const D_SEAHORSE = {
    descriptorUi: "D012691",
    name: "Smegmamorpha",
    entryTerms: ["Seahorse"],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["B01.050.150"],
  };
  const D_RADIOMICS = {
    descriptorUi: "D000095024",
    name: "Radiomics",
    entryTerms: [],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["L01.224.300"],
  };

  afterEach(() => {
    delete process.env.SEARCH_MESH_RESOLUTION_FALLBACK;
  });

  it("flag OFF: a whole-query miss stays null (byte-identical baseline)", async () => {
    delete process.env.SEARCH_MESH_RESOLUTION_FALLBACK;
    mockMeshFindMany.mockResolvedValue([D_WEARABLE]);
    expect(await resolveMeshDescriptor("Wearable devices & sensors")).toBeNull();
  });

  it("flag ON: a contiguous word-window resolves at confidence 'partial'", async () => {
    process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
    mockMeshFindMany.mockResolvedValue([D_WEARABLE]);
    const r = await resolveMeshDescriptor("Wearable devices & sensors");
    expect(r?.descriptorUi).toBe("D000076251");
    expect(r?.confidence).toBe("partial");
    expect(r?.matchedForm).toBe("wearable devices");
  });

  it("flag ON: longest-window-first picks the specific descriptor, not a generic single word", async () => {
    process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
    mockMeshFindMany.mockResolvedValue([D_MATMORT, D_MORBIDITY]);
    const r = await resolveMeshDescriptor("Maternal mortality & morbidity");
    // 2-token "maternal mortality" wins over the 1-token "morbidity".
    expect(r?.name).toBe("Maternal Mortality");
    expect(r?.confidence).toBe("partial");
  });

  it("flag ON: a single-token window is BLOCKED unless it is an exact descriptor name (homonym guard)", async () => {
    process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
    mockMeshFindMany.mockResolvedValue([D_SEAHORSE]);
    // "seahorse" matches only as an entry term → rejected → no "Seahorse → Smegmamorpha".
    expect(await resolveMeshDescriptor("Seahorse metabolic flux")).toBeNull();
  });

  it("flag ON: a single-token window resolves when it IS an exact descriptor name", async () => {
    process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
    mockMeshFindMany.mockResolvedValue([D_RADIOMICS]);
    const r = await resolveMeshDescriptor("advanced radiomics pipeline");
    expect(r?.name).toBe("Radiomics");
    expect(r?.confidence).toBe("partial");
  });

  it("flag ON: still null when no window resolves", async () => {
    process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
    mockMeshFindMany.mockResolvedValue([D_WEARABLE]);
    expect(await resolveMeshDescriptor("html parsing widget")).toBeNull();
  });

  it("#1348 flag ON: a single-token window to a GENERIC descriptor (Medicine) is blocked → null", async () => {
    process.env.SEARCH_MESH_RESOLUTION_FALLBACK = "on";
    const D_MEDICINE = {
      descriptorUi: "D008511",
      name: "Medicine",
      entryTerms: [],
      scopeNote: null,
      dateRevised: null,
      treeNumbers: ["H02.403"],
    };
    mockMeshFindMany.mockResolvedValue([D_MEDICINE]);
    // "ai"/"in" are <5 chars (window guard); "medicine" is exact-name but generic → declines.
    expect(await resolveMeshDescriptor("AI in medicine")).toBeNull();
  });
});

describe("singularizeForMatch (#1342 pure helper)", () => {
  it("strips a simple plural -s on a long-enough key", () => {
    expect(singularizeForMatch("melanomas")).toBe("melanoma");
    expect(singularizeForMatch("tumors")).toBe("tumor");
    expect(singularizeForMatch("diseases")).toBe("disease");
  });
  it("-ies → y, and -es after sibilants drops -es", () => {
    expect(singularizeForMatch("therapies")).toBe("therapy");
    expect(singularizeForMatch("boxes")).toBe("box");
    expect(singularizeForMatch("classes")).toBe("class");
  });
  it("leaves Latin/Greek -is/-us singulars and -ss words untouched", () => {
    expect(singularizeForMatch("analysis")).toBe("analysis");
    expect(singularizeForMatch("lupus")).toBe("lupus");
    expect(singularizeForMatch("abscess")).toBe("abscess");
  });
  it("respects the stop-set and the min-length guard", () => {
    expect(singularizeForMatch("aids")).toBe("aids");
    expect(singularizeForMatch("measles")).toBe("measles");
    expect(singularizeForMatch("cats")).toBe("cats"); // <5 chars → untouched
  });
});

describe("resolveMeshDescriptor — query normalization (#1342, SEARCH_MESH_QUERY_NORMALIZATION)", () => {
  const D_MELANOMA = {
    descriptorUi: "D008545",
    name: "Melanoma",
    entryTerms: [],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["C04.557.665"],
  };

  afterEach(() => {
    delete process.env.SEARCH_MESH_QUERY_NORMALIZATION;
  });

  it("flag OFF: a plural-only query stays null (byte-identical baseline)", async () => {
    delete process.env.SEARCH_MESH_QUERY_NORMALIZATION;
    mockMeshFindMany.mockResolvedValue([D_MELANOMA]);
    expect(await resolveMeshDescriptor("melanomas")).toBeNull();
  });

  it("flag ON: the singularized query resolves at confidence 'partial'", async () => {
    process.env.SEARCH_MESH_QUERY_NORMALIZATION = "on";
    mockMeshFindMany.mockResolvedValue([D_MELANOMA]);
    const r = await resolveMeshDescriptor("melanomas");
    expect(r?.descriptorUi).toBe("D008545");
    expect(r?.confidence).toBe("partial");
  });

  it("flag ON: an exact match never enters the singularize branch (stays 'exact')", async () => {
    process.env.SEARCH_MESH_QUERY_NORMALIZATION = "on";
    mockMeshFindMany.mockResolvedValue([D_MELANOMA]);
    const r = await resolveMeshDescriptor("Melanoma");
    expect(r?.confidence).toBe("exact");
  });
});

describe("resolveMeshDescriptor — acronym wrong-sense guard (#1346, SEARCH_ACRONYM_SENSE_GUARD)", () => {
  const D_AUTO = {
    descriptorUi: "D001332",
    name: "Automobiles",
    entryTerms: ["Car"],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["J01.637.051"],
  };
  const D_PETS = {
    descriptorUi: "D010372",
    name: "Pets",
    entryTerms: ["Pet"],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["B01.050.150.900"],
  };
  const D_EHR = {
    descriptorUi: "D057286",
    name: "Electronic Health Records",
    entryTerms: ["EHR"],
    scopeNote: null,
    dateRevised: null,
    treeNumbers: ["L01.700.508"],
  };

  afterEach(() => {
    delete process.env.SEARCH_ACRONYM_SENSE_GUARD;
  });

  it("flag ON: CAR (common-word entry term 'Car') is suppressed → null", async () => {
    process.env.SEARCH_ACRONYM_SENSE_GUARD = "on";
    mockMeshFindMany.mockResolvedValue([D_AUTO]);
    expect(await resolveMeshDescriptor("CAR")).toBeNull();
  });

  it("flag ON: PET (common-word entry term 'Pet') is suppressed → null", async () => {
    process.env.SEARCH_ACRONYM_SENSE_GUARD = "on";
    mockMeshFindMany.mockResolvedValue([D_PETS]);
    expect(await resolveMeshDescriptor("PET")).toBeNull();
  });

  it("flag ON: an internal-caps acronym entry term (EHR) is kept", async () => {
    process.env.SEARCH_ACRONYM_SENSE_GUARD = "on";
    mockMeshFindMany.mockResolvedValue([D_EHR]);
    const r = await resolveMeshDescriptor("EHR");
    expect(r?.descriptorUi).toBe("D057286");
    expect(r?.confidence).toBe("entry-term");
  });

  it("flag OFF: CAR still resolves to Automobiles (byte-identical baseline)", async () => {
    delete process.env.SEARCH_ACRONYM_SENSE_GUARD;
    mockMeshFindMany.mockResolvedValue([D_AUTO]);
    const r = await resolveMeshDescriptor("CAR");
    expect(r?.descriptorUi).toBe("D001332");
  });
});
