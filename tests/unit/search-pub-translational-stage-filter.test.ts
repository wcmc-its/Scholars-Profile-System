/**
 * Publications-tab `translationalStage` filter + facet
 * (`SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET`), cloned from
 * `search-pub-funding-institution-filter.test.ts`. Keys on the pub doc's
 * `translationalStage` keyword (lib/translational-stage.ts).
 *
 * Covers:
 *   - flag OFF: the filter is ignored (no post_filter clause), no agg is
 *     requested, and `facets.translationalStages === []`.
 *   - flag ON: a multi-select `terms` clause; values outside the four stages
 *     are dropped; the agg runs even with no selection (rail seed).
 *   - buckets come back in the fixed T0 -> T3-4 order regardless of count,
 *     with zero-count and unknown keys dropped.
 *   - excluding-self: the stage agg's filter carries the OTHER axis clause but
 *     NOT its own, while another axis's agg DOES carry the stage clause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicationsFilters } from "@/lib/api/search";

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

// Count order, not stage order, plus a zero-count stage and a key that is not
// a displayable stage: the mapper must reorder and drop.
const STAGE_BUCKETS = {
  keys: {
    buckets: [
      { key: "T2", doc_count: 90 },
      { key: "T0", doc_count: 40 },
      { key: "T3-4", doc_count: 12 },
      { key: "T1", doc_count: 0 },
      { key: "NA", doc_count: 7 },
    ],
  },
};

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_INDEX: "scholars-funding",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PUBLICATION_FIELD_BOOSTS: ["title^4"],
  FUNDING_FIELD_BOOSTS: ["title^4"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { index: string; body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      // Mirror real OpenSearch: echo the stage agg only when asked for.
      const aggs = (req.body.aggs ?? {}) as Record<string, unknown>;
      return {
        body: {
          hits: { total: { value: 0 }, hits: [] },
          aggregations: {
            publicationTypes: { keys: { buckets: [] } },
            journals: { keys: { buckets: [] } },
            wcmRoleFirst: { doc_count: 0 },
            wcmRoleSenior: { doc_count: 0 },
            wcmRoleMiddle: { doc_count: 0 },
            wcmAuthors: { keys: { buckets: [] }, total: { value: 0 } },
            mentoringPrograms: {
              buckets: {
                md: { doc_count: 0 },
                mdphd: { doc_count: 0 },
                phd: { doc_count: 0 },
                postdoc: { doc_count: 0 },
                ecr: { doc_count: 0 },
              },
            },
            ...(aggs.translationalStages ? { translationalStages: STAGE_BUCKETS } : {}),
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

function postFilterClauses(body: Record<string, unknown>): Record<string, unknown>[] {
  const pf = body.post_filter as { bool?: { filter?: Record<string, unknown>[] } } | undefined;
  return pf?.bool?.filter ?? [];
}

function aggFilterClauses(body: Record<string, unknown>, aggName: string) {
  const aggs = body.aggs as Record<
    string,
    { filter: { bool: { filter: Record<string, unknown>[] } } }
  >;
  return aggs[aggName].filter.bool.filter;
}

function aggTerms(body: Record<string, unknown>, aggName: string) {
  const aggs = body.aggs as Record<
    string,
    { aggs: { keys: { terms: { field: string; size: number } } } }
  >;
  return aggs[aggName]?.aggs.keys.terms;
}

const ORDERED_BUCKETS = [
  { value: "T0", count: 40 },
  { value: "T2", count: 90 },
  { value: "T3-4", count: 12 },
];

beforeEach(() => {
  capturedBodies.length = 0;
  vi.resetModules();
  // Pin the recency tilt off so the pub body is plain post_filter / aggs.
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
});

afterEach(() => {
  delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  delete process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET;
});

describe("Publications translational stage facet — SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET", () => {
  const STAGE_CLAUSE = { terms: { translationalStage: ["T1", "T3-4"] } };
  const YEAR_CLAUSE = { range: { year: { gte: 2020 } } };

  async function run(filters: PublicationsFilters) {
    const { searchPublications } = await import("@/lib/api/search");
    return searchPublications({ q: "cancer", page: 0, filters });
  }

  it("flag OFF: filter ignored, no agg, facets.translationalStages === []", async () => {
    const result = await run({ translationalStage: ["T1", "T3-4"] });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    expect(
      (capturedBodies[0].aggs as Record<string, unknown>).translationalStages,
    ).toBeUndefined();
    expect(result.facets.translationalStages).toEqual([]);
  });

  it("flag OFF: other axes do not pick up the stage clause", async () => {
    await run({ translationalStage: ["T1", "T3-4"], yearMin: 2020 });
    expect(postFilterClauses(capturedBodies[0])).toEqual([YEAR_CLAUSE]);
    expect(aggFilterClauses(capturedBodies[0], "publicationTypes")).toEqual([YEAR_CLAUSE]);
  });

  it("flag ON: terms clause on translationalStage, agg requested", async () => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    await run({ translationalStage: ["T1", "T3-4"] });
    expect(postFilterClauses(capturedBodies[0])).toContainEqual(STAGE_CLAUSE);
    expect(aggTerms(capturedBodies[0], "translationalStages")).toEqual({
      field: "translationalStage",
      size: 4,
    });
  });

  it("flag ON: buckets in fixed stage order, zero-count and unknown keys dropped", async () => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    const result = await run({ translationalStage: ["T1", "T3-4"] });
    expect(result.facets.translationalStages).toEqual(ORDERED_BUCKETS);
  });

  it("flag ON, no selection: agg still requested (rail seed), no clause", async () => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    const result = await run({});
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    expect(aggTerms(capturedBodies[0], "translationalStages")).toBeDefined();
    expect(result.facets.translationalStages).toEqual(ORDERED_BUCKETS);
  });

  it("flag ON: values outside the four stages are dropped from the clause", async () => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    await run({ translationalStage: ["NA", "T1", "bogus"] });
    expect(postFilterClauses(capturedBodies[0])).toEqual([
      { terms: { translationalStage: ["T1"] } },
    ]);
    capturedBodies.length = 0;
    await run({ translationalStage: ["NA", "bogus"] });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
  });

  it("excluding-self: stage agg omits its own clause but keeps year; publicationTypes agg keeps stage", async () => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    await run({ translationalStage: ["T1", "T3-4"], yearMin: 2020 });
    const body = capturedBodies[0];
    expect(postFilterClauses(body)).toContainEqual(STAGE_CLAUSE);
    const stage = aggFilterClauses(body, "translationalStages");
    expect(stage).toContainEqual(YEAR_CLAUSE);
    expect(stage).not.toContainEqual(STAGE_CLAUSE);
    const pt = aggFilterClauses(body, "publicationTypes");
    expect(pt).toContainEqual(STAGE_CLAUSE);
  });
});
