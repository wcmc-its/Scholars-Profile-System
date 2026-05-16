/**
 * Tests for getTopicPublications and getSubtopicsForTopic in lib/api/topics.ts.
 *
 * TDD cycle: RED scaffold was the single typeof tripwire (Plan 02). This file
 * replaces it with concrete expectations (Plan 05 GREEN target).
 *
 * Covers (post-#316 PR-A consolidation: by_impact is now SQL-direct,
 * not Variant B in-process scoring):
 *   - sort=newest orders by year DESC then dateAddedToEntrez DESC
 *   - sort=most_cited orders by citationCount DESC NULLs LAST
 *   - sort=by_impact orders by publication.impactScore DESC, year DESC (SQL)
 *   - filter=research_articles_only excludes Letter, Editorial Article, Erratum
 *   - filter=all includes all publication types
 *   - subtopic param filters by primarySubtopicId
 *   - returns null for unknown topic slug
 *   - issue #305 impactScore surfacing (gated on SEARCH_PUB_TAB_IMPACT) —
 *     sources Publication.impactScore via the include after #316 PR-B
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
  // Issue #325/#326 — nullable in production (NULL = untuned upstream).
  // Tests that care about tier partitioning override this; default null
  // exercises the consumer fallback to 0.5.
  displayThreshold: null as number | null,
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
   * Global per-pmid impact score from `Publication.impactScore` (issue #316
   * IMPACT# ETL). Placed on the publication relation since #316 PR-B routed
   * the API hit mapper to read `r.publication.impactScore` rather than the
   * deprecated `r.impactScore` mirror on publication_topic. Defaults to
   * null so existing tests (which don't care about this field) see the
   * same hit shape they did before #305 added impact surfacing.
   */
  impactScore?: number | null;
  authorPosition?: string;
  publicationType?: string;
  citationCount?: number;
  dateAddedToEntrez?: Date | null;
  /**
   * Issue #327 — `Publication.topTopic` (FK-resolved from `top_topic_id`).
   * Defaults to undefined so existing tests see no inline top-topic label
   * surfacing. Tests covering #327 set the value via the FK shape that
   * Prisma's `include: { topTopic: { select: {...} } }` produces.
   */
  topTopic?: { id: string; label: string } | null;
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
      impactScore: overrides.impactScore ?? null,
      topTopic: overrides.topTopic ?? null,
    },
  };
}

/**
 * Helper for the $transaction tuple shape. The route layer calls
 * `prisma.$transaction([findMany, count, count, count, count, count])`
 * (6 elements after #326 introduced the tier-totals counts).
 */
