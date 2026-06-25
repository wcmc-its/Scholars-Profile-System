/**
 * Issue #726 — MeSH concept admission + graduated attribution (body-shape
 * contract). Locks the Piece-2 behaviour against the body sent to OpenSearch:
 *
 *   - Attribution graduates the former flat ×1.5 by match-type trust
 *     (exact 1.5 / anchored-entry 1.3 / entry 1.15), always-on when a descriptor
 *     resolved, independent of escalation. Default (un-threaded) tier = exact,
 *     so callers that don't yet pass a tier keep the pre-#726 ×1.5.
 *   - Escalate-on-sparse: when the topic query resolved to a TRUSTWORTHY
 *     descriptor (unambiguous, matched form ≥ 4 chars) AND the lexical result is
 *     sparse (cheap size:0 pre-count < MESH_ESCALATION_THRESHOLD), the lexical
 *     `must` is OR-ed with a `terms { publicationMeshUi }` admission so
 *     concept-tagged scholars surface on an otherwise-thin page.
 *   - Count-gated: a non-sparse lexical result (pre-count ≥ threshold) is left
 *     alone, so common-query counts stay == lexical (badge == list).
 *   - Floor = ambiguity OR ultra-short matched form — NOT anchor status. An
 *     unanchored entry-term still escalates (the tylenol 0→N recall win).
 *
 * Captures `body.query`, asserts shape not behavior — the runtime order is
 * validated separately against a reindexed local OpenSearch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

const capturedBodies: Array<Record<string, unknown>> = [];
// Controllable lexical pre-count total — set per test to drive the
// escalate/count-gate decision (the real OpenSearch returns this from the
// size:0 pre-count query).
const lexical = vi.hoisted(() => ({ total: 1 }));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10", "publicationAbstracts^0.3"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: [
    "preferredName^10",
    "fullName^10",
    "areasOfInterest^6",
    "primaryTitle^4",
    "primaryDepartment^3",
    "overview^2",
    "publicationTitles^1",
    "publicationMesh^0.5",
  ],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: [
    "preferredName^1",
    "fullName^1",
    "areasOfInterest^3",
    "primaryTitle^3",
    "primaryDepartment^1",
    "overview^2",
    "publicationTitles^6",
    "publicationMesh^4",
  ],
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  MESH_ADMIT_WEIGHT: { exact: 0.1, "anchored-entry": 0.05, entry: 0.03 },
  MESH_ATTRIBUTION_WEIGHT: { exact: 1.5, "anchored-entry": 1.3, entry: 1.15 },
  MESH_ESCALATION_THRESHOLD: 50,
  MESH_MIN_MATCHED_FORM_LEN: 4,
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      // The lexical pre-count is the only bare size:0 query (no aggs); the
      // facet/funded aggs and the count-only badge are not exercised here.
      const isPreCount = req.body.size === 0 && !("aggs" in req.body);
      return {
        body: {
          hits: {
            total: { value: isPreCount ? lexical.total : 1 },
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

type FnScore = {
  query: {
    bool: { must: Record<string, unknown>[]; filter: Record<string, unknown>[] };
  };
  functions: Array<{ filter: Record<string, unknown>; weight: number }>;
  score_mode: string;
  boost_mode: string;
};

/** Drill the OUTER prominence wrapper to the INNER topic function_score. */
function innerFnScore(body: Record<string, unknown>): FnScore {
  const outer = (body.query as { function_score: { query: Record<string, unknown> } })
    .function_score;
  return (outer.query as { function_score: FnScore }).function_score;
}

/**
 * The topic body's `must` array. Path: inner function_score → query.bool.must
 * (the cwid⊕queryBranch outer bool) → should[1] (queryBranch = topic body) →
 * bool.must.
 */
function topicMust(body: Record<string, unknown>): Record<string, unknown>[] {
  const outerMust = innerFnScore(body).query.bool.must;
  const queryBranch = (outerMust[0].bool as { should: Record<string, unknown>[] })
    .should[1];
  return (queryBranch as { bool: { must: Record<string, unknown>[] } }).bool.must;
}

