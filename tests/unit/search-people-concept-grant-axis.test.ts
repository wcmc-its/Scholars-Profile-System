/**
 * Issue #921 — concept-scope grant axis (body-shape contract). Under
 * `?match=concept`, when SEARCH_PEOPLE_CONCEPT_GRANT_AXIS=on the People query
 * must union scholars FUNDED on the resolved concept (cwids from the Funding
 * index) with the publication-tagged scholars:
 *
 *   - the always-on filter GATE becomes a should over
 *     `terms{publicationMeshUi}` OR `terms{cwid}` (set widens together),
 *   - the scoring `must` admits the grant cwids with a LOW constant boost so a
 *     grant-only scholar sorts below publication BM25 evidence (acceptance #3),
 *   - the count-only badge body carries the same widened gate (badge == list).
 *
 * Flag-off → no Funding round-trip and the query body is byte-identical to today.
 * Captures `body.query`, asserts shape not behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

const captured: Array<{ index?: string; body: Record<string, unknown> }> = [];
// Controllable grant-matched cwid buckets the Funding aggregation returns.
const funding = vi.hoisted(() => ({ cwids: ["abc1001", "abc1002"] as string[] }));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_INDEX: "scholars-funding",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10", "publicationMesh^0.5"],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^1", "publicationMesh^4"],
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  MESH_ADMIT_WEIGHT: { exact: 3, "anchored-entry": 1.5, entry: 0.7 },
  MESH_ATTRIBUTION_WEIGHT: { exact: 1.5, "anchored-entry": 1.3, entry: 1.15 },
  MESH_ESCALATION_THRESHOLD: 50,
  MESH_MIN_MATCHED_FORM_LEN: 4,
  searchClient: () => ({
    async search(req: { index?: string; body: Record<string, unknown> }) {
      captured.push({ index: req.index, body: req.body });
      if (req.index === "scholars-funding") {
        return {
          body: {
            hits: { total: { value: 0 } },
            aggregations: {
              cwids: { buckets: funding.cwids.map((key) => ({ key })) },
            },
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
                  cwid: "z",
                  slug: "z",
                  preferredName: "Z",
                  personType: "full_time_faculty",
                  publicationCount: 10,
                  hasActiveGrants: true,
                },
                highlight: undefined,
              },
            ],
          },
          aggregations: {
            deptDivs: { keys: { buckets: [] } },
            personTypes: { keys: { buckets: [] } },
            activityHasGrants: { doc_count: 0 },
            activityRecentPub: { doc_count: 0 },
            attributionMatch: { doc_count: 1 },
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

import { searchPeople } from "@/lib/api/search";

const DESCENDANTS = ["D012345", "D067890"];

const baseOpts = {
  q: "hiv",
  relevanceMode: "v3" as const,
  shape: "topic" as const,
  scope: "concept" as const,
  meshDescendantUis: DESCENDANTS,
  meshMatchTier: "exact" as const,
};

type Bool = { must: Record<string, unknown>[]; filter: Record<string, unknown>[] };

/** Drill the prominence outer → topic inner function_score → baseQuery bool. */
function baseBool(body: Record<string, unknown>): Bool {
  const outer = (body.query as { function_score: { query: Record<string, unknown> } })
    .function_score;
  const inner = (outer.query as { function_score: { query: { bool: Bool } } })
    .function_score;
  return inner.query.bool;
}

/** The `should` array inside the outer `must` bool (cwid ⊕ queryBranch ⊕ grant). */
function mustShould(body: Record<string, unknown>): Record<string, unknown>[] {
  return (baseBool(body).must[0] as { bool: { should: Record<string, unknown>[] } }).bool
    .should;
}

/** The concept-scope set gate — the last always-on filter clause. */
function gateClause(filter: Record<string, unknown>[]): Record<string, unknown> {
  return filter[filter.length - 1];
}

function fullBody(): Record<string, unknown> {
  const b = captured.find((c) => "from" in c.body);
  if (!b) throw new Error("no full search body captured");
  return b.body;
}

function fundingFired(): boolean {
  return captured.some((c) => c.index === "scholars-funding");
}

