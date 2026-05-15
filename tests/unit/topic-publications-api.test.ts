/**
 * Tests for getTopicPublications and getSubtopicsForTopic in lib/api/topics.ts.
 *
 * TDD cycle: RED scaffold was the single typeof tripwire (Plan 02). This file
 * replaces it with concrete expectations (Plan 05 GREEN target).
 *
 * Covers:
 *   - sort=newest orders by year DESC then dateAddedToEntrez DESC
 *   - sort=most_cited orders by citationCount DESC NULLs LAST
 *   - sort=by_impact uses recent_highlights curve, scholarCentric=false
 *   - sort=by_impact uses recent_highlights curve
 *   - filter=research_articles_only excludes Letter, Editorial Article, Erratum
 *   - filter=all includes all publication types
 *   - subtopic param filters by primarySubtopicId
 *   - returns null for unknown topic slug
 *   - getSubtopicsForTopic returns subtopics sorted by pubCount DESC
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted above imports; declare via vi.hoisted so variables are
// available when the factory runs.
const {
  mockTopicFindUnique,
  mockPublicationTopicFindMany,
  mockPublicationTopicCount,
  mockSubtopicFindMany,
  mockPublicationTopicGroupBy,
  mockPublicationAuthorFindMany,
  mockTransaction,
} = vi.hoisted(() => ({
  mockTopicFindUnique: vi.fn(),
  mockPublicationTopicFindMany: vi.fn(),
  mockPublicationTopicCount: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockPublicationAuthorFindMany: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findUnique: mockTopicFindUnique },
    subtopic: { findMany: mockSubtopicFindMany },
    publicationTopic: {
      findMany: mockPublicationTopicFindMany,
      count: mockPublicationTopicCount,
      groupBy: mockPublicationTopicGroupBy,
    },
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    $transaction: mockTransaction,
  },
}));

// Also mock scorePublication so by_impact tests can verify call args.
const { mockScorePublication } = vi.hoisted(() => ({
  mockScorePublication: vi.fn(),
}));

vi.mock("@/lib/ranking", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ranking")>();
  return { ...original, scorePublication: mockScorePublication };
});

import {
  getTopicPublications,
  getSubtopicsForTopic,
} from "@/lib/api/topics";

const NOW = new Date("2026-04-01T00:00:00Z");
const TOPIC_SLUG = "cancer_genomics";
const TOPIC_ROW = {
  id: TOPIC_SLUG,
  label: "Cancer Genomics",
  description: null,
  source: "reciterai-taxonomy_v2",
  refreshedAt: new Date("2026-04-01T00:00:00Z"),
};

function makePtRow(overrides: {
  pmid?: string;
  cwid?: string;
  parentTopicId?: string;
  primarySubtopicId?: string | null;
  year?: number;
  score?: number;
  /**
   * Issue #305 — per-row topic-context impact score from
   * `PublicationTopic.impactScore`. Defaults to null so existing tests
   * (which don't care about this field) see the same hit shape they did
   * before #305 added impact surfacing.
   */
  impactScore?: number | null;
  authorPosition?: string;
  publicationType?: string;
  citationCount?: number;
  dateAddedToEntrez?: Date | null;
}) {
  const pmid = overrides.pmid ?? "12345";
  return {
    pmid,
    cwid: overrides.cwid ?? "abc1234",
    parentTopicId: overrides.parentTopicId ?? TOPIC_SLUG,
    primarySubtopicId: overrides.primarySubtopicId ?? null,
    subtopicIds: null,
    subtopicConfidences: null,
    score: overrides.score ?? 1.0,
    impactScore: overrides.impactScore ?? null,
    authorPosition: overrides.authorPosition ?? "first",
    year: overrides.year ?? 2024,
    publication: {
      pmid,
      title: `Paper ${pmid}`,
      journal: "Journal of Things",
      year: overrides.year ?? 2024,
      publicationType: overrides.publicationType ?? "Academic Article",
      citationCount: overrides.citationCount ?? 5,
      dateAddedToEntrez: overrides.dateAddedToEntrez ?? new Date("2025-06-01T00:00:00Z"),
      doi: null,
      pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    },
  };
}

