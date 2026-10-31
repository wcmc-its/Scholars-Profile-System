/**
 * People-search `researchType` filter + facet ("lab" / "clinical", from
 * Scholar.labPubs5y / clinicalPubs5y via lib/research-type.ts). Same
 * end-to-end shape as the institution facet suite: flag-OFF no-op, flag-ON
 * multi-select `terms` clause + agg + mapped buckets, excluding-self counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

// The page-level funding agg (#1412) runs on every query-bearing searchPeople call
// since #1440 retired its SEARCH_EVIDENCE_ROWS gate; it has its own suite
// (investigator-grant-match-counts.test.ts). Stub it to "no matching grants" so the
// `@/lib/search` mock need not carry the funding-index surface.
vi.mock("@/lib/api/search-funding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/search-funding")>();
  return { ...actual, investigatorGrantMatchCounts: async () => new Map() };
});

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) } },
}));

const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      // Mirror real OpenSearch: only echo back an aggregation bucket when the
      // request actually asked for it — this is what lets the "flag off" test
      // observe a genuinely empty facets response rather than a fixture that
      // happens to always carry the field.
      const aggs = (req.body.aggs ?? {}) as Record<string, unknown>;
      const aggregations: Record<string, unknown> = {
        deptDivs: { keys: { buckets: [] } },
        personTypes: { keys: { buckets: [] } },
        activityHasGrants: { doc_count: 0 },
        activityRecentPub: { doc_count: 0 },
      };
      if (aggs.researchTypes) {
        aggregations.researchTypes = {
          keys: {
            buckets: [
              { key: "clinical", doc_count: 40 },
              { key: "lab", doc_count: 6 },
            ],
          },
        };
      }
      return {
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _source: {
                  cwid: FIXTURE_CWID,
                  slug: "jane-doe",
                  preferredName: "Jane Doe",
                  primaryTitle: "Professor",
                  primaryDepartment: "Medicine",
                  deptName: "Medicine",
                  divisionName: null,
                  primaryOrgCode: "HSS",
                  personType: "full_time_faculty",
                  publicationCount: 40,
                  grantCount: 2,
                  hasActiveGrants: true,
                },
                highlight: undefined,
              },
            ],
          },
          aggregations,
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

import { searchPeople } from "@/lib/api/search";

/** The user-axis `post_filter` clauses actually sent, `[]` when absent. */
function postFilterClauses(body: Record<string, unknown>): Record<string, unknown>[] {
  const pf = body.post_filter as { bool: { filter: Record<string, unknown>[] } } | undefined;
  return pf?.bool.filter ?? [];
}

/** The `filter` clauses inside a named facet agg's `bool.filter`. */
function aggFilterClauses(
  body: Record<string, unknown>,
  aggName: string,
): Record<string, unknown>[] {
  const aggs = body.aggs as Record<
    string,
    { filter: { bool: { filter: Record<string, unknown>[] } } }
  >;
  return aggs[aggName].filter.bool.filter;
}

const RESEARCH_TYPE_CLAUSE = { terms: { researchType: ["lab", "clinical"] } };
const PERSON_TYPE_CLAUSE = { terms: { personType: ["full_time_faculty"] } };

describe("research type facet — searchPeople filter + agg + facets", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  afterEach(() => {
    delete process.env.SEARCH_PEOPLE_RESEARCH_TYPE_FACET;
    vi.clearAllMocks();
  });

  it("flag OFF: param accepted but no post_filter clause, no `researchTypes` agg, facets.researchTypes === []", async () => {
    const result = await searchPeople({
      q: "doe",
      filters: { researchType: ["lab", "clinical"] },
    });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.researchTypes).toBeUndefined();
    expect(result.facets.researchTypes).toEqual([]);
  });

  it("flag ON: researchType is a multi-select `terms` clause in post_filter, agg present, facets mapped", async () => {
    process.env.SEARCH_PEOPLE_RESEARCH_TYPE_FACET = "on";
    const result = await searchPeople({
      q: "doe",
      filters: { researchType: ["lab", "clinical"] },
    });
    const clauses = postFilterClauses(capturedBodies[0]);
    expect(clauses).toContainEqual(RESEARCH_TYPE_CLAUSE);
    // Multi-select OR (`terms`), never a single-value `term`.
    expect(
      clauses.some((c) => "term" in c && "researchType" in (c.term as object)),
    ).toBe(false);

    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.researchTypes).toBeDefined();
    expect(result.facets.researchTypes).toEqual([
      { value: "clinical", count: 40 },
      { value: "lab", count: 6 },
    ]);
  });

  it("flag ON, no researchType filter: agg still requested (so the group can render), no clause", async () => {
    process.env.SEARCH_PEOPLE_RESEARCH_TYPE_FACET = "on";
    const result = await searchPeople({ q: "doe", filters: {} });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.researchTypes).toBeDefined();
    expect(result.facets.researchTypes).toHaveLength(2);
  });

  it("excluding-self: the `researchTypes` agg omits its own clause but keeps personType; other aggs keep the researchType clause", async () => {
    process.env.SEARCH_PEOPLE_RESEARCH_TYPE_FACET = "on";
    await searchPeople({
      q: "doe",
      filters: { researchType: ["lab", "clinical"], personType: ["full_time_faculty"] },
    });
    const body = capturedBodies[0];
    // Both user-axis clauses ride post_filter.
    const pf = postFilterClauses(body);
    expect(pf).toContainEqual(RESEARCH_TYPE_CLAUSE);
    expect(pf).toContainEqual(PERSON_TYPE_CLAUSE);

    // The researchType agg sees every OTHER axis, not itself.
    const instAgg = aggFilterClauses(body, "researchTypes");
    expect(instAgg).toContainEqual(PERSON_TYPE_CLAUSE);
    expect(instAgg).not.toContainEqual(RESEARCH_TYPE_CLAUSE);

    // The personType agg sees the researchType clause, not itself.
    const ptAgg = aggFilterClauses(body, "personTypes");
    expect(ptAgg).toContainEqual(RESEARCH_TYPE_CLAUSE);
    expect(ptAgg).not.toContainEqual(PERSON_TYPE_CLAUSE);

    // A third axis (deptDivs) sees both.
    const ddAgg = aggFilterClauses(body, "deptDivs");
    expect(ddAgg).toContainEqual(RESEARCH_TYPE_CLAUSE);
    expect(ddAgg).toContainEqual(PERSON_TYPE_CLAUSE);
  });
});
