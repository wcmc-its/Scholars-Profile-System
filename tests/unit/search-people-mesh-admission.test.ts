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
// #1951 — cwids returned by the exact-word literal-text lookups; set per test.
const exactCwids = vi.hoisted(() => ({ buckets: [] as string[], sumOther: 0 }));

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_INDEX: "scholars-funding",
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
      // #1951 — the exact-word cwid lookups (publications + funding) are the only
      // queries asking for a `cwids` terms agg; answer them from `exactCwids`.
      const aggs = req.body.aggs as { cwids?: unknown } | undefined;
      if (aggs && "cwids" in aggs) {
        return {
          body: {
            hits: { total: { value: 0 }, hits: [] },
            aggregations: {
              cwids: {
                buckets: exactCwids.buckets.map((key) => ({ key })),
                sum_other_doc_count: exactCwids.sumOther,
              },
            },
          },
        };
      }
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
  const originalPrecount = process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT;
  beforeEach(() => {
    // #1414 flipped the default to the reorder (no dedicated pre-count). This
    // file captures the PRE-COUNT two-pass body shape — its mock drives the
    // escalate/count-gate decision via the size:0 pre-count's `lexical.total`,
    // and the assertions include `preCountIssued()`. Pin the pre-count path
    // explicitly here; the reorder default is covered by
    // search-people-concept-precount.test.ts.
    process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = "on";
    capturedBodies.length = 0;
    exactCwids.buckets = []; // #1951 — per-test literal-match cwids
    exactCwids.sumOther = 0; // no agg truncation unless a test asks for it
    lexical.total = 1;
    groupByMock.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalPrecount === undefined)
      delete process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT;
    else process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = originalPrecount;
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
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.1, _name: "meshAdmit" }, // exact admit weight
      });
    });

    // #1952 — BOTH arms carry a name. The lexical one is what lets the reason gate
    // tell a genuine lexical hit from a mesh-only admit; naming the mesh arm too
    // means msm:1 guarantees every admitted hit matched a NAMED clause, so an empty
    // `matched_queries` is distinguishable from "mesh-only" and the gate fails open.
    it("names BOTH arms of the escalated should, and preserves the lexical clause", async () => {
      lexical.total = 3;
      await searchPeople({
        ...baseTopicOpts,
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 8,
      });

      const should = (topicMust(fullBody())[0] as { bool: { should: Record<string, unknown>[] } })
        .bool.should;
      expect(should).toHaveLength(2);
      const lexArm = should[0] as {
        bool: { _name: string; minimum_should_match: number; should: Record<string, unknown>[] };
      };
      expect(lexArm.bool._name).toBe("lexicalAdmit");
      expect(lexArm.bool.minimum_should_match).toBe(1);
      // The original lexical clause is carried through untouched — same matching,
      // same score, it just sits inside a named wrapper now.
      expect(lexArm.bool.should).toHaveLength(1);
      expect(lexArm.bool.should[0]).toHaveProperty("multi_match");
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
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.03, _name: "meshAdmit" },
      });
    });
  });

  // #1951 — `Exact word` presented as a precision lever but returned the identical
  // set as the default (measured on staging: q=gun violence, 6 vs 6, including
  // three rows rendering "no specific match"). It only downgraded evidence labels.
  // It now admits a scholar iff the query's words literally appear in their own
  // work: one publication, one grant, or their clinical / self-described profile.
  describe("exact-word narrowing (#1951)", () => {
    const exactOpts = { ...baseTopicOpts, scope: "exact" as const };

    /** The narrowing bool ADDED to the topic must under `exact` (the last conjunct). */
    function narrowingShould(): Record<string, unknown>[] {
      const must = topicMust(fullBody());
      const last = must[must.length - 1] as { bool: { should: Record<string, unknown>[] } };
      return last.bool.should;
    }

    // The regression that shipped and had to be reverted: the narrowing REPLACED
    // the lexical clause instead of being AND-ed with it, which made `exact`
    // BROADER than the default (staging: climate 50 -> 142, food insecurity
    // 34 -> 77) because the publications lookup returns every author of every
    // matching paper — a superset of what the people-doc clause admits.
    it("ADDS to the lexical clause — exact must stay a SUBSET of the default", async () => {
      exactCwids.buckets = ["aaa1001"];
      await searchPeople(exactOpts);
      const must = topicMust(fullBody());
      // the original lexical clause survives as its own conjunct…
      expect(must.length).toBeGreaterThanOrEqual(2);
      expect(must[0]).toHaveProperty("multi_match");
      // …and the literal-match arms are an ADDITIONAL requirement, not an
      // alternative admission path.
      expect(must[must.length - 1]).toHaveProperty("bool.minimum_should_match", 1);
    });

    it("admits on a literal publication OR grant OR clinical match, not on concept labels", async () => {
      exactCwids.buckets = ["aaa1001", "bbb2002"];
      await searchPeople(exactOpts);

      const should = narrowingShould();
      // two cwid arms (publications, funding) + the people-doc own-words arm
      expect(should).toHaveLength(3);
      const cwidArms = should.filter((c) => "terms" in c);
      expect(cwidArms).toHaveLength(2);
      expect(cwidArms[0]).toEqual({ terms: { cwid: ["aaa1001", "bbb2002"] } });

      const ownWords = should.find((c) => "multi_match" in c) as {
        multi_match: { fields: string[]; operator: string };
      };
      // Every word must be present — that is what "exact word" claims.
      expect(ownWords.multi_match.operator).toBe("and");
      // A MeSH label is the concept, not the scholar's wording; identity fields are
      // not their work. Both admitted rows under the old behaviour.
      const joined = ownWords.multi_match.fields.join(" ");
      expect(joined).not.toContain("publicationMesh");
      expect(joined).not.toContain("preferredName");
      expect(joined).not.toContain("primaryDepartment");
      expect(joined).toContain("clinicalExpertise");
    });

    it("issues one capped cwid lookup against publications AND one against funding", async () => {
      exactCwids.buckets = ["aaa1001"];
      await searchPeople(exactOpts);
      const lookups = capturedBodies.filter(
        (b) => (b.aggs as { cwids?: unknown } | undefined)?.cwids !== undefined,
      );
      expect(lookups).toHaveLength(2);
      for (const l of lookups) {
        const mm = (
          (l.query as { bool: { must: Record<string, unknown>[] } }).bool
            .must[0] as { multi_match: { operator: string } }
        ).multi_match;
        expect(mm.operator).toBe("and");
        expect(
          ((l.aggs as { cwids: { terms: { size: number } } }).cwids.terms.size),
        ).toBe(5000);
      }
    });

    // The cap is a SILENT truncation: a terms agg keeps the highest-doc_count buckets,
    // so a query broader than 5000 cwids drops the tail scholars whose single matching
    // paper is their only evidence. `sum_other_doc_count` is the only signal that it
    // happened — assert both directions so the warn can't rot into always/never firing.
    it("warns only when the cwid agg was actually truncated", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        exactCwids.buckets = ["aaa1001"];
        exactCwids.sumOther = 0;
        await searchPeople(exactOpts);
        expect(warn).not.toHaveBeenCalled();

        exactCwids.sumOther = 17;
        await searchPeople(exactOpts);
        const events = warn.mock.calls.map((c) => JSON.parse(String(c[0])));
        expect(events.length).toBeGreaterThan(0);
        expect(events[0]).toMatchObject({
          event: "exact_word_cwid_cap_hit",
          cap: 5000,
          droppedDocs: 17,
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("a lookup that matches nothing still leaves the own-words arm (no empty terms clause)", async () => {
      exactCwids.buckets = [];
      await searchPeople(exactOpts);
      const should = narrowingShould();
      expect(should).toHaveLength(1);
      expect(should[0]).toHaveProperty("multi_match");
    });

    // The whole point of the control: it must NOT touch any other scope.
    it("does NOT narrow the default scope — no lookups, topic must unchanged", async () => {
      exactCwids.buckets = ["aaa1001"];
      await searchPeople(baseTopicOpts);
      expect(
        capturedBodies.filter(
          (b) => (b.aggs as { cwids?: unknown } | undefined)?.cwids !== undefined,
        ),
      ).toHaveLength(0);
      expect(topicMust(fullBody())[0]).toHaveProperty("multi_match");
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
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.03, _name: "meshAdmit" },
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
        terms: { publicationMeshUi: DESCENDANTS, boost: 0.1, _name: "meshAdmit" },
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