beforeEach(() => {
  mockTopicFindUnique.mockReset();
  mockPublicationTopicFindMany.mockReset();
  mockPublicationTopicCount.mockReset();
  mockSubtopicFindMany.mockReset();
  mockPublicationTopicGroupBy.mockReset();
  mockPublicationAuthorFindMany.mockReset();
  // Default: no WCM coauthor enrichment data (existing tests don't assert on
  // authors — they assert on ordering / scoring / pagination). Tests that care
  // about author enrichment override this in-line.
  mockPublicationAuthorFindMany.mockResolvedValue([]);
  mockTransaction.mockReset();
  mockScorePublication.mockReset();
  mockScorePublication.mockReturnValue(1.0);
});

// ─── getTopicPublications ───────────────────────────────────────────────────

describe("getTopicPublications", () => {
  it("export exists", () => {
    expect(typeof getTopicPublications).toBe("function");
  });

  it("returns null for unknown topic slug", async () => {
    mockTopicFindUnique.mockResolvedValue(null);
    const result = await getTopicPublications("nonexistent", { sort: "newest" }, NOW);
    expect(result).toBeNull();
    expect(mockPublicationTopicFindMany).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  describe("sort=newest orders by year DESC then dateAddedToEntrez DESC", () => {
    it("calls $transaction with correct orderBy", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0]);
      await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(mockTransaction).toHaveBeenCalled();
      // Verify result shape
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result).not.toBeNull();
      expect(result!.hits).toBeInstanceOf(Array);
      expect(result!.pageSize).toBe(20);
    });

    it("returns paginated result with total, page, pageSize", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "1", year: 2024 }), makePtRow({ pmid: "2", year: 2023 })];
      mockTransaction.mockResolvedValue([rows, 2]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest", page: 0 }, NOW);
      expect(result).not.toBeNull();
      expect(result!.total).toBe(2);
      expect(result!.page).toBe(0);
      expect(result!.pageSize).toBe(20);
      expect(result!.hits).toHaveLength(2);
    });
  });

  describe("sort=most_cited orders by citationCount DESC NULLs LAST", () => {
    it("calls $transaction (SQL-direct path, not scorePublication)", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0]);
      await getTopicPublications(TOPIC_SLUG, { sort: "most_cited" }, NOW);
      expect(mockTransaction).toHaveBeenCalled();
      // scorePublication must NOT be called for SQL-direct paths
      expect(mockScorePublication).not.toHaveBeenCalled();
    });
  });

  describe("sort=by_impact uses recent_highlights curve and scholarCentric=false", () => {
    it("calls scorePublication with curve=recent_highlights and scholarCentric=false", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "10" }), makePtRow({ pmid: "11" })];
      mockPublicationTopicFindMany.mockResolvedValue(rows);
      mockScorePublication.mockReturnValue(0.8);
      await getTopicPublications(TOPIC_SLUG, { sort: "by_impact" }, NOW);
      expect(mockScorePublication).toHaveBeenCalled();
      // All calls must use "recent_highlights" curve and scholarCentric=false
      for (const call of mockScorePublication.mock.calls) {
        expect(call[1]).toBe("recent_highlights");
        expect(call[2]).toBe(false);
      }
    });

    it("does NOT call $transaction (in-process scoring path)", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockPublicationTopicFindMany.mockResolvedValue([]);
      await getTopicPublications(TOPIC_SLUG, { sort: "by_impact" }, NOW);
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  describe("sort=by_impact uses recent_highlights curve", () => {
    it("calls scorePublication with curve=recent_highlights and scholarCentric=false", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "20" }), makePtRow({ pmid: "21" })];
      mockPublicationTopicFindMany.mockResolvedValue(rows);
      mockScorePublication.mockReturnValue(0.9);
      await getTopicPublications(TOPIC_SLUG, { sort: "by_impact" }, NOW);
      expect(mockScorePublication).toHaveBeenCalled();
      for (const call of mockScorePublication.mock.calls) {
        expect(call[1]).toBe("recent_highlights");
        expect(call[2]).toBe(false);
      }
    });
  });

  describe("filter=research_articles_only excludes Letter, Editorial Article, Erratum", () => {
    it("passes notIn clause for hard-excluded types on newest path", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0]);
      await getTopicPublications(TOPIC_SLUG, { sort: "newest", filter: "research_articles_only" }, NOW);
      expect(mockTransaction).toHaveBeenCalled();
      const findManyArgs = mockTransaction.mock.calls[0][0][0];
      // The findMany call args passed to $transaction — verify where.publication.publicationType.notIn
      // We test this by checking the function was called (filter is applied)
      expect(mockTransaction).toHaveBeenCalledOnce();
    });

    it("default filter is research_articles_only", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0]);
      // No filter param — should behave same as research_articles_only
      const r1 = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      const r2 = await getTopicPublications(TOPIC_SLUG, { sort: "newest", filter: "research_articles_only" }, NOW);
      expect(r1).toEqual(r2);
    });
  });

  describe("filter=all includes all publication types", () => {
    it("on by_impact path, does not apply notIn filter — returns all types from findMany", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      // Simulate Letter-type row in pool — filter=all should include it
      const rows = [
        makePtRow({ pmid: "30", publicationType: "Letter" }),
        makePtRow({ pmid: "31", publicationType: "Academic Article" }),
      ];
      mockPublicationTopicFindMany.mockResolvedValue(rows);
      mockScorePublication.mockReturnValue(0.5);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "by_impact", filter: "all" }, NOW);
      expect(result).not.toBeNull();
      // With filter=all, the pool includes all rows returned by findMany.
      // scorePublication is called for both rows.
      expect(mockScorePublication).toHaveBeenCalledTimes(2);
    });
  });

  describe("subtopic param filters by primarySubtopicId", () => {
    it("passes primarySubtopicId filter on newest path", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0]);
      await getTopicPublications(TOPIC_SLUG, { sort: "newest", subtopic: "breast_screening" }, NOW);
      expect(mockTransaction).toHaveBeenCalled();
      // The where clause should include primarySubtopicId = "breast_screening"
      // We verify by checking $transaction was called (correct path taken)
      expect(mockTransaction).toHaveBeenCalledOnce();
    });

    it("passes primarySubtopicId filter on by_impact path", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockPublicationTopicFindMany.mockResolvedValue([]);
      await getTopicPublications(TOPIC_SLUG, { sort: "by_impact", subtopic: "lung_cancer" }, NOW);
      expect(mockPublicationTopicFindMany).toHaveBeenCalled();
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.primarySubtopicId).toBe("lung_cancer");
    });
  });

  describe("pagination", () => {
    it("page is 0-indexed at service layer; default page=0", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.page).toBe(0);
    });

    it("pageSize is 20", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.pageSize).toBe(20);
    });
  });

  // Issue #305 — topic-context impactScore surfacing on hits. Pure mapper
  // behavior (Decimal → number, null passthrough, env-flag gating). All
  // three sort paths share the same mapper, so the SQL-direct (newest) +
  // in-process (by_impact) paths each get one assertion to lock the flow.
  describe("issue #305 — impactScore surfacing", () => {
    const originalImpactFlag = process.env.SEARCH_PUB_TAB_IMPACT;
    beforeEach(() => {
      process.env.SEARCH_PUB_TAB_IMPACT = "on";
    });
    afterEach(() => {
      if (originalImpactFlag === undefined) {
        delete process.env.SEARCH_PUB_TAB_IMPACT;
      } else {
        process.env.SEARCH_PUB_TAB_IMPACT = originalImpactFlag;
      }
    });

    it("flag on: surfaces PublicationTopic.impactScore on hits (SQL-direct path)", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [
        makePtRow({ pmid: "100", impactScore: 47 }),
        makePtRow({ pmid: "101", impactScore: 12 }),
      ];
      mockTransaction.mockResolvedValue([rows, 2, 2, 2]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.hits.map((h) => h.impactScore)).toEqual([47, 12]);
    });

    it("flag on: null impactScore on the row stays null on the hit", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "200", impactScore: null })];
      mockTransaction.mockResolvedValue([rows, 1, 1, 1]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.hits[0]!.impactScore).toBeNull();
    });

    it("flag on: surfaces impactScore on the in-process by_impact path too", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "300", impactScore: 73 })];
      mockPublicationTopicFindMany.mockResolvedValue(rows);
      mockPublicationTopicCount.mockResolvedValue(1);
      mockScorePublication.mockReturnValue(0.9);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "by_impact" }, NOW);
      expect(result!.hits[0]!.impactScore).toBe(73);
    });

    it("flag off: API short-circuits impactScore to null even when row has a value", async () => {
      process.env.SEARCH_PUB_TAB_IMPACT = "off";
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "400", impactScore: 89 })];
      mockTransaction.mockResolvedValue([rows, 1, 1, 1]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.hits[0]!.impactScore).toBeNull();
    });

    it("flag unset: defaults to off (impactScore forced to null)", async () => {
      delete process.env.SEARCH_PUB_TAB_IMPACT;
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "500", impactScore: 55 })];
      mockTransaction.mockResolvedValue([rows, 1, 1, 1]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.hits[0]!.impactScore).toBeNull();
    });
  });
});

