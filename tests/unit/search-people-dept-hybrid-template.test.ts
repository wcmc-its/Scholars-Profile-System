/**
 * Issue #311 / SPEC §6.1.4 — department + hybrid template body assertions.
 *
 * Captures the `body.query` sent to OpenSearch and checks shape, not behavior
 * (the §10 test matrix is the contract; this file locks rows 4, 5, and 11 at
 * the body-shape level):
 *
 *   - v3 + `department` shape → dept/title/name ladder (primaryDepartment 20,
 *     primaryTitle 8, name fields 2, areasOfInterest 1), NO pub-derived fields,
 *     NO overview, and NO function_score (sparse decay is §6.1.3-only).
 *   - v3 + `hybrid` shape → name-template clauses ⊕ the topic boost ladder
 *     (no-msm cross_fields) ⊕ abstracts, additive in a single bool, no
 *     function_score. Locks `cantley ras` (row 4) and the WCM institutional
 *     name (row 11).
 *   - the cwid^100 short-circuit term stays in the outer `should`.
 *   - legacy mode leaves both shapes on the #259 restructure body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

// Mutable per-test: the topic pre-filter case needs a resolved cwid set.
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
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
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
                  slug: "lewis-cantley",
                  preferredName: "Lewis C. Cantley",
                  primaryTitle: "Professor",
                  primaryDepartment: "Cardiology",
                  deptName: "Cardiology",
                  divisionName: null,
                  personType: "full_time_faculty",
                  publicationCount: 400,
                  grantCount: 5,
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

import { searchPeople } from "@/lib/api/search";

/**
 * Unwrap the #513 prominence `function_score` (dept + hybrid bodies are wrapped
 * under v3) to the root bool query. Legacy mode isn't wrapped, so accept either.
 */
function rootQuery(body: Record<string, unknown>): Record<string, unknown> {
  const q = body.query as Record<string, unknown>;
  return ((q.function_score as { query?: Record<string, unknown> })?.query ??
    q) as Record<string, unknown>;
}

/** The outer should clause holds [cwid term, queryBranch] (index 0 / 1). */
function outerShould(body: Record<string, unknown>): Record<string, unknown>[] {
  const must = (rootQuery(body).bool as { must: Record<string, unknown>[] }).must;
  return (must[0].bool as { should: Record<string, unknown>[] }).should;
}

/** The score functions on the #513 prominence wrapper, or [] if unwrapped. */
function prominenceFunctions(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const fs = (body.query as { function_score?: { functions: Array<Record<string, unknown>> } })
    .function_score;
  return fs?.functions ?? [];
}

/** Index 1 of the outer should is the query branch (template body). */
function queryBranch(body: Record<string, unknown>): Record<string, unknown> {
  return outerShould(body)[1];
}

/** The should clauses inside a template's `bool`. */
function branchShould(body: Record<string, unknown>): Record<string, unknown>[] {
  return (queryBranch(body).bool as { should: Record<string, unknown>[] }).should;
}

/**
 * Field name targeted by a leaf clause — the inner key of a
 * match/match_phrase/term clause. A multi_match clause has no single inner
 * field key, so it maps to the sentinel "<multi_match>".
 */
function leafField(clause: Record<string, unknown>): string {
  const op = Object.keys(clause)[0];
  if (op === "multi_match") return "<multi_match>";
  return Object.keys(clause[op] as Record<string, unknown>)[0];
}

