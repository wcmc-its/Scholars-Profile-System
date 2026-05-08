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
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockPubTopicGroupBy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findMany: mockTopicFindMany },
    subtopic: { findMany: mockSubtopicFindMany },
    publicationTopic: { groupBy: mockPubTopicGroupBy },
  },
}));

import {
  matchQueryToTaxonomy,
  normalizeForMatch,
} from "@/lib/api/search-taxonomy";

beforeEach(() => {
  mockTopicFindMany.mockReset().mockResolvedValue([]);
  mockSubtopicFindMany.mockReset().mockResolvedValue([]);
  mockPubTopicGroupBy.mockReset().mockResolvedValue([]);
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

  it("among same-tier matches, ranks by scholar count desc then alpha", async () => {
    mockTopicFindMany.mockResolvedValue([]);
    mockSubtopicFindMany.mockResolvedValue([
      {
        id: "a_inflammation",
        label: "Inflammation",
        displayName: null,
        parentTopicId: "cancer",
        parentTopic: { label: "Cancer" },
      },
      {
        id: "b_inflammation",
        label: "Inflammation",
        displayName: null,
        parentTopicId: "cardiovascular_disease",
        parentTopic: { label: "Cardiovascular Disease" },
      },
    ]);
    // First scholar count call returns 2, second 5.
    mockPubTopicGroupBy
      .mockResolvedValueOnce([{ cwid: "a1" }, { cwid: "a2" }]) // a scholars
      .mockResolvedValueOnce([{ pmid: "p1" }]) // a pubs
      .mockResolvedValueOnce([
        { cwid: "b1" },
        { cwid: "b2" },
        { cwid: "b3" },
        { cwid: "b4" },
        { cwid: "b5" },
      ]) // b scholars
      .mockResolvedValueOnce([{ pmid: "p1" }]); // b pubs

    const r = await matchQueryToTaxonomy("inflammation");
    expect(r.state).toBe("matches");
    if (r.state !== "matches") return;
    expect(r.primary.id).toBe("b_inflammation"); // higher scholar count wins
    expect(r.secondary).toHaveLength(1);
    expect(r.secondary[0].id).toBe("a_inflammation");
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
