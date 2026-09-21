/**
 * Publications-tab + Funding-tab `institution` filter + facet, cloned from
 * `search-people-institution-filter.test.ts`. Pubs key on the
 * `wcmAuthorInstitutions` keyword array (union of the displayable WCM
 * authors' `Scholar.primaryOrgCode`); funding on the lead PI's `institution`.
 *
 * Per tab, covers:
 *   - flag-OFF no-op: the param is accepted but produces no post_filter
 *     clause, no `institutions` agg, and `facets.institutions === []`.
 *   - flag-ON: a multi-select `terms` clause; the agg is requested (size 50)
 *     and mapped to buckets; the agg runs even with no selection (rail seed).
 *   - excluding-self (mutation-tested): the `institutions` agg's filter carries
 *     the OTHER axis clause but NOT its own, while the other axis's agg DOES
 *     carry the institution clause — forgetting `filtersExcept("institution")`
 *     collapses the group to one bucket and fails this assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicationsFilters } from "@/lib/api/search";
import type { FundingFilters } from "@/lib/api/search-funding";

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

const INSTITUTION_BUCKETS = {
  keys: {
    buckets: [
      { key: "WCMC", doc_count: 40 },
      { key: "HSS", doc_count: 6 },
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
      // Mirror real OpenSearch: echo the institutions agg only when asked for.
      const aggs = (req.body.aggs ?? {}) as Record<string, unknown>;
      const institutions = aggs.institutions ? { institutions: INSTITUTION_BUCKETS } : {};
      if (req.index === "scholars-funding") {
        return {
          body: {
            hits: { total: { value: 0 }, hits: [] },
            aggregations: {
              funders: { keys: { buckets: [] } },
              directFunders: { keys: { buckets: [] } },
              programTypes: { keys: { buckets: [] } },
              mechanisms: { keys: { buckets: [] } },
              departments: { keys: { buckets: [] } },
              roleBuckets: { keys: { buckets: [] } },
              statusActive: { doc_count: 0 },
              statusEndingSoon: { doc_count: 0 },
              statusRecentlyEnded: { doc_count: 0 },
              ...institutions,
            },
          },
        };
      }
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
            ...institutions,
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

const EXPECTED_BUCKETS = [
  { value: "WCMC", count: 40 },
  { value: "HSS", count: 6 },
];

beforeEach(() => {
  capturedBodies.length = 0;
  vi.resetModules();
  // Pin the recency tilt off so the pub body is plain post_filter / aggs.
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
});

afterEach(() => {
  delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  delete process.env.SEARCH_PUB_INSTITUTION_FACET;
  delete process.env.SEARCH_FUNDING_INSTITUTION_FACET;
});

describe("Publications institution facet — SEARCH_PUB_INSTITUTION_FACET", () => {
  const PUB_CLAUSE = { terms: { wcmAuthorInstitutions: ["HSS", "MSKCC"] } };
  const YEAR_CLAUSE = { range: { year: { gte: 2020 } } };

  async function run(filters: PublicationsFilters) {
    const { searchPublications } = await import("@/lib/api/search");
    return searchPublications({ q: "cancer", page: 0, filters });
  }

  it("flag OFF: param accepted, no clause, no agg, facets.institutions === []", async () => {
    const result = await run({ institution: ["HSS", "MSKCC"] });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    expect((capturedBodies[0].aggs as Record<string, unknown>).institutions).toBeUndefined();
    expect(result.facets.institutions).toEqual([]);
  });

  it("flag ON: terms clause on wcmAuthorInstitutions, size-50 agg, facets mapped", async () => {
    process.env.SEARCH_PUB_INSTITUTION_FACET = "on";
    const result = await run({ institution: ["HSS", "MSKCC"] });
    expect(postFilterClauses(capturedBodies[0])).toContainEqual(PUB_CLAUSE);
    expect(aggTerms(capturedBodies[0], "institutions")).toEqual({
      field: "wcmAuthorInstitutions",
      size: 50,
    });
    expect(result.facets.institutions).toEqual(EXPECTED_BUCKETS);
  });

  it("flag ON, no selection: agg still requested (rail seed), no clause", async () => {
    process.env.SEARCH_PUB_INSTITUTION_FACET = "on";
    const result = await run({});
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    expect(aggTerms(capturedBodies[0], "institutions")).toBeDefined();
    expect(result.facets.institutions).toEqual(EXPECTED_BUCKETS);
  });

  it("excluding-self: institutions agg omits its own clause but keeps year; publicationTypes agg keeps institution", async () => {
    process.env.SEARCH_PUB_INSTITUTION_FACET = "on";
    await run({ institution: ["HSS", "MSKCC"], yearMin: 2020 });
    const body = capturedBodies[0];
    expect(postFilterClauses(body)).toContainEqual(PUB_CLAUSE);
    const inst = aggFilterClauses(body, "institutions");
    expect(inst).toContainEqual(YEAR_CLAUSE);
    expect(inst).not.toContainEqual(PUB_CLAUSE);
    const pt = aggFilterClauses(body, "publicationTypes");
    expect(pt).toContainEqual(PUB_CLAUSE);
  });
});

describe("Funding institution facet — SEARCH_FUNDING_INSTITUTION_FACET", () => {
  const FUNDING_CLAUSE = { terms: { institution: ["HSS", "MSKCC"] } };
  const FUNDER_CLAUSE = { terms: { primeSponsor: ["NCI"] } };

  async function run(filters: FundingFilters) {
    const { searchFunding } = await import("@/lib/api/search-funding");
    return searchFunding({ q: "", filters });
  }

  it("flag OFF: param accepted, no clause, no agg, facets.institutions === []", async () => {
    const result = await run({ institution: ["HSS", "MSKCC"] });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    expect((capturedBodies[0].aggs as Record<string, unknown>).institutions).toBeUndefined();
    expect(result.facets.institutions).toEqual([]);
  });

  it("flag ON: terms clause on institution, size-50 agg, facets mapped", async () => {
    process.env.SEARCH_FUNDING_INSTITUTION_FACET = "on";
    const result = await run({ institution: ["HSS", "MSKCC"] });
    expect(postFilterClauses(capturedBodies[0])).toContainEqual(FUNDING_CLAUSE);
    expect(aggTerms(capturedBodies[0], "institutions")).toEqual({ field: "institution", size: 50 });
    expect(result.facets.institutions).toEqual(EXPECTED_BUCKETS);
  });

  it("flag ON, no selection: agg still requested (rail seed), no clause", async () => {
    process.env.SEARCH_FUNDING_INSTITUTION_FACET = "on";
    const result = await run({});
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    expect(aggTerms(capturedBodies[0], "institutions")).toBeDefined();
    expect(result.facets.institutions).toEqual(EXPECTED_BUCKETS);
  });

  it("excluding-self: institutions agg omits its own clause but keeps funder; funders agg keeps institution", async () => {
    process.env.SEARCH_FUNDING_INSTITUTION_FACET = "on";
    await run({ institution: ["HSS", "MSKCC"], funder: ["NCI"] });
    const body = capturedBodies[0];
    expect(postFilterClauses(body)).toContainEqual(FUNDING_CLAUSE);
    const inst = aggFilterClauses(body, "institutions");
    expect(inst).toContainEqual(FUNDER_CLAUSE);
    expect(inst).not.toContainEqual(FUNDING_CLAUSE);
    const funders = aggFilterClauses(body, "funders");
    expect(funders).toContainEqual(FUNDING_CLAUSE);
  });
});
