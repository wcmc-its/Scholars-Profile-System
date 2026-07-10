/**
 * Issue #309 / SPEC §6.1.2 — name-shape template body assertions.
 *
 * Captures the `body.query` sent to OpenSearch and checks shape, not behavior
 * (the same contract as `search-people-query-shape.test.ts`, which guards the
 * #259 restructure body). The behavior contract is the §10 test matrix; this
 * file locks rows 1, 2, and 6 at the body-shape level:
 *
 *   - v3 + `name` shape  → name-fields-only body (preferredName + fullName
 *     phrase/match, lastNameSort term), NO pub/AOI/overview/title/dept fields.
 *   - the cwid^100 short-circuit term stays in the outer `should`.
 *   - other shapes / legacy mode → untouched #259 cross_fields body.
 *   - a topic pre-filter composes with the name template (row 6).
 *
 * This guards against the name template silently leaking pub-derived fields
 * back into the body — the exact Problem #2 fan-out the template removes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

// Mutable per-test: row 6 needs the topic pre-filter to resolve a cwid set.
// `vi.hoisted` makes the mock available to the hoisted `vi.mock` factory below.
const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: groupByMock,
    },
  },
}));

// Capture the query body across calls so each test can inspect what was sent.
const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: [
    "preferredName^10",
    "fullName^10",
    "areasOfInterest^6",
    "primaryTitle^4",
    "primaryDepartment^3",
    "overview^2",
    "publicationTitles^1",
    "publicationMesh^0.5",
    "publicationAbstracts^0.3",
  ],
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
                  primaryDepartment: "Cell and Developmental Biology",
                  deptName: "Cell and Developmental Biology",
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
 * Unwrap the optional #513 prominence `function_score` to the root bool query.
 * Name shape under v3 wraps the body in a `function_score`; legacy / cwid /
 * empty don't, so accept either shape.
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

/** Index 1 of the outer should is the query branch (name template or #259 body). */
function queryBranch(body: Record<string, unknown>): Record<string, unknown> {
  return outerShould(body)[1];
}

/**
 * Field name targeted by a leaf clause — the inner key of a
 * match/match_phrase/term clause (e.g. `{ match: { preferredName: … } }`
 * → "preferredName").
 */
function leafField(clause: Record<string, unknown>): string {
  const op = Object.keys(clause)[0];
  return Object.keys(clause[op] as Record<string, unknown>)[0];
}

