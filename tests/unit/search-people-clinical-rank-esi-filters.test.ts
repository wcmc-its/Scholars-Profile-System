/**
 * #2300 / #2306 — People-search `isClinical` / `professorialRank` /
 * `earlyStageInvestigator` filters + facets, mirroring the `personType` /
 * `activity` end-to-end pattern (clause construction → post_filter →
 * filtersExcept aggregation → facets response).
 *
 * Covers:
 *   - flag-OFF no-op: the params are accepted but produce no post_filter
 *     clause, no facet aggregation request, and a zeroed facets response
 *     (same posture as the SEARCH_PEOPLE_METHOD_FAMILY precedent).
 *   - `isClinical` / `earlyStageInvestigator` are single-boolean `term`
 *     clauses (the `activity` shape), NOT `terms`.
 *   - `professorialRank` is a multi-select `terms` clause (the `personType`
 *     shape), NOT `term`.
 *   - `SEARCH_PEOPLE_CLINICAL_RANK_FACETS` and `SEARCH_PEOPLE_ESI_FACET` are
 *     independent kill switches.
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
      // request actually asked for it — this is what lets the "flag off"
      // tests below observe a genuinely zeroed facets response rather than a
      // fixture that happens to always carry the field.
      const aggs = (req.body.aggs ?? {}) as Record<string, unknown>;
      const aggregations: Record<string, unknown> = {
        deptDivs: { keys: { buckets: [] } },
        personTypes: { keys: { buckets: [] } },
        activityHasGrants: { doc_count: 0 },
        activityRecentPub: { doc_count: 0 },
      };
      if (aggs.isClinicalTrue) aggregations.isClinicalTrue = { doc_count: 7 };
      if (aggs.isClinicalFalse) aggregations.isClinicalFalse = { doc_count: 3 };
      if (aggs.professorialRanks) {
        aggregations.professorialRanks = {
          keys: {
            buckets: [
              { key: "Professor", doc_count: 4 },
              { key: "Associate Professor", doc_count: 2 },
            ],
          },
        };
      }
      if (aggs.earlyStageInvestigatorTrue) {
        aggregations.earlyStageInvestigatorTrue = { doc_count: 9 };
      }
      if (aggs.earlyStageInvestigatorFalse) {
        aggregations.earlyStageInvestigatorFalse = { doc_count: 1 };
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

describe("#2300/#2306 — isClinical / professorialRank / earlyStageInvestigator", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  afterEach(() => {
    delete process.env.SEARCH_PEOPLE_CLINICAL_RANK_FACETS;
    delete process.env.SEARCH_PEOPLE_ESI_FACET;
    vi.clearAllMocks();
  });

  it("both flags OFF: params accepted but produce no post_filter clause, no requested agg, zeroed facets", async () => {
    const result = await searchPeople({
      q: "doe",
      filters: {
        isClinical: true,
        professorialRank: ["Professor"],
        earlyStageInvestigator: true,
      },
    });
    expect(postFilterClauses(capturedBodies[0])).toEqual([]);
    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.isClinicalTrue).toBeUndefined();
    expect(aggs.professorialRanks).toBeUndefined();
    expect(aggs.earlyStageInvestigatorTrue).toBeUndefined();
    expect(result.facets.isClinical).toEqual({ true: 0, false: 0 });
    expect(result.facets.professorialRank).toEqual([]);
    expect(result.facets.earlyStageInvestigator).toEqual({ true: 0, false: 0 });
  });

  it("SEARCH_PEOPLE_CLINICAL_RANK_FACETS=on: isClinical is a `term` clause, professorialRank is a `terms` clause; ESI stays a no-op", async () => {
    process.env.SEARCH_PEOPLE_CLINICAL_RANK_FACETS = "on";
    const result = await searchPeople({
      q: "doe",
      filters: {
        isClinical: true,
        professorialRank: ["Professor", "Associate Professor"],
        earlyStageInvestigator: true, // ESI flag still off — must stay a no-op
      },
    });
    const clauses = postFilterClauses(capturedBodies[0]);
    expect(clauses).toContainEqual({ term: { isClinical: true } });
    expect(clauses).toContainEqual({
      terms: { professorialRank: ["Professor", "Associate Professor"] },
    });
    // The ESI clause must NOT have fired.
    expect(clauses).not.toContainEqual({ term: { esiEligible: true } });

    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.isClinicalTrue).toBeDefined();
    expect(aggs.isClinicalFalse).toBeDefined();
    expect(aggs.professorialRanks).toBeDefined();
    expect(aggs.earlyStageInvestigatorTrue).toBeUndefined();

    expect(result.facets.isClinical).toEqual({ true: 7, false: 3 });
    expect(result.facets.professorialRank).toEqual([
      { value: "Professor", count: 4 },
      { value: "Associate Professor", count: 2 },
    ]);
    // Untouched by the other flag.
    expect(result.facets.earlyStageInvestigator).toEqual({ true: 0, false: 0 });
  });

  it("SEARCH_PEOPLE_ESI_FACET=on: earlyStageInvestigator is a `term { esiEligible }` clause, independent of the clinical/rank flag", async () => {
    process.env.SEARCH_PEOPLE_ESI_FACET = "on";
    const result = await searchPeople({
      q: "doe",
      filters: {
        isClinical: true, // clinical/rank flag still off — must stay a no-op
        earlyStageInvestigator: true,
      },
    });
    const clauses = postFilterClauses(capturedBodies[0]);
    expect(clauses).toContainEqual({ term: { esiEligible: true } });
    expect(clauses).not.toContainEqual({ term: { isClinical: true } });

    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.earlyStageInvestigatorTrue).toBeDefined();
    expect(aggs.earlyStageInvestigatorFalse).toBeDefined();
    expect(aggs.isClinicalTrue).toBeUndefined();

    expect(result.facets.earlyStageInvestigator).toEqual({ true: 9, false: 1 });
    expect(result.facets.isClinical).toEqual({ true: 0, false: 0 });
  });

  it("professorialRank clause is `terms` (multi-select OR), not `term`", async () => {
    process.env.SEARCH_PEOPLE_CLINICAL_RANK_FACETS = "on";
    await searchPeople({
      q: "doe",
      filters: { professorialRank: ["Professor"] },
    });
    const clauses = postFilterClauses(capturedBodies[0]);
    const rankClause = clauses.find((c) => "terms" in c);
    expect(rankClause).toEqual({ terms: { professorialRank: ["Professor"] } });
    expect(clauses.some((c) => "term" in c && "professorialRank" in (c.term as object))).toBe(
      false,
    );
  });
});