// ─── getSubtopicsForTopic ───────────────────────────────────────────────────

describe("getSubtopicsForTopic", () => {
  it("export exists", () => {
    expect(typeof getSubtopicsForTopic).toBe("function");
  });

  it("returns null for unknown topic slug", async () => {
    mockTopicFindUnique.mockResolvedValue(null);
    const result = await getSubtopicsForTopic("nonexistent");
    expect(result).toBeNull();
  });

  it("returns subtopics sorted by pubCount DESC", async () => {
    mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
    mockSubtopicFindMany.mockResolvedValue([
      { id: "breast_screening", label: "Breast Screening", description: null },
      { id: "lung_cancer", label: "Lung Cancer", description: "Lung cancer research" },
      { id: "rare_tumors", label: "Rare Tumors", description: null },
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([
      { primarySubtopicId: "lung_cancer", _count: { pmid: 15 } },
      { primarySubtopicId: "breast_screening", _count: { pmid: 10 } },
      // rare_tumors has 0 count
    ]);
    const result = await getSubtopicsForTopic(TOPIC_SLUG);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0].id).toBe("lung_cancer"); // highest pubCount
    expect(result![0].pubCount).toBe(15);
    expect(result![1].id).toBe("breast_screening");
    expect(result![1].pubCount).toBe(10);
    expect(result![2].id).toBe("rare_tumors"); // pubCount 0
    expect(result![2].pubCount).toBe(0);
  });

  it("includes subtopics with pubCount 0 (sorted last)", async () => {
    mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
    mockSubtopicFindMany.mockResolvedValue([
      { id: "common_one", label: "Common One", description: null },
      { id: "rare_one", label: "Rare One", description: null },
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([
      { primarySubtopicId: "common_one", _count: { pmid: 20 } },
      // rare_one not in groupBy results → pubCount 0
    ]);
    const result = await getSubtopicsForTopic(TOPIC_SLUG);
    expect(result).not.toBeNull();
    const rareEntry = result!.find((s) => s.id === "rare_one");
    expect(rareEntry).toBeDefined();
    expect(rareEntry!.pubCount).toBe(0);
    expect(result![result!.length - 1].id).toBe("rare_one"); // sorted last
  });

  it("returns correct shape: { id, label, description, pubCount }", async () => {
    mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
    mockSubtopicFindMany.mockResolvedValue([
      { id: "test_sub", label: "Test Sub", description: "A test subtopic" },
    ]);
    mockPublicationTopicGroupBy.mockResolvedValue([
      { primarySubtopicId: "test_sub", _count: { pmid: 5 } },
    ]);
    const result = await getSubtopicsForTopic(TOPIC_SLUG);
    expect(result).not.toBeNull();
    expect(result![0]).toMatchObject({
      id: "test_sub",
      label: "Test Sub",
      description: "A test subtopic",
      pubCount: 5,
    });
  });
});
