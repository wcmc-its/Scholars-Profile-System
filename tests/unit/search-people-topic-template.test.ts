/**
 * Issue #310 / SPEC §6.1.3 — topic-shape template body + function_score
 * assertions. Captures the `body.query` sent to OpenSearch and checks shape,
 * not behavior (the §10 matrix is the contract; this locks rows 3, 7, 8 at the
 * body-shape level).
 *
 *   - v3 + topic shape → re-weighted cross_fields body (pub fields lead) wrapped
 *     in a multiplicative function_score (attribution + productivity + sparse
 *     decay).
 *   - the attribution function appears only when a descendant-UI set is passed;
 *     the sparse-decay function is dropped when the #152 hard cull is on.
 *   - `unclassified` is the soft fallback into the same topic body.
 *   - `attributionBoostFired` telemetry tracks the attributionMatch agg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

const capturedBodies: Array<Record<string, unknown>> = [];

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
            // Non-zero so attributionBoostFired resolves true when the
            // attribution path is active.
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
  query: { bool: { must: Record<string, unknown>[]; filter: Record<string, unknown>[] } };
  functions: Array<{ filter: Record<string, unknown>; weight: number }>;
  score_mode: string;
  boost_mode: string;
};

function functionScore(body: Record<string, unknown>): FnScore {
  return (body.query as { function_score: FnScore }).function_score;
}

/** The topic body lives at function_score.query.bool.must[0].bool.should[1]. */
function topicBranch(body: Record<string, unknown>): Record<string, unknown> {
  const must = functionScore(body).query.bool.must;
  return (must[0].bool as { should: Record<string, unknown>[] }).should[1];
}

/** A function is "present" if its filter deep-equals the expected filter. */
function hasFunction(fns: FnScore["functions"], weight: number): boolean {
  return fns.some((f) => f.weight === weight);
}

const DESCENDANTS = ["D012345", "D067890"];

describe("people-index topic-shape template — SPEC §6.1.3 (#310)", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("row 3: v3 + topic shape emits the re-weighted body wrapped in function_score", async () => {
    const result = await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });

    expect(result.queryShape).toBe("topic_template");
    const fs = functionScore(capturedBodies[0]);
    expect(fs.score_mode).toBe("multiply");
    expect(fs.boost_mode).toBe("multiply");

    // Re-weighted ladder: pub fields lead, names demoted.
    const mm = (topicBranch(capturedBodies[0]).bool as { must: Record<string, unknown>[] })
      .must[0] as { multi_match: { fields: string[]; type: string; minimum_should_match: string } };
    expect(mm.multi_match.type).toBe("cross_fields");
    expect(mm.multi_match.minimum_should_match).toBe("2<-34%");
    expect(mm.multi_match.fields).toContain("publicationTitles^6");
    expect(mm.multi_match.fields).toContain("publicationMesh^4");
    expect(mm.multi_match.fields).toContain("preferredName^1");
    // Legacy weights must NOT appear.
    expect(mm.multi_match.fields).not.toContain("publicationMesh^0.5");
    expect(mm.multi_match.fields).not.toContain("preferredName^10");

    // Abstracts ride the scoring-only should at the raised topic boost.
    const should = (topicBranch(capturedBodies[0]).bool as { should: Record<string, unknown>[] })
      .should;
    expect(should[0]).toEqual({
      match: { publicationAbstracts: { query: "ras signaling pancreatic cancer", boost: 0.5 } },
    });
  });

  it("row 3: all three modifiers fire when a descendant set is present", async () => {
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    const fns = functionScore(capturedBodies[0]).functions;

    // 1. attribution ×1.5 on the descendant UIs
    expect(fns).toContainEqual({
      filter: { terms: { publicationMeshUi: DESCENDANTS } },
      weight: 1.5,
    });
    // 2. productive-author, mutually exclusive ranges
    expect(fns).toContainEqual({
      filter: { range: { publicationCount: { gte: 20 } } },
      weight: 1.2,
    });
    expect(fns).toContainEqual({
      filter: { range: { publicationCount: { gte: 5, lt: 20 } } },
      weight: 1.1,
    });
    // 3. sparse decay ×0.7 (hard cull off)
    expect(hasFunction(fns, 0.7)).toBe(true);
  });

  it("topic shape WITHOUT a resolved descriptor omits the attribution function", async () => {
    const result = await searchPeople({
      q: "some long multi word topical query here",
      relevanceMode: "v3",
      shape: "topic",
      // no meshDescendantUis
    });
    expect(result.queryShape).toBe("topic_template");
    const fns = functionScore(capturedBodies[0]).functions;
    expect(hasFunction(fns, 1.5)).toBe(false);
    // productivity + sparse decay still present
    expect(hasFunction(fns, 1.2)).toBe(true);
    expect(hasFunction(fns, 0.7)).toBe(true);
    // ...and with no boost in play, telemetry is null, not false.
    expect(result.attributionBoostFired).toBeNull();
  });

  it("row 7: the #152 hard cull suppresses the sparse-decay function (no double-up)", async () => {
    await searchPeople({
      q: "tau alzheimer disease pathology",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
      filters: { includeIncomplete: false },
    });
    const body = capturedBodies[0];
    // sparse decay (0.7) is gone...
    expect(hasFunction(functionScore(body).functions, 0.7)).toBe(false);
    // ...but the productive-author boost remains.
    expect(hasFunction(functionScore(body).functions, 1.2)).toBe(true);
    // ...and the isComplete hard cull is applied as an always-on query filter.
    expect(functionScore(body).query.bool.filter).toContainEqual({
      term: { isComplete: true },
    });
  });

  it("row 8: unclassified shape falls back to the topic body", async () => {
    const result = await searchPeople({
      q: "xj9k",
      relevanceMode: "v3",
      shape: "unclassified",
    });
    expect(result.queryShape).toBe("topic_template");
    // function_score wraps it; no attribution (no descriptor).
    expect(hasFunction(functionScore(capturedBodies[0]).functions, 1.5)).toBe(false);
  });

  it("attributionBoostFired is true when the attributionMatch agg is non-empty", async () => {
    const result = await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    expect(result.attributionBoostFired).toBe(true);
  });

  it("legacy mode with a topic shape does NOT apply the topic template", async () => {
    const result = await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "legacy",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    expect(result.queryShape).toBe("restructured_msm");
    // No function_score wrapper — plain bool query.
    expect(capturedBodies[0].query).toHaveProperty("bool");
    expect(capturedBodies[0].query).not.toHaveProperty("function_score");
    expect(result.attributionBoostFired).toBeNull();
  });
});