describe("people-index name-shape template — SPEC §6.1.2 (#309)", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("row 1: v3 + name shape emits a name-fields-only body, no pub fields", async () => {
    const result = await searchPeople({
      q: "cantley",
      relevanceMode: "v3",
      shape: "name",
    });

    expect(result.queryShape).toBe("name_template");
    expect(capturedBodies).toHaveLength(1);

    const branch = queryBranch(capturedBodies[0]);
    const inner = branch.bool as {
      should: Record<string, unknown>[];
      minimum_should_match: number;
    };
    expect(inner.minimum_should_match).toBe(1);

    const fields = inner.should.map(leafField);
    // Only the three name fields appear (preferredName/fullName twice each).
    expect(new Set(fields)).toEqual(
      new Set(["preferredName", "fullName", "lastNameSort"]),
    );
    // The Problem #2 fix: no pub-derived / AOI / overview / title / dept field
    // leaks into the name body.
    for (const banned of [
      "areasOfInterest",
      "overview",
      "primaryTitle",
      "primaryDepartment",
      "publicationTitles",
      "publicationMesh",
      "publicationAbstracts",
    ]) {
      expect(fields).not.toContain(banned);
    }
  });

  it("row 1: name body carries the exact §6.1.2 match types and boosts", async () => {
    await searchPeople({ q: "cantley", relevanceMode: "v3", shape: "name" });
    const inner = (queryBranch(capturedBodies[0]).bool as {
      should: Record<string, unknown>[];
    }).should;

    expect(inner).toContainEqual({
      match_phrase: { preferredName: { query: "cantley", slop: 2, boost: 30 } },
    });
    expect(inner).toContainEqual({
      match: { preferredName: { query: "cantley", boost: 10 } },
    });
    expect(inner).toContainEqual({
      match_phrase: { fullName: { query: "cantley", slop: 2, boost: 30 } },
    });
    expect(inner).toContainEqual({
      match: { fullName: { query: "cantley", boost: 10 } },
    });
    // lastNameSort is a keyword term, lowercased — the single-token surname hit.
    expect(inner).toContainEqual({
      term: { lastNameSort: { value: "cantley", boost: 25 } },
    });
  });

  it("row 1: the cwid^100 short-circuit term is preserved in the outer should", async () => {
    await searchPeople({ q: "cantley", relevanceMode: "v3", shape: "name" });
    const should = outerShould(capturedBodies[0]);
    expect(should[0]).toEqual({
      term: { cwid: { value: "cantley", boost: 100 } },
    });
  });

  it("row 2: forward-order full name still routes name shape, lowercases the term", async () => {
    await searchPeople({ q: "Lewis Cantley", relevanceMode: "v3", shape: "name" });
    const inner = (queryBranch(capturedBodies[0]).bool as {
      should: Record<string, unknown>[];
    }).should;
    // match_phrase preserves the raw query (analyzer lowercases at index/search
    // time); the lastNameSort term is explicitly lowercased in the builder.
    expect(inner).toContainEqual({
      match_phrase: { preferredName: { query: "Lewis Cantley", slop: 2, boost: 30 } },
    });
    expect(inner).toContainEqual({
      term: { lastNameSort: { value: "lewis cantley", boost: 25 } },
    });
  });

  it("row 6: name template composes with a topic pre-filter", async () => {
    groupByMock.mockResolvedValue([{ cwid: FIXTURE_CWID }]);
    const result = await searchPeople({
      q: "cantley",
      relevanceMode: "v3",
      shape: "name",
      topic: "oncology-pancreatic",
    });

    expect(result.queryShape).toBe("name_template");
    // Name body is still in place...
    const branch = queryBranch(capturedBodies[0]);
    expect(branch).toHaveProperty("bool");
    // ...and the D-10 topic cwid set rides in the query-level filter.
    const filter = (rootQuery(capturedBodies[0]).bool as { filter: Record<string, unknown>[] })
      .filter;
    expect(filter).toContainEqual({ terms: { cwid: [FIXTURE_CWID] } });
  });

  it("a non-templated shape (cwid) keeps the #259 cross_fields body", async () => {
    // name/topic/department/hybrid all route to a v3 template now (#309/#310/
    // #311); `cwid` is the remaining classifier shape that still rides the
    // existing restructure body, so the name template must not fire here.
    const result = await searchPeople({
      q: "lcc2010",
      relevanceMode: "v3",
      shape: "cwid",
    });

    expect(result.queryShape).toBe("restructured_msm");
    const branch = queryBranch(capturedBodies[0]);
    const mm = (branch.bool as { must: Record<string, unknown>[] }).must[0] as {
      multi_match: { type: string; fields: string[] };
    };
    expect(mm.multi_match.type).toBe("cross_fields");
    expect(mm.multi_match.fields).toContain("publicationMesh^0.5");
  });

  it("legacy mode with a name shape does NOT apply the name template", async () => {
    const result = await searchPeople({
      q: "cantley",
      relevanceMode: "legacy",
      shape: "name",
    });
    // Default restructure flag is on, so the fallback is the #259 body.
    expect(result.queryShape).toBe("restructured_msm");
    const branch = queryBranch(capturedBodies[0]);
    expect(branch).toHaveProperty("bool");
    expect((branch.bool as { must?: unknown }).must).toBeDefined();
  });

  it("empty query under v3 still emits match_all (no name template, no crash)", async () => {
    const result = await searchPeople({
      q: "",
      relevanceMode: "v3",
      shape: "empty",
    });
    expect(result.queryShape).not.toBe("name_template");
    const must = (capturedBodies[0].query as { bool: { must: Record<string, unknown>[] } })
      .bool.must;
    expect(must[0]).toEqual({ match_all: {} });
  });
});

describe("people-index A–Z last-name-initial browse — #1513", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  /** The always-on `queryFilter` array attached as `query.bool.filter`. */
  function filterClauses(body: Record<string, unknown>): Record<string, unknown>[] {
    return (rootQuery(body).bool as { filter?: Record<string, unknown>[] }).filter ?? [];
  }
  const hasLetterPrefix = (body: Record<string, unknown>) =>
    filterClauses(body).some((c) => "prefix" in c);

  it("a single letter scopes the browse to a lowercased lastNameSort prefix", async () => {
    // The overflow link passes an uppercase letter; the index keyword is
    // lowercased, so the clause must be lowercased to match.
    await searchPeople({ q: "", letter: "C", sort: "lastname" });
    expect(filterClauses(capturedBodies[0])).toContainEqual({
      prefix: { lastNameSort: "c" },
    });
  });

  it("ignores a non-single-letter value (no prefix clause)", async () => {
    await searchPeople({ q: "", letter: "Ab", sort: "lastname" });
    expect(hasLetterPrefix(capturedBodies[0])).toBe(false);
  });

  it("adds no prefix clause when no letter is given", async () => {
    await searchPeople({ q: "", sort: "lastname" });
    expect(hasLetterPrefix(capturedBodies[0])).toBe(false);
  });
});
