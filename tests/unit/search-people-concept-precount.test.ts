/**
 * Section B / B2 — `SEARCH_PEOPLE_CONCEPT_PRECOUNT` reorder parity + hop count.
 *
 * The #726 escalate-on-sparse concept admission used to be gated by a dedicated
 * `size:0` pre-count of the lexical predicate — a full extra OpenSearch
 * round-trip fired even on common high-volume topics that will never be sparse,
 * and on the SSR concept-People render it fired twice (badge count + full
 * search). B2 lets `searchPeople` instead read the main search's OWN total and
 * re-run escalated only on sparse (`SEARCH_PEOPLE_CONCEPT_PRECOUNT=off`).
 *
 * This file locks the contract the reorder must hold:
 *   - PARITY: the escalation DECISION (admission present iff sparse + eligible)
 *     and the returned `total` are identical under BOTH flag states — the
 *     `badge == list` invariant survives the reorder.
 *   - HOP COUNT: flag-off drops the dedicated pre-count on the common non-sparse
 *     path (1 search where flag-on pays 2), on both the badge and full paths;
 *     the rare sparse path pays a second search.
 *
 * Captures a DEEP CLONE of each request body at dispatch time (the production
 * code mutates the shared query objects in place after dispatching the lexical
 * pass), so `capturedBodies[i]` is the body AS SENT on hop i — that is what lets
 * us assert the "lexical first, escalated second" ordering precisely.
 *
 * Shape/decision contract only; real recall ordering is validated against a
 * reindexed local OpenSearch (see the runtime probe in the B2 handoff).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

const capturedBodies: Array<Record<string, unknown>> = [];
// Controllable lexical total — the number the escalation decision reads.
const lexical = vi.hoisted(() => ({ total: 1 }));
// How many more docs the escalated (admission-bearing) query "returns" than the
// lexical one. Lets us prove `result.total` reflects the ESCALATED re-run, not
// the discarded lexical pass.
const ESCALATED_BONUS = 100;

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
  MESH_ADMIT_WEIGHT: { exact: 3, "anchored-entry": 1.5, entry: 0.7 },
  MESH_ATTRIBUTION_WEIGHT: { exact: 1.5, "anchored-entry": 1.3, entry: 1.15 },
  MESH_ESCALATION_THRESHOLD: 50,
  MESH_MIN_MATCHED_FORM_LEN: 4,
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      // Deep clone — production mutates the shared query objects in place after
      // this dispatch, so a live reference would show the post-mutation shape.
      capturedBodies.push(JSON.parse(JSON.stringify(req.body)));
      // An escalated body carries the admission `terms { publicationMeshUi, boost }`
      // inside the topic must (the attribution function-score filter is a
      // boost-less terms clause; the `_source` list is a bare string), so the
      // "array immediately followed by boost" signature is unique to it.
      const escalated = /"publicationMeshUi":\[[^\]]*\],"boost":/.test(
        JSON.stringify(req.body),
      );
      const value = escalated ? lexical.total + ESCALATED_BONUS : lexical.total;
      return {
        body: {
          hits: {
            total: { value },
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

const DESCENDANTS = ["D012345", "D067890"];

const baseTopicOpts = {
  q: "ras signaling pancreatic cancer",
  relevanceMode: "v3" as const,
  shape: "topic" as const,
  meshDescendantUis: DESCENDANTS,
  meshMatchTier: "exact" as const,
  meshAmbiguous: false,
  meshMatchedFormLength: 8,
};

/** A bare size:0 count body (no aggs) — the badge / lexical-count hop. */
function isCountBody(b: Record<string, unknown>): boolean {
  return b.size === 0 && !("aggs" in b);
}

/** A full paginated search body (has `from` + aggs). */
function isFullBody(b: Record<string, unknown>): boolean {
  return "from" in b;
}

/** Does the captured body carry the escalation admission terms clause? */
function hasAdmission(b: Record<string, unknown>): boolean {
  return /"publicationMeshUi":\[[^\]]*\],"boost":/.test(JSON.stringify(b));
}

function setFlag(state: "on" | "off") {
  process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = state;
}

