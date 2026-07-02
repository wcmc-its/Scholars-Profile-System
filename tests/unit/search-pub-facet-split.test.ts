/**
 * Pub-tab performance — SEARCH_PUB_FACET_SPLIT.
 *
 * The facet aggregation is decoupled from the hit list: when the flag is on,
 * `searchPublications` fires TWO OpenSearch requests — Request A (hits,
 * `bodyNoAggs`: keeps from/size + track_total_hits, no `aggs`) and Request B
 * (facets, `{ size: 0, query, aggs }` over the UNSCORED query). Flag off keeps
 * the single combined request, byte-identical to today.
 *
 * Covers: (1) on → two correctly-shaped requests + facets hydrated from B;
 * (2) off → one combined request (parity); (3) §4.5 precision_threshold drops
 * 4000→1000 only on the split path; (4) a wedged facet request degrades to
 * empty facets instead of hanging.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    scholar: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn().mockResolvedValue(new Map()),
  fetchAuthorBylineForPmids: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/api/mentoring-pmids", () => ({
  getMentoringPmidBuckets: vi.fn().mockResolvedValue({
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  }),
}));

const capturedBodies: Array<Record<string, unknown>> = [];
// When true, the facet (size:0 + aggs) request never resolves — exercises the
// timeout degrade-to-empty path. The hits request always resolves.
let hangFacets = false;

function aggregations() {
  return {
    publicationTypes: { keys: { buckets: [{ key: "Journal Article", doc_count: 7 }] } },
    journals: { keys: { buckets: [] } },
    wcmRoleFirst: { doc_count: 0 },
    wcmRoleSenior: { doc_count: 0 },
    wcmRoleMiddle: { doc_count: 0 },
    wcmAuthors: { keys: { buckets: [] }, total: { value: 3 } },
    mentoringPrograms: {
      buckets: {
        md: { doc_count: 0 },
        mdphd: { doc_count: 0 },
        phd: { doc_count: 0 },
        postdoc: { doc_count: 0 },
        ecr: { doc_count: 0 },
      },
    },
  };
}

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PUBLICATION_FIELD_BOOSTS: [
    "title^4",
    "meshTerms^2",
    "authorNames^2",
    "journal^1",
    "abstract^0.5",
  ],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      const isFacetRequest = "aggs" in req.body && req.body.size === 0;
      if (isFacetRequest && hangFacets) return new Promise(() => {});
      return {
        body: {
          hits: { total: { value: 7 }, hits: [] },
          aggregations: aggregations(),
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

type PubResult = {
  total: number;
  facets: {
    publicationTypes: { value: string; count: number }[];
    wcmAuthorsTotal: number;
  };
};

// Pin recency off — its function_score wrapper is irrelevant to the facet
// split and covered elsewhere.
const originalRecency = process.env.SEARCH_PUB_RELEVANCE_RECENCY;
const originalSplit = process.env.SEARCH_PUB_FACET_SPLIT;

beforeEach(() => {
  capturedBodies.length = 0;
  hangFacets = false;
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
  vi.resetModules();
});

afterEach(() => {
  if (originalRecency === undefined) delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  else process.env.SEARCH_PUB_RELEVANCE_RECENCY = originalRecency;
  if (originalSplit === undefined) delete process.env.SEARCH_PUB_FACET_SPLIT;
  else process.env.SEARCH_PUB_FACET_SPLIT = originalSplit;
});

async function run(): Promise<PubResult> {
  const mod = (await import("@/lib/api/search")) as {
    searchPublications: (opts: unknown) => Promise<PubResult>;
  };
  return mod.searchPublications({ q: "cancer", page: 1 });
}

const authorPrecision = (body: Record<string, unknown>): number => {
  const aggs = body.aggs as {
    wcmAuthors: { aggs: { total: { cardinality: { precision_threshold: number } } } };
  };
  return aggs.wcmAuthors.aggs.total.cardinality.precision_threshold;
};

describe("SEARCH_PUB_FACET_SPLIT", () => {
  it("on: fires two requests — hits (no aggs) + facets (size:0 with aggs)", async () => {
    process.env.SEARCH_PUB_FACET_SPLIT = "on";
    const result = await run();

    expect(capturedBodies).toHaveLength(2);
    const facetBodies = capturedBodies.filter((b) => "aggs" in b);
    const hitsBodies = capturedBodies.filter((b) => !("aggs" in b));
    expect(facetBodies).toHaveLength(1);
    expect(hitsBodies).toHaveLength(1);

    // Request B (facets): size 0, has aggs, no from/track_total_hits/post_filter.
    expect(facetBodies[0].size).toBe(0);
    expect(facetBodies[0]).not.toHaveProperty("from");
    expect(facetBodies[0]).not.toHaveProperty("track_total_hits");
    expect(facetBodies[0]).not.toHaveProperty("post_filter");

    // Request A (hits): real page window + exact total, no aggs.
    expect(hitsBodies[0].size).toBeGreaterThan(0);
    expect(hitsBodies[0].from).toBeGreaterThan(0); // page 1 → from = PAGE_SIZE
    expect(hitsBodies[0].track_total_hits).toBe(true);

    // Total from A; facets hydrated from B.
    expect(result.total).toBe(7);
    expect(result.facets.publicationTypes).toEqual([
      { value: "Journal Article", count: 7 },
    ]);
    expect(result.facets.wcmAuthorsTotal).toBe(3);

    // §4.5 — split path drops the author cardinality precision to 1000.
    expect(authorPrecision(facetBodies[0])).toBe(1000);
  });

  it("off: one combined request carrying both hits and aggs (parity)", async () => {
    process.env.SEARCH_PUB_FACET_SPLIT = "off";
    const result = await run();

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toHaveProperty("aggs");
    expect(capturedBodies[0].size).toBeGreaterThan(0);
    expect(capturedBodies[0].track_total_hits).toBe(true);
    expect(result.facets.publicationTypes).toEqual([
      { value: "Journal Article", count: 7 },
    ]);
    // Flag-off keeps the near-exact 4000 (byte-identical body).
    expect(authorPrecision(capturedBodies[0])).toBe(4000);
  });

  it("on: a wedged facet request degrades to empty facets without hanging", async () => {
    vi.useFakeTimers();
    try {
      process.env.SEARCH_PUB_FACET_SPLIT = "on";
      hangFacets = true;
      const mod = (await import("@/lib/api/search")) as {
        searchPublications: (opts: unknown) => Promise<PubResult>;
      };
      const p = mod.searchPublications({ q: "cancer", page: 0 });
      // Trip the 5s facet timeout; the async variant flushes the microtasks so
      // the race rejects, the catch degrades to null, and Promise.all settles.
      await vi.advanceTimersByTimeAsync(5001);
      const result = await p;

      expect(result.total).toBe(7); // hits request still succeeded
      expect(result.facets.publicationTypes).toEqual([]); // facets degraded
      expect(result.facets.wcmAuthorsTotal).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