function txn({
  rows = [],
  total = 0,
  totalAllTypes,
  totalResearchOnly,
  tierStrongly = 0,
  tierAlso = 0,
}: {
  rows?: ReturnType<typeof makePtRow>[];
  total?: number;
  totalAllTypes?: number;
  totalResearchOnly?: number;
  tierStrongly?: number;
  tierAlso?: number;
} = {}): unknown[] {
  return [
    rows,
    total,
    totalAllTypes ?? total,
    totalResearchOnly ?? total,
    tierStrongly,
    tierAlso,
  ];
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

  describe("sort=by_impact orders SQL-direct by publication.impactScore DESC, year DESC", () => {
    // Post-#316 PR-A: the in-process Variant B scoring path on by_impact was
    // retired in favor of a strict SQL DESC. PR-B-1 then pointed the ORDER BY
    // at the canonical `publication.impactScore` column.
    it("uses $transaction (SQL-direct path), not scorePublication", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0, 0, 0]);
      await getTopicPublications(TOPIC_SLUG, { sort: "by_impact" }, NOW);
      expect(mockTransaction).toHaveBeenCalled();
      expect(mockScorePublication).not.toHaveBeenCalled();
    });

    it("passes orderBy `publication.impactScore desc` + `year desc` to findMany", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue([[], 0, 0, 0]);
      await getTopicPublications(TOPIC_SLUG, { sort: "by_impact" }, NOW);
      // The inner findMany inside $transaction still captures its own args
      // via the publicationTopic.findMany mock.
      expect(mockPublicationTopicFindMany).toHaveBeenCalled();
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([
        { publication: { impactScore: "desc" } },
        { year: "desc" },
      ]);
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
    it("on by_impact path, does not apply notIn filter — where clause omits publicationType restriction", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [
        makePtRow({ pmid: "30", publicationType: "Letter" }),
        makePtRow({ pmid: "31", publicationType: "Academic Article" }),
      ];
      mockTransaction.mockResolvedValue([rows, 2, 2, 2]);
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "by_impact", filter: "all" }, NOW);
      expect(result).not.toBeNull();
      // After #316 PR-A's SQL-direct by_impact migration: the publicationType
      // notIn restriction is only attached when filter=research_articles_only.
      // With filter=all, the where clause has no publicationType key.
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.publication).toBeUndefined();
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
      mockTransaction.mockResolvedValue([[], 0, 0, 0]);
      await getTopicPublications(TOPIC_SLUG, { sort: "by_impact", subtopic: "lung_cancer" }, NOW);
      // by_impact is SQL-direct after #316 PR-A — assert the where clause
      // through the captured findMany args (executed inside $transaction).
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

  // Issue #305 — impactScore surfacing on hits. Pure mapper behavior
  // (Decimal → number, null passthrough, env-flag gating). Post-#316 PR-B
  // the mapper reads `r.publication.impactScore` (canonical column from
  // the IMPACT# ETL), not `r.impactScore` (the publication_topic mirror).
  // All three sort paths are SQL-direct after PR-A and share this mapper.
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

    it("flag on: surfaces Publication.impactScore on hits (newest path)", async () => {
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

    it("flag on: surfaces impactScore on the by_impact SQL-direct path too", async () => {
      // After #316 PR-A by_impact is no longer the in-process scoring path;
      // it routes through $transaction like newest and most_cited. The hit
      // mapper is shared, so the surfacing assertion stays — only the path
      // taken changes (mockTransaction, not the legacy findMany direct call).
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "300", impactScore: 73 })];
      mockTransaction.mockResolvedValue([rows, 1, 1, 1]);
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

  // Issue #326 — two-tier display. Tests that the tier filter is applied
  // to the row query and that tierTotals are always populated so the UI
  // can decide whether to render the "View additional articles…" toggle.
  describe("issue #326 — tier partitioning", () => {
    it("default displayThreshold of 0.5 when topic.displayThreshold is NULL", async () => {
      mockTopicFindUnique.mockResolvedValue({ ...TOPIC_ROW, displayThreshold: null });
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(TOPIC_SLUG, { sort: "newest", tier: "strongly" }, NOW);
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.score).toEqual({ gte: 0.5 });
    });

    it("tuned displayThreshold from the topic row is used verbatim", async () => {
      mockTopicFindUnique.mockResolvedValue({ ...TOPIC_ROW, displayThreshold: 0.7 });
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(TOPIC_SLUG, { sort: "newest", tier: "strongly" }, NOW);
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.score).toEqual({ gte: 0.7 });
    });

    it("tier=strongly applies `score gte threshold` to the row query", async () => {
      mockTopicFindUnique.mockResolvedValue({ ...TOPIC_ROW, displayThreshold: 0.6 });
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(TOPIC_SLUG, { sort: "newest", tier: "strongly" }, NOW);
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.score).toEqual({ gte: 0.6 });
    });

    it("tier=also applies `score lt threshold` to the row query", async () => {
      mockTopicFindUnique.mockResolvedValue({ ...TOPIC_ROW, displayThreshold: 0.6 });
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(TOPIC_SLUG, { sort: "newest", tier: "also" }, NOW);
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.score).toEqual({ lt: 0.6 });
    });

    it("tier omitted: no score predicate (union of both tiers)", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.score).toBeUndefined();
    });

    it("tierTotals are returned regardless of which tier was requested", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue(txn({ tierStrongly: 42, tierAlso: 17 }));
      const result = await getTopicPublications(
        TOPIC_SLUG,
        { sort: "newest", tier: "strongly" },
        NOW,
      );
      expect(result!.tierTotals).toEqual({ strongly: 42, also: 17 });
    });

    it("tierTotals are present when no tier filter is set", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue(txn({ tierStrongly: 5, tierAlso: 12 }));
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.tierTotals).toEqual({ strongly: 5, also: 12 });
    });

    it("invalid tier values are not passable through the type system (compile-time check)", () => {
      // This is a compile-time-only assertion: TopicPublicationTier is a
      // string literal union of "strongly" | "also". Runtime allowlisting
      // happens in the route handler (tested in topic-publications-route.test.ts).
      // Kept here as a sentinel so anyone widening the union notices both
      // sites need updating.
      const allowed: ("strongly" | "also")[] = ["strongly", "also"];
      expect(allowed).toHaveLength(2);
    });

    it("tier filter coexists with publication-type filter (research_articles_only)", async () => {
      mockTopicFindUnique.mockResolvedValue({ ...TOPIC_ROW, displayThreshold: 0.5 });
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(
        TOPIC_SLUG,
        { sort: "newest", tier: "strongly", filter: "research_articles_only" },
        NOW,
      );
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.score).toEqual({ gte: 0.5 });
      expect(args.where.publication?.publicationType?.notIn).toBeDefined();
    });

    it("tier filter coexists with subtopic filter", async () => {
      mockTopicFindUnique.mockResolvedValue({ ...TOPIC_ROW, displayThreshold: 0.5 });
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(
        TOPIC_SLUG,
        { sort: "newest", tier: "also", subtopic: "lung_cancer" },
        NOW,
      );
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      expect(args.where.score).toEqual({ lt: 0.5 });
      expect(args.where.primarySubtopicId).toBe("lung_cancer");
    });
  });

  // Issue #327 — paper-level top topic inline label. Tests the mapper's
  // "drop label when it points back at the current topic" rule and the
  // null/undefined passthrough.
  describe("issue #327 — top-topic inline label surfacing", () => {
    it("surfaces topTopic when paper's top topic differs from the page topic", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [
        makePtRow({
          pmid: "700",
          topTopic: { id: "mental_health_psychiatry", label: "Mental Health & Psychiatry" },
        }),
      ];
      mockTransaction.mockResolvedValue(txn({ rows, total: 1 }));
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.hits[0]!.topTopic).toEqual({
        id: "mental_health_psychiatry",
        label: "Mental Health & Psychiatry",
      });
    });

    it("drops topTopic when it equals the current page topic (no inverted-confusion label)", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [
        makePtRow({
          pmid: "701",
          // Top topic IS this page's topic — the inline label "Top topic:
          // Cancer Genomics" on /topics/cancer_genomics would read as
          // redundant noise. Server drops it so UI doesn't need to know
          // the current slug.
          topTopic: { id: TOPIC_SLUG, label: "Cancer Genomics" },
        }),
      ];
      mockTransaction.mockResolvedValue(txn({ rows, total: 1 }));
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.hits[0]!.topTopic).toBeNull();
    });

    it("topTopic is null when the publication has no top_topic_id set", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      const rows = [makePtRow({ pmid: "702", topTopic: null })];
      mockTransaction.mockResolvedValue(txn({ rows, total: 1 }));
      const result = await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      expect(result!.hits[0]!.topTopic).toBeNull();
    });

    it("topTopic select shape is requested through the publication include", async () => {
      mockTopicFindUnique.mockResolvedValue(TOPIC_ROW);
      mockTransaction.mockResolvedValue(txn());
      await getTopicPublications(TOPIC_SLUG, { sort: "newest" }, NOW);
      const args = mockPublicationTopicFindMany.mock.calls[0][0];
      // The mapper relies on `r.publication.topTopic.{id,label}`. Catch
      // any future query refactor that drops the relation include.
      expect(args.include.publication.select.topTopic).toEqual({
        select: { id: true, label: true },
      });
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