describe("B2 — concept-escalation pre-count reorder", () => {
  const prev = process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT;
  beforeEach(() => {
    capturedBodies.length = 0;
    lexical.total = 1;
    groupByMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.clearAllMocks();
    if (prev === undefined) delete process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT;
    else process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = prev;
  });

  describe("flag ON (default) — dedicated pre-count, unchanged today's path", () => {
    beforeEach(() => setFlag("on"));

    it("full path: non-sparse pays the pre-count + the full search (2 hops), no admission", async () => {
      lexical.total = 75; // >= 50, not sparse
      const result = await searchPeople(baseTopicOpts);
      expect(capturedBodies).toHaveLength(2);
      expect(isCountBody(capturedBodies[0])).toBe(true); // the pre-count
      expect(isFullBody(capturedBodies[1])).toBe(true);
      expect(hasAdmission(capturedBodies[1])).toBe(false);
      expect(result.total).toBe(75);
    });

    it("full path: sparse pays the pre-count + an escalated full search (2 hops)", async () => {
      lexical.total = 3; // < 50, sparse
      const result = await searchPeople(baseTopicOpts);
      expect(capturedBodies).toHaveLength(2);
      // The pre-count went out lexical (mutation happens AFTER it dispatched)…
      expect(isCountBody(capturedBodies[0])).toBe(true);
      expect(hasAdmission(capturedBodies[0])).toBe(false);
      // …and the single full search ran escalated.
      expect(isFullBody(capturedBodies[1])).toBe(true);
      expect(hasAdmission(capturedBodies[1])).toBe(true);
      expect(result.total).toBe(3 + ESCALATED_BONUS);
    });

    it("countOnly: sparse pays the pre-count + the escalated badge count (2 hops)", async () => {
      lexical.total = 3;
      const result = await searchPeople({ ...baseTopicOpts, countOnly: true });
      expect(capturedBodies).toHaveLength(2);
      expect(capturedBodies.every(isCountBody)).toBe(true);
      expect(hasAdmission(capturedBodies[0])).toBe(false); // pre-count, lexical
      expect(hasAdmission(capturedBodies[1])).toBe(true); // badge, escalated
      expect(result.total).toBe(3 + ESCALATED_BONUS);
    });
  });

  describe("flag OFF — reordered path reads the main search's own total", () => {
    beforeEach(() => setFlag("off"));

    it("full path: non-sparse runs ONE search (the win) — no pre-count, no admission", async () => {
      lexical.total = 75;
      const result = await searchPeople(baseTopicOpts);
      expect(capturedBodies).toHaveLength(1);
      expect(isFullBody(capturedBodies[0])).toBe(true);
      expect(hasAdmission(capturedBodies[0])).toBe(false);
      expect(result.total).toBe(75);
    });

    it("full path: sparse runs the lexical full search THEN re-runs escalated (2 hops)", async () => {
      lexical.total = 3;
      const result = await searchPeople(baseTopicOpts);
      expect(capturedBodies).toHaveLength(2);
      // First dispatch was the lexical full search (decides escalation)…
      expect(isFullBody(capturedBodies[0])).toBe(true);
      expect(hasAdmission(capturedBodies[0])).toBe(false);
      // …second is the escalated re-run, whose total is what we return.
      expect(isFullBody(capturedBodies[1])).toBe(true);
      expect(hasAdmission(capturedBodies[1])).toBe(true);
      expect(result.total).toBe(3 + ESCALATED_BONUS);
    });

    it("countOnly: non-sparse runs ONE count (the win)", async () => {
      lexical.total = 75;
      const result = await searchPeople({ ...baseTopicOpts, countOnly: true });
      expect(capturedBodies).toHaveLength(1);
      expect(isCountBody(capturedBodies[0])).toBe(true);
      expect(hasAdmission(capturedBodies[0])).toBe(false);
      expect(result.total).toBe(75);
    });

    it("countOnly: sparse counts lexical THEN re-counts escalated (2 hops)", async () => {
      lexical.total = 3;
      const result = await searchPeople({ ...baseTopicOpts, countOnly: true });
      expect(capturedBodies).toHaveLength(2);
      expect(capturedBodies.every(isCountBody)).toBe(true);
      expect(hasAdmission(capturedBodies[0])).toBe(false);
      expect(hasAdmission(capturedBodies[1])).toBe(true);
      expect(result.total).toBe(3 + ESCALATED_BONUS);
    });

    it("ineligible (concept scope) never escalates and never double-runs", async () => {
      lexical.total = 1; // sparse, but concept scope is excluded
      const result = await searchPeople({ ...baseTopicOpts, scope: "concept" });
      expect(capturedBodies).toHaveLength(1);
      expect(hasAdmission(capturedBodies[0])).toBe(false);
      expect(result.total).toBe(1);
    });

    it("ineligible (ambiguous resolution) never escalates and never double-runs", async () => {
      lexical.total = 1;
      const result = await searchPeople({ ...baseTopicOpts, meshAmbiguous: true });
      expect(capturedBodies).toHaveLength(1);
      expect(hasAdmission(capturedBodies[0])).toBe(false);
      expect(result.total).toBe(1);
    });
  });

  // The contract that makes the reorder ship-safe: for the SAME inputs, the two
  // flag states reach the SAME escalation decision and the SAME total. These are
  // the labeled parity cases from the B2 handoff (tylenol-style sparse → admits;
  // crispr / EHR-style non-sparse → does not), asserted as flag-state parity.
  describe("PARITY across flag states (badge == list, same decision)", () => {
    async function run(
      flag: "on" | "off",
      opts: Record<string, unknown>,
    ): Promise<{ total: number; admitted: boolean }> {
      capturedBodies.length = 0;
      setFlag(flag);
      const result = await searchPeople(opts as Parameters<typeof searchPeople>[0]);
      // Admission decision is the same fact whichever body carried the topic
      // clause last; any captured body reflecting the admission proves it fired.
      const admitted = capturedBodies.some(hasAdmission);
      return { total: result.total, admitted };
    }

    it("sparse / escalates (tylenol case): identical total + admission both states", async () => {
      lexical.total = 4; // < 50
      const on = await run("on", baseTopicOpts);
      const off = await run("off", baseTopicOpts);
      expect(on.admitted).toBe(true);
      expect(off.admitted).toBe(true);
      expect(off.total).toBe(on.total);
      expect(off.total).toBe(4 + ESCALATED_BONUS);
    });

    it("non-sparse / does NOT escalate (crispr / EHR case): identical total, no admission", async () => {
      lexical.total = 120; // >= 50
      const on = await run("on", baseTopicOpts);
      const off = await run("off", baseTopicOpts);
      expect(on.admitted).toBe(false);
      expect(off.admitted).toBe(false);
      expect(off.total).toBe(on.total);
      expect(off.total).toBe(120);
    });

    it("countOnly badge total matches the full-list total under flag OFF", async () => {
      // The whole point of the invariant: the inactive-tab badge count and the
      // active-tab list total must agree. Both go through searchPeople, so the
      // reorder must not split them.
      lexical.total = 4;
      capturedBodies.length = 0;
      setFlag("off");
      const list = await searchPeople(baseTopicOpts);
      const badge = await searchPeople({ ...baseTopicOpts, countOnly: true });
      expect(badge.total).toBe(list.total);
    });
  });
});