describe("people-index department + hybrid templates — SPEC §6.1.4 (#311)", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Department shape (§10 row 5) ------------------------------------------

  it("row 5: v3 + department shape emits a dept/title/name body, no pub fields", async () => {
    const result = await searchPeople({
      q: "cardiology",
      relevanceMode: "v3",
      shape: "department",
    });

    expect(result.queryShape).toBe("department_template");
    expect(capturedBodies).toHaveLength(1);

    const should = branchShould(capturedBodies[0]);
    expect(
      (queryBranch(capturedBodies[0]).bool as { minimum_should_match: number })
        .minimum_should_match,
    ).toBe(1);

    const fields = should.map(leafField);
    expect(new Set(fields)).toEqual(
      new Set(["primaryDepartment", "primaryTitle", "preferredName", "fullName", "areasOfInterest"]),
    );
    // No pub-derived field, no overview, leaks into the department body.
    for (const banned of [
      "overview",
      "publicationTitles",
      "publicationMesh",
      "publicationAbstracts",
      "lastNameSort",
    ]) {
      expect(fields).not.toContain(banned);
    }
  });

  it("row 5: department body carries the exact §6.1.4 match types and boosts", async () => {
    await searchPeople({ q: "cardiology", relevanceMode: "v3", shape: "department" });
    const should = branchShould(capturedBodies[0]);

    // primaryDepartment is a match_phrase at 20 (a single-token dept name
    // behaves identically to `match`).
    expect(should).toContainEqual({
      match_phrase: { primaryDepartment: { query: "cardiology", boost: 20 } },
    });
    expect(should).toContainEqual({
      match: { primaryTitle: { query: "cardiology", boost: 8 } },
    });
    expect(should).toContainEqual({
      match: { preferredName: { query: "cardiology", boost: 2 } },
    });
    expect(should).toContainEqual({
      match: { fullName: { query: "cardiology", boost: 2 } },
    });
    expect(should).toContainEqual({
      match: { areasOfInterest: { query: "cardiology", boost: 1 } },
    });
  });

  it("row 5: the department body is wrapped in the #513 prominence function_score (sum/multiply)", async () => {
    await searchPeople({ q: "cardiology", relevanceMode: "v3", shape: "department" });
    const fs = (capturedBodies[0].query as { function_score?: { score_mode: string; boost_mode: string } })
      .function_score;
    expect(fs).toBeDefined();
    // Additive composition (not the topic template's multiply mode).
    expect(fs!.score_mode).toBe("sum");
    expect(fs!.boost_mode).toBe("multiply");
    // The pub-count lead + faculty/grant additive boosts; NOT the topic
    // attribution (1.5) / sparse-decay (0.7) multiplicative modifiers.
    const fns = prominenceFunctions(capturedBodies[0]);
    expect(fns).toContainEqual({
      field_value_factor: {
        field: "publicationCount",
        modifier: "ln1p",
        factor: 1,
        missing: 0,
      },
    });
    expect(fns.some((f) => "weight" in f && f.weight === 0.7)).toBe(false);
  });

  it("row 5: the cwid^100 short-circuit term is preserved for the department body", async () => {
    await searchPeople({ q: "cardiology", relevanceMode: "v3", shape: "department" });
    expect(outerShould(capturedBodies[0])[0]).toEqual({
      term: { cwid: { value: "cardiology", boost: 100 } },
    });
  });

  it("department template composes with a topic pre-filter", async () => {
    groupByMock.mockResolvedValue([{ cwid: FIXTURE_CWID }]);
    const result = await searchPeople({
      q: "cardiology",
      relevanceMode: "v3",
      shape: "department",
      topic: "oncology-pancreatic",
    });

    expect(result.queryShape).toBe("department_template");
    const filter = (rootQuery(capturedBodies[0]).bool as { filter: Record<string, unknown>[] })
      .filter;
    expect(filter).toContainEqual({ terms: { cwid: [FIXTURE_CWID] } });
  });

  // --- Hybrid shape (§10 rows 4, 11) -----------------------------------------

  it("row 4: v3 + hybrid shape combines name clauses with the topic ladder, additively", async () => {
    const result = await searchPeople({
      q: "cantley ras",
      relevanceMode: "v3",
      shape: "hybrid",
    });

    expect(result.queryShape).toBe("hybrid_template");
    const should = branchShould(capturedBodies[0]);

    // Name-template half: the strong-boost clauses that pin the anchored name.
    expect(should).toContainEqual({
      match_phrase: { preferredName: { query: "cantley ras", slop: 2, boost: 30 } },
    });
    expect(should).toContainEqual({
      match: { fullName: { query: "cantley ras", boost: 10 } },
    });
    expect(should).toContainEqual({
      term: { lastNameSort: { value: "cantley ras", boost: 25 } },
    });

    // Topic half: the re-weighted boost ladder as a no-msm cross_fields clause
    // (soft/additive — the topic-template must+msm shape is NOT used here).
    const mm = should.find((c) => Object.keys(c)[0] === "multi_match") as {
      multi_match: { fields: string[]; type: string; minimum_should_match?: string };
    };
    expect(mm).toBeDefined();
    expect(mm.multi_match.type).toBe("cross_fields");
    expect(mm.multi_match.fields).toContain("publicationTitles^6");
    expect(mm.multi_match.fields).toContain("publicationMesh^4");
    expect(mm.multi_match.minimum_should_match).toBeUndefined();

    // Abstracts ride the scoring-only should at the raised topic boost.
    expect(should).toContainEqual({
      match: { publicationAbstracts: { query: "cantley ras", boost: 0.5 } },
    });
  });

  it("row 4: the hybrid body is wrapped in the #513 prominence function_score (sum/multiply)", async () => {
    await searchPeople({ q: "cantley ras", relevanceMode: "v3", shape: "hybrid" });
    const fs = (capturedBodies[0].query as { function_score?: { score_mode: string; boost_mode: string } })
      .function_score;
    expect(fs).toBeDefined();
    expect(fs!.score_mode).toBe("sum");
    expect(fs!.boost_mode).toBe("multiply");
    // Additive prominence (pub-count lead + faculty/grant); NOT the topic
    // attribution / sparse-decay multipliers (those are §6.1.3-only).
    const fns = prominenceFunctions(capturedBodies[0]);
    expect(fns.some((f) => "weight" in f && f.weight === 1.5)).toBe(false);
    expect(fns.some((f) => "weight" in f && f.weight === 0.7)).toBe(false);
  });

  it("row 11: the WCM institutional-name hybrid routes the hybrid body", async () => {
    const result = await searchPeople({
      q: "weill cornell medicine pediatric oncology",
      relevanceMode: "v3",
      shape: "hybrid",
    });

    expect(result.queryShape).toBe("hybrid_template");
    const should = branchShould(capturedBodies[0]);
    // Same additive shape: name clauses + topic ladder + abstracts.
    expect(should.map(leafField)).toContain("<multi_match>");
    expect(should).toContainEqual({
      match_phrase: {
        fullName: { query: "weill cornell medicine pediatric oncology", slop: 2, boost: 30 },
      },
    });
  });

  // --- Isolation / legacy ----------------------------------------------------

  it("legacy mode with a department shape does NOT apply the department template", async () => {
    const result = await searchPeople({
      q: "cardiology",
      relevanceMode: "legacy",
      shape: "department",
    });
    expect(result.queryShape).toBe("restructured_msm");
    const mm = (queryBranch(capturedBodies[0]).bool as { must: Record<string, unknown>[] })
      .must[0] as { multi_match: { fields: string[] } };
    expect(mm.multi_match.fields).toContain("publicationMesh^0.5");
  });

  it("legacy mode with a hybrid shape does NOT apply the hybrid template", async () => {
    const result = await searchPeople({
      q: "cantley ras",
      relevanceMode: "legacy",
      shape: "hybrid",
    });
    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies[0].query).not.toHaveProperty("function_score");
  });
});