/** The graduated attribution weight applied to the descendant-UI terms filter. */
function attributionWeight(body: Record<string, unknown>): number | undefined {
  return innerFnScore(body).functions.find(
    (f) =>
      JSON.stringify(f.filter) ===
      JSON.stringify({ terms: { publicationMeshUi: DESCENDANTS } }),
  )?.weight;
}

/** The full (paginated) people search body, distinct from the size:0 pre-count. */
function fullBody(): Record<string, unknown> {
  const body = capturedBodies.find((b) => "from" in b);
  if (!body) throw new Error("no full search body captured");
  return body;
}

/** Did the lexical pre-count fire (the eligible/two-pass path)? */
function preCountIssued(): boolean {
  return capturedBodies.some((b) => b.size === 0 && !("aggs" in b));
}

/** The concept-admission terms clause inside an escalated topic must, if any. */
function admissionInMust(
  must: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  // Escalated shape: must = [{ bool: { should: [lexical, terms], msm: 1 } }].
  const inner = (must[0] as { bool?: { should?: Record<string, unknown>[] } }).bool
    ?.should;
  return inner?.find((c) => "terms" in c);
}

function admissionTerms(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return admissionInMust(topicMust(body));
}

/** Topic must from a size:0 count body (no function_score wrapper). */
function topicMustFromCount(body: Record<string, unknown>): Record<string, unknown>[] {
  const outerMust = (body.query as { bool: { must: Record<string, unknown>[] } }).bool
    .must;
  const queryBranch = (outerMust[0].bool as { should: Record<string, unknown>[] })
    .should[1];
  return (queryBranch as { bool: { must: Record<string, unknown>[] } }).bool.must;
}

/** The last bare size:0 body — the count-only badge query (after the pre-count). */
function countOnlyBody(): Record<string, unknown> {
  const sizeZero = capturedBodies.filter((b) => b.size === 0 && !("aggs" in b));
  if (!sizeZero.length) throw new Error("no size:0 count body captured");
  return sizeZero[sizeZero.length - 1];
}

const DESCENDANTS = ["D012345", "D067890"];

const baseTopicOpts = {
  q: "ras signaling pancreatic cancer",
  relevanceMode: "v3" as const,
  shape: "topic" as const,
  meshDescendantUis: DESCENDANTS,
};

