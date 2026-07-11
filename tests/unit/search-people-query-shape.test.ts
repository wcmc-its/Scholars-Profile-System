/**
 * Issue #259 §1.1 / SPEC §12 PR-5 (#312) — structural assertion on the
 * people-index restructured query body.
 *
 * Captures the `body.query` sent to OpenSearch and checks shape, not behavior.
 * PR-5 retired the `SEARCH_PEOPLE_QUERY_RESTRUCTURE` flag and its flat
 * best_fields (`legacy_multi_match`) alternative, so the restructured body is
 * now unconditional for any query the §6.1 templates don't route — a shape-less
 * `searchPeople` call (no `shape` opt) lands here even under the v3 default.
 * The multimatch branch must be a bool with:
 *   - must: [multi_match over high-evidence fields, msm "2<-34%"]
 *   - should: [match on publicationAbstracts with boost 0.3]
 * and `publicationAbstracts` must NOT appear in the must clause's fields.
 *
 * This guards against accidental shape drift — e.g. someone re-adding
 * abstracts to the must list "for completeness" and silently defeating
 * msm. The msm-parser test covers semantics; this one covers placement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Capture the query body across calls so each test can inspect what was sent.
const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
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
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
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
                  primaryTitle: "Associate Professor",
                  primaryDepartment: "Medicine",
                  deptName: "Medicine",
                  divisionName: null,
                  personType: "full_time_faculty",
                  publicationCount: 12,
                  grantCount: 1,
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
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

/**
 * Helper: walk the captured request body to the inner query branch the
 * multimatch lives in. Path is stable: bool.must[0].bool.should[1].
 * Index 0 is the CWID term boost; index 1 is the multimatch branch.
 */
function multiMatchBranch(body: Record<string, unknown>): Record<string, unknown> {
  const q = body.query as Record<string, unknown>;
  const must = (q.bool as { must: Record<string, unknown>[] }).must;
  const innerBool = (must[0].bool as { should: Record<string, unknown>[] }).should;
  return innerBool[1] as Record<string, unknown>;
}

import { searchPeople } from "@/lib/api/search";

describe("people-index restructured body — SPEC §12 PR-5 (#312)", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("non-template query emits bool { must: [multi_match w/ msm], should: [abstracts] }", async () => {
    // No `shape` opt → no §6.1 template fires (even under the v3 default), so
    // the query lands on the unconditional restructured body.
    const result = await searchPeople({ q: "electronic health records", page: 0 });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const branch = multiMatchBranch(capturedBodies[0]);
    expect(branch).toHaveProperty("bool");
    const innerBool = branch.bool as {
      must: Record<string, unknown>[];
      should: Record<string, unknown>[];
    };

    // must: multi_match over high-evidence fields with msm. Abstracts MUST NOT appear here.
    expect(innerBool.must).toHaveLength(1);
    const mm = (innerBool.must[0] as { multi_match: Record<string, unknown> }).multi_match;
    // cross_fields (not best_fields) per the v2.2 spec correction — concept
    // queries want field-blended matching, not single-best-field scoring.
    expect(mm.type).toBe("cross_fields");
    // operator:or with msm (not operator:and) because OpenSearch ignores
    // msm under operator:and, and the §1.1 msm table is the contract.
    expect(mm.operator).toBe("or");
    expect(mm.minimum_should_match).toBe("2<-34%");
    expect(mm.fields).not.toContain("publicationAbstracts^0.3");
    const fieldNames = (mm.fields as string[]).map((f) => f.split("^")[0]);
    expect(fieldNames).not.toContain("publicationAbstracts");

    // should: scoring-only match on publicationAbstracts with boost 0.3.
    expect(innerBool.should).toHaveLength(1);
    const should = innerBool.should[0] as { match: { publicationAbstracts: { query: string; boost: number } } };
    expect(should.match.publicationAbstracts.query).toBe("electronic health records");
    expect(should.match.publicationAbstracts.boost).toBe(0.3);
  });

  it("#1119: methodContext rides the scoring-only should, NEVER the msm must ladder", async () => {
    process.env.SEARCH_PEOPLE_METHOD_CONTEXT = "on";
    try {
      await searchPeople({ q: "embryo ploidy time lapse", page: 0 });
      const branch = multiMatchBranch(capturedBodies[0]);
      const innerBool = branch.bool as {
        must: Record<string, unknown>[];
        should: Record<string, unknown>[];
      };
      // NOT in the cross_fields/msm must ladder (would let prose satisfy msm).
      const mm = (innerBool.must[0] as { multi_match: Record<string, unknown> }).multi_match;
      const fieldNames = (mm.fields as string[]).map((f) => f.split("^")[0]);
      expect(fieldNames).not.toContain("methodContext");
      // Present as a scoring-only should match, boost 0.5 (default body).
      const ctxShould = innerBool.should.find(
        (s) => (s as { match?: Record<string, unknown> }).match?.methodContext,
      ) as { match: { methodContext: { query: string; boost: number } } } | undefined;
      expect(ctxShould).toBeDefined();
      expect(ctxShould!.match.methodContext.boost).toBe(0.5);
      expect(ctxShould!.match.methodContext.query).toBe("embryo ploidy time lapse");
    } finally {
      delete process.env.SEARCH_PEOPLE_METHOD_CONTEXT;
    }
  });

  it("empty query skips the multi_match branch entirely (match_all)", async () => {
    const result = await searchPeople({ q: "", page: 0 });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const q = capturedBodies[0].query as Record<string, unknown>;
    const must = (q.bool as { must: Record<string, unknown>[] }).must;
    // Empty trimmed query → match_all branch, no restructured bool to inspect.
    expect(must[0]).toEqual({ match_all: {} });
  });

  it("#1411 — excluding-self facet aggs carry only their filter; `must` is inherited from query scope", async () => {
    await searchPeople({ q: "electronic health records", page: 0 });
    const body = capturedBodies[capturedBodies.length - 1];
    // the lexical admission still lives in the MAIN query must ...
    const mainMust = (body.query as { bool: { must: unknown[] } }).bool.must;
    expect(mainMust.length).toBeGreaterThan(0);
    // ... and each top-level filter-context agg carries ONLY its excluding-self filter —
    // re-embedding the multi-clause `must` per agg was redundant (same doc scope) and
    // just re-matched the query text N times. Guards against a re-introduction.
    const aggs = body.aggs as Record<string, { filter?: { bool: Record<string, unknown> } }>;
    for (const name of ["deptDivs", "personTypes", "activityHasGrants", "activityRecentPub", "piNone", "piMulti"]) {
      const bool = aggs[name]?.filter?.bool;
      expect(bool, `agg ${name}`).toBeDefined();
      expect(bool, `agg ${name}`).not.toHaveProperty("must");
      expect(bool, `agg ${name}`).toHaveProperty("filter");
    }
  });
});
