/**
 * People-search `institution` filter + facet (direct copy of
 * `Scholar.primaryOrgCode` onto the people doc as the `primaryOrgCode`
 * keyword), mirroring the #2300 `professorialRank` end-to-end pattern (clause
 * construction → post_filter → filtersExcept aggregation → facets response).
 *
 * Covers:
 *   - flag-OFF no-op: the param is accepted but produces no post_filter
 *     clause, no `institutions` facet aggregation request, and
 *     `facets.institutions` equals `[]` (never omitted).
 *   - flag-ON: a multi-select `terms` clause (the `personType` shape), NOT
 *     `term`; the `institutions` agg is requested and mapped to buckets.
 *   - excluding-self: the `institutions` agg's filter carries every OTHER
 *     user-axis clause (e.g. personType) but NOT the institution clause
 *     itself, so ticking one institution doesn't collapse the group to one
 *     bucket. Other axes' aggs DO carry the institution clause.
 *   - facet response mapping reads whatever aggregations OpenSearch actually
 *     returned (mocked `search()` below echoes back only the aggs it was
 *     asked for, mirroring real OpenSearch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

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
      if (aggs.institutions) {
        aggregations.institutions = {
          keys: {
            buckets: [
              { key: "WCMC", doc_count: 40 },
              { key: "HSS", doc_count: 6 },
              { key: "MSKCC", doc_count: 3 },
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

const INSTITUTION_CLAUSE = { terms: { primaryOrgCode: ["HSS", "MSKCC"] } };
const PERSON_TYPE_CLAUSE = { terms: { personType: ["full_time_faculty"] } };

describe("institution facet — searchPeople filter + agg + facets", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  afterEach(() => {
    delete process.env.SEARCH_PEOPLE_INSTITUTION_FACET;
    vi.clearAllMocks();
  });

  it("flag OFF: param accepted but no post_filter clause, no `institutions` agg, facets.institutions === []", async () => {
    const result = await searchPeople({
      q: "doe",
      filters: { institution: ["HSS", "MSKCC"] },
    });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.institutions).toBeUndefined();
    expect(result.facets.institutions).toEqual([]);
  });

  it("flag ON: institution is a multi-select `terms` clause in post_filter, agg present, facets mapped", async () => {
    process.env.SEARCH_PEOPLE_INSTITUTION_FACET = "on";
    const result = await searchPeople({
      q: "doe",
      filters: { institution: ["HSS", "MSKCC"] },
    });
    const clauses = postFilterClauses(capturedBodies[0]);
    expect(clauses).toContainEqual(INSTITUTION_CLAUSE);
    // Multi-select OR (`terms`), never a single-value `term`.
    expect(
      clauses.some((c) => "term" in c && "primaryOrgCode" in (c.term as object)),
    ).toBe(false);

    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.institutions).toBeDefined();
    expect(result.facets.institutions).toEqual([
      { value: "WCMC", count: 40 },
      { value: "HSS", count: 6 },
      { value: "MSKCC", count: 3 },
    ]);
  });

  it("flag ON, no institution filter: agg still requested (so the group can render), no clause", async () => {
    process.env.SEARCH_PEOPLE_INSTITUTION_FACET = "on";
    const result = await searchPeople({ q: "doe", filters: {} });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.institutions).toBeDefined();
    expect(result.facets.institutions).toHaveLength(3);
  });

  it("excluding-self: the `institutions` agg omits its own clause but keeps personType; other aggs keep the institution clause", async () => {
    process.env.SEARCH_PEOPLE_INSTITUTION_FACET = "on";
    await searchPeople({
      q: "doe",
      filters: { institution: ["HSS", "MSKCC"], personType: ["full_time_faculty"] },
    });
    const body = capturedBodies[0];
    // Both user-axis clauses ride post_filter.
    const pf = postFilterClauses(body);
    expect(pf).toContainEqual(INSTITUTION_CLAUSE);
    expect(pf).toContainEqual(PERSON_TYPE_CLAUSE);

    // The institution agg sees every OTHER axis, not itself.
    const instAgg = aggFilterClauses(body, "institutions");
    expect(instAgg).toContainEqual(PERSON_TYPE_CLAUSE);
    expect(instAgg).not.toContainEqual(INSTITUTION_CLAUSE);

    // The personType agg sees the institution clause, not itself.
    const ptAgg = aggFilterClauses(body, "personTypes");
    expect(ptAgg).toContainEqual(INSTITUTION_CLAUSE);
    expect(ptAgg).not.toContainEqual(PERSON_TYPE_CLAUSE);

    // A third axis (deptDivs) sees both.
    const ddAgg = aggFilterClauses(body, "deptDivs");
    expect(ddAgg).toContainEqual(INSTITUTION_CLAUSE);
    expect(ddAgg).toContainEqual(PERSON_TYPE_CLAUSE);
  });
});