describe("people-index MeSH concept admission — SPEC #726", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    lexical.total = 1;
    groupByMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("attribution graduation (always-on when a descriptor resolved)", () => {
    it("exact tier keeps the historical ×1.5", async () => {
      await searchPeople({ ...baseTopicOpts, meshMatchTier: "exact" });
      expect(attributionWeight(fullBody())).toBe(1.5);
    });

    it("anchored-entry tier graduates to ×1.3", async () => {
      await searchPeople({ ...baseTopicOpts, meshMatchTier: "anchored-entry" });
      expect(attributionWeight(fullBody())).toBe(1.3);
    });

    it("entry tier graduates to ×1.15", async () => {
      await searchPeople({ ...baseTopicOpts, meshMatchTier: "entry" });
      expect(attributionWeight(fullBody())).toBe(1.15);
    });

    it("an un-threaded caller defaults to exact (×1.5 back-compat)", async () => {
      await searchPeople({ ...baseTopicOpts });
      expect(attributionWeight(fullBody())).toBe(1.5);
    });
  });

  describe("escalate-on-sparse admission", () => {
    it("admits the descendant-UI terms clause when the lexical result is sparse", async () => {
      lexical.total = 3; // < 50
      await searchPeople({
        ...baseTopicOpts,
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 8,
      });

      expect(preCountIssued()).toBe(true);
      // Topic must is wrapped: a single bool whose should OR-s the lexical clause
      // with the concept admission (minimum_should_match: 1).
      const must = topicMust(fullBody());
      expect(must).toHaveLength(1);
      const wrapped = (must[0] as { bool: { minimum_should_match: number } }).bool;
      expect(wrapped.minimum_should_match).toBe(1);
      expect(admissionTerms(fullBody())).toEqual({
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.1 }, // exact admit weight
      });
    });

    it("orders the admission by match-type trust (entry → 0.7)", async () => {
      lexical.total = 2;
      await searchPeople({
        ...baseTopicOpts,
        meshMatchTier: "entry",
        meshAmbiguous: false,
        meshMatchedFormLength: 7,
      });
      expect(admissionTerms(fullBody())).toEqual({
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.03 },
      });
    });
  });

  describe("count-gating (keeps common-query count == lexical)", () => {
    it("does NOT admit when the lexical result is not sparse", async () => {
      lexical.total = 75; // >= 50
      await searchPeople({
        ...baseTopicOpts,
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 8,
      });

      expect(preCountIssued()).toBe(true); // still pays the cheap pre-count…
      // …but the lexical clause is the bare must[0], no terms admission OR-ed in.
      expect(topicMust(fullBody())[0]).toHaveProperty("multi_match");
      expect(admissionTerms(fullBody())).toBeUndefined();
    });
  });

  describe("confidence floor (ambiguity OR ultra-short form — NOT anchor status)", () => {
    it("does NOT escalate an ambiguous resolution, even when sparse", async () => {
      lexical.total = 1;
      await searchPeople({
        ...baseTopicOpts,
        meshMatchTier: "exact",
        meshAmbiguous: true,
        meshMatchedFormLength: 8,
      });
      expect(preCountIssued()).toBe(false); // not eligible → no two-pass cost
      expect(admissionTerms(fullBody())).toBeUndefined();
    });

    it("does NOT escalate an ultra-short matched form (< 4 chars), even when sparse", async () => {
      lexical.total = 1;
      await searchPeople({
        ...baseTopicOpts,
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 2,
      });
      expect(preCountIssued()).toBe(false);
      expect(admissionTerms(fullBody())).toBeUndefined();
    });

    it("DOES escalate an unanchored entry-term match (the tylenol win)", async () => {
      lexical.total = 0; // empty lexical page
      await searchPeople({
        ...baseTopicOpts,
        meshMatchTier: "entry", // unanchored
        meshAmbiguous: false,
        meshMatchedFormLength: 7, // "tylenol"
      });
      // The floor guards on ambiguity/length, never on anchor status — so an
      // unanchored entry-term on an empty page is exactly the case we admit.
      expect(admissionTerms(fullBody())).toEqual({
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.03 },
      });
    });
  });

  describe("concept scope (the result-SET gate is already the admission)", () => {
    it("does NOT escalate under concept scope, even when sparse + eligible", async () => {
      // concept scope pushes the SAME terms{publicationMeshUi} into the always-on
      // filter; OR-ing it into the topic must would make the lexical clause
      // optional and widen the precision gate to "all tagged". Must be excluded.
      lexical.total = 1;
      await searchPeople({
        ...baseTopicOpts,
        scope: "concept",
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 8,
      });
      expect(preCountIssued()).toBe(false); // no wasted pre-count under concept
      expect(admissionTerms(fullBody())).toBeUndefined();
      // The lexical clause stays MANDATORY (still the bare must[0]).
      expect(topicMust(fullBody())[0]).toHaveProperty("multi_match");
    });
  });

  describe("count-only badge == list", () => {
    it("the count-only badge query counts the escalated admitted set when sparse", async () => {
      lexical.total = 3;
      await searchPeople({
        ...baseTopicOpts,
        countOnly: true,
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 8,
      });
      expect(preCountIssued()).toBe(true);
      // The size:0 badge query (built AFTER the escalation mutation) counts the
      // same admitted predicate the full list would return.
      expect(admissionInMust(topicMustFromCount(countOnlyBody()))).toEqual({
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.1 },
      });
    });

    it("the count-only badge is NOT inflated when lexical is not sparse", async () => {
      lexical.total = 75;
      await searchPeople({
        ...baseTopicOpts,
        countOnly: true,
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 8,
      });
      expect(topicMustFromCount(countOnlyBody())[0]).toHaveProperty("multi_match");
      expect(admissionInMust(topicMustFromCount(countOnlyBody()))).toBeUndefined();
    });
  });

  it("never pre-counts or admits without a resolved descriptor", async () => {
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      // no meshDescendantUis
    });
    expect(preCountIssued()).toBe(false);
    expect(attributionWeight(fullBody())).toBeUndefined();
  });
});