describe("people-index concept-scope grant axis — #921", () => {
  const original = process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS;

  beforeEach(() => {
    captured.length = 0;
    funding.cwids = ["abc1001", "abc1002"];
    groupByMock.mockResolvedValue([]);
    delete process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS;
  });
  afterEach(() => {
    vi.clearAllMocks();
    if (original === undefined) delete process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS;
    else process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = original;
  });

  describe("flag OFF (dark default) — byte-identical to today", () => {
    it("does not query the Funding index and keeps the plain publicationMeshUi gate", async () => {
      await searchPeople({ ...baseOpts });
      expect(fundingFired()).toBe(false);
      expect(gateClause(baseBool(fullBody()).filter)).toEqual({
        terms: { publicationMeshUi: DESCENDANTS },
      });
      // The scoring `must` keeps its two-clause should (exact-cwid ⊕ queryBranch).
      expect(mustShould(fullBody())).toHaveLength(2);
    });
  });

  describe("flag ON", () => {
    it("unions grant-matched cwids into the gate and admits them to the scoring must", async () => {
      process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "on";
      await searchPeople({ ...baseOpts });

      expect(fundingFired()).toBe(true);
      // Set gate widens: publicationMeshUi-tagged OR funded-on-concept cwid.
      expect(gateClause(baseBool(fullBody()).filter)).toEqual({
        bool: {
          should: [
            { terms: { publicationMeshUi: DESCENDANTS } },
            { terms: { cwid: ["abc1001", "abc1002"] } },
          ],
          minimum_should_match: 1,
        },
      });
      // Scoring must gains the grant admission with a low constant boost so a
      // grant-only scholar ranks below publication BM25 evidence (acceptance #3).
      const should = mustShould(fullBody());
      expect(should).toHaveLength(3);
      expect(should[2]).toEqual({
        terms: { cwid: ["abc1001", "abc1002"], boost: 0.1 },
      });
    });

    it("queries the Funding index on the resolved descendant set (default gate field)", async () => {
      process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "on";
      await searchPeople({ ...baseOpts });
      const fundingCall = captured.find((c) => c.index === "scholars-funding");
      expect(fundingCall).toBeDefined();
      const body = fundingCall!.body as {
        size: number;
        query: { bool: { filter: Record<string, unknown>[] } };
        aggs: { cwids: { terms: { field: string; size: number } } };
      };
      expect(body.size).toBe(0);
      expect(body.query.bool.filter).toEqual([
        { terms: { meshDescriptorUi: DESCENDANTS } },
      ]);
      expect(body.aggs.cwids.terms.field).toBe("wcmInvestigatorCwids");
    });

    it("degrades to the plain gate when no investigators are funded on the concept", async () => {
      process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "on";
      funding.cwids = [];
      await searchPeople({ ...baseOpts });
      // The Funding query still fired, but with an empty union the bodies revert
      // to the publication-only gate / two-clause must (no spurious widening).
      expect(fundingFired()).toBe(true);
      expect(gateClause(baseBool(fullBody()).filter)).toEqual({
        terms: { publicationMeshUi: DESCENDANTS },
      });
      expect(mustShould(fullBody())).toHaveLength(2);
    });

    it("count-only badge carries the same widened gate (badge == list)", async () => {
      process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "on";
      await searchPeople({ ...baseOpts, countOnly: true });
      const countBody = captured.find(
        (c) => c.index === "scholars-people" && c.body.size === 0,
      );
      expect(countBody).toBeDefined();
      const filter = (
        countBody!.body as { query: { bool: { filter: Record<string, unknown>[] } } }
      ).query.bool.filter;
      expect(gateClause(filter)).toEqual({
        bool: {
          should: [
            { terms: { publicationMeshUi: DESCENDANTS } },
            { terms: { cwid: ["abc1001", "abc1002"] } },
          ],
          minimum_should_match: 1,
        },
      });
    });

    it("does NOT engage the grant axis outside concept scope", async () => {
      process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "on";
      await searchPeople({ ...baseOpts, scope: undefined });
      expect(fundingFired()).toBe(false);
    });
  });
});
