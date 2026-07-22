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
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: Object.freeze([
    "preferredName^1",
    "fullName^1",
    "areasOfInterest^3",
    "primaryTitle^3",
    "primaryDepartment^1",
    "overview^2",
    "publicationTitles^6",
    "publicationMesh^4",
  ]),
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  // #726 — searchPeople now dereferences these on the topic-attribution path.
  MESH_ADMIT_WEIGHT: { exact: 3, "anchored-entry": 1.5, entry: 0.7 },
  MESH_ATTRIBUTION_WEIGHT: { exact: 1.5, "anchored-entry": 1.3, entry: 1.15 },
  MESH_ESCALATION_THRESHOLD: 50,
  MESH_MIN_MATCHED_FORM_LEN: 4,
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

/**
 * The body sent to OpenSearch now has TWO nested function_score layers under
 * v3 + topic (#513 §5.4 follow-up):
 *   outer (`sum`)  = prominence factor (BASE + ln1p(pub) + faculty + grant)
 *   inner (`multiply`) = topic ladder (attribution × productivity × decay)
 * This helper drills to the INNER topic function_score, which is what every
 * existing §6.1.3 assertion in this file operates on.
 */
function functionScore(body: Record<string, unknown>): FnScore {
  const outer = (body.query as { function_score: { query: Record<string, unknown> } })
    .function_score;
  return (outer.query as { function_score: FnScore }).function_score;
}

function outerProminence(body: Record<string, unknown>): {
  score_mode: string;
  boost_mode: string;
  functions: Array<Record<string, unknown>>;
} {
  return (body.query as { function_score: { score_mode: string; boost_mode: string; functions: Array<Record<string, unknown>> } })
    .function_score;
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

  it("#513 §5.4 follow-up: outer additive prominence wraps the inner topic multiply", async () => {
    // Additive-over-multiplicative: outer sum (prominence) × inner multiply
    // (attribution × productivity × decay) × text. A blunt multiplicative
    // pub-count factor composed with the topic ladder blew up established
    // authors disproportionately ("melanoma distortion") in the §5.4 probe.
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });

    const outer = outerProminence(capturedBodies[0]);
    expect(outer.score_mode).toBe("sum");
    expect(outer.boost_mode).toBe("multiply");

    // The four prominence functions, in any order.
    expect(outer.functions).toHaveLength(4);
    expect(outer.functions).toContainEqual({ weight: 1.0 });
    expect(outer.functions).toContainEqual({
      field_value_factor: {
        field: "publicationCount",
        modifier: "ln1p",
        factor: 1,
        missing: 0,
      },
    });
    expect(outer.functions).toContainEqual({
      filter: { term: { personType: "full_time_faculty" } },
      weight: 1.0,
    });
    expect(outer.functions).toContainEqual({
      filter: { term: { hasActiveGrants: true } },
      weight: 0.5,
    });

    // Inner is still the multiplicative topic ladder, untouched.
    const inner = functionScore(capturedBodies[0]);
    expect(inner.score_mode).toBe("multiply");
    expect(inner.boost_mode).toBe("multiply");
  });

  it("skipFacetAggs omits the facet aggregations from the request body (spine fan-out breaker)", async () => {
    // Default: the facet aggs are attached — today's /search body.
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    expect(capturedBodies[0]).toHaveProperty("aggs");
    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    expect(aggs.deptDivs).toBeDefined();
    expect(aggs.personTypes).toBeDefined();
    expect(aggs.attributionMatch).toBeDefined();

    // skipFacetAggs: the `aggs` object is NOT sent, so OpenSearch runs none of the
    // nine facet aggregations (the per-request heap the spine's fan-out piled up).
    // The scoring query + hit fetch are untouched — only aggs are gated off.
    capturedBodies.length = 0;
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
      skipFacetAggs: true,
    });
    expect(capturedBodies[0]).not.toHaveProperty("aggs");
    expect(capturedBodies[0].query).toHaveProperty("function_score");
    expect(capturedBodies[0].size).toBeDefined();
  });
});

// Issue #692 — generic-term demotion on the topic body.
describe("generic-term demotion — #692 (people topic shape)", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  const topicMust0 = (body: Record<string, unknown>) =>
    (topicBranch(body).bool as { must: Record<string, unknown>[] }).must[0];
  const topicShould0 = (body: Record<string, unknown>) =>
    (topicBranch(body).bool as { should: Record<string, unknown>[] }).should[0];
  const highlightOf = (body: Record<string, unknown>) =>
    (body as { highlight: Record<string, unknown> }).highlight;

  it("off (no genericDemote): plain cross_fields on the full query, no highlight_query", async () => {
    await searchPeople({
      q: "microbiome research",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    const must0 = topicMust0(capturedBodies[0]) as { multi_match?: { query: string } };
    expect(must0.multi_match?.query).toBe("microbiome research");
    expect(highlightOf(capturedBodies[0]).highlight_query).toBeUndefined();
  });

  it("on: gates on the content query, discounts the full query ×0.1, highlights content only", async () => {
    await searchPeople({
      q: "microbiome research",
      contentQuery: "microbiome",
      genericDemote: true,
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    const gate = topicMust0(capturedBodies[0]) as {
      bool: {
        must: Array<{ multi_match: { query: string; minimum_should_match: string } }>;
        should: Array<{ multi_match: { query: string; boost: number } }>;
      };
    };
    // Gate = content query with the topic msm; discount = full query at 0.1.
    expect(gate.bool.must[0].multi_match.query).toBe("microbiome");
    expect(gate.bool.must[0].multi_match.minimum_should_match).toBe("2<-34%");
    expect(gate.bool.should[0].multi_match.query).toBe("microbiome research");
    expect(gate.bool.should[0].multi_match.boost).toBe(0.1);
    // Abstracts now key on content too.
    expect(topicShould0(capturedBodies[0])).toEqual({
      match: { publicationAbstracts: { query: "microbiome", boost: 0.5 } },
    });
    // Highlight restricted to the content query over the highlighted fields.
    const hq = highlightOf(capturedBodies[0]).highlight_query as {
      multi_match: { query: string; fields: string[] };
    };
    expect(hq.multi_match.query).toBe("microbiome");
    expect(hq.multi_match.fields).toEqual([
      "preferredName",
      "areasOfInterest",
      "overview",
    ]);
  });

  it("inert when contentQuery equals the full query (nothing stripped)", async () => {
    await searchPeople({
      q: "microbiome",
      contentQuery: "microbiome",
      genericDemote: true,
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    const must0 = topicMust0(capturedBodies[0]) as { multi_match?: { query: string } };
    expect(must0.multi_match?.query).toBe("microbiome");
    expect(highlightOf(capturedBodies[0]).highlight_query).toBeUndefined();
  });
});

// Issue #824 §4c — method-family boost is flag-gated (reindex-then-flip) and
// must NOT mutate the exported constant ladder (frozen above to prove it).
describe("method-family boost — #824 §4c (people topic shape)", () => {
  const FLAG = "SEARCH_PEOPLE_METHOD_FAMILY";
  let prior: string | undefined;

  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
    prior = process.env[FLAG];
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prior;
    vi.clearAllMocks();
  });

  const topicFields = (body: Record<string, unknown>): string[] => {
    const mm = (topicBranch(body).bool as { must: Record<string, unknown>[] })
      .must[0] as { multi_match: { fields: string[] } };
    return mm.multi_match.fields;
  };

  it("flag OFF (default): methodFamily is NOT in the topic boost fields", async () => {
    delete process.env[FLAG];
    await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    const fields = topicFields(capturedBodies[0]);
    expect(fields.some((f) => f.startsWith("methodFamily"))).toBe(false);
    // The canonical topic ladder is intact.
    expect(fields).toContain("publicationMesh^4");
  });

  it("flag ON: methodFamily^4 appears in the topic boost fields", async () => {
    process.env[FLAG] = "on";
    await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    const fields = topicFields(capturedBodies[0]);
    expect(fields).toContain("methodFamily^4");
    // The constant ladder fields are still present (appended, not replaced).
    expect(fields).toContain("publicationMesh^4");
    expect(fields).toContain("preferredName^1");
  });

  it("flag ON does NOT mutate the exported constant (frozen array, fresh copy each call)", async () => {
    process.env[FLAG] = "on";
    await searchPeople({
      q: "crispr",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    // A second call with the flag OFF must not see a leaked methodFamily entry.
    delete process.env[FLAG];
    capturedBodies.length = 0;
    await searchPeople({
      q: "crispr",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    expect(topicFields(capturedBodies[0]).some((f) => f.startsWith("methodFamily"))).toBe(
      false,
    );
  });
});

// #1344 — scoring-only proximity boost on the topic template (dark by default).
describe("phrase boost — #1344 (people topic shape)", () => {
  const FLAG = "SEARCH_PEOPLE_PHRASE_BOOST";
  let prior: string | undefined;

  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
    prior = process.env[FLAG];
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prior;
    vi.clearAllMocks();
  });

  const topicShould = (body: Record<string, unknown>): Record<string, unknown>[] =>
    (topicBranch(body).bool as { should: Record<string, unknown>[] }).should;

  it("flag OFF (default): the topic should[] has NO match_phrase clause (byte-identical)", async () => {
    delete process.env[FLAG];
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    expect(topicShould(capturedBodies[0]).some((c) => "match_phrase" in c)).toBe(false);
  });

  it("flag ON: adds bounded-slop match_phrase clauses; admission msm is unchanged", async () => {
    process.env[FLAG] = "on";
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: DESCENDANTS,
    });
    const should = topicShould(capturedBodies[0]);
    expect(should).toContainEqual({
      match_phrase: {
        publicationTitles: { query: "ras signaling pancreatic cancer", slop: 8, boost: 6 },
      },
    });
    expect(should).toContainEqual({
      match_phrase: {
        areasOfInterest: { query: "ras signaling pancreatic cancer", slop: 4, boost: 4 },
      },
    });
    // Admission untouched: the cross_fields msm is still the canonical value.
    const mm = (topicBranch(capturedBodies[0]).bool as { must: Record<string, unknown>[] })
      .must[0] as { multi_match: { minimum_should_match: string } };
    expect(mm.multi_match.minimum_should_match).toBe("2<-34%");
  });
});

/**
 * MATCHA_GLOSS_RERANK — the optional gloss RE-RANKER (docs/2026-07-21-matcha-gloss-reranker-handoff.md).
 * A `rescore` re-orders the top `window_size` hits by BM25(gloss) over the shape's content fields; it
 * can neither add nor drop a document, so recall is invariant. The guard that matters: absent/blank
 * `rescoreQuery` ⇒ the body carries NO `rescore` key (byte-identical to today).
 */
describe("gloss re-ranker rescore — MATCHA_GLOSS_RERANK", () => {
  const GLOSS = "reprogramming cellular metabolism to fuel tumor growth";
  const TOPIC_FIELDS = [
    "preferredName^1",
    "fullName^1",
    "areasOfInterest^3",
    "primaryTitle^3",
    "primaryDepartment^1",
    "overview^2",
    "publicationTitles^6",
    "publicationMesh^4",
  ];

  const topicOpts = { q: "cancer metabolism", relevanceMode: "v3" as const, shape: "topic" as const };
  /** The MAIN search body is the hit-returning page (`size: PAGE_SIZE`); size:0 pre-count/agg
   *  bodies (which never carry a rescore) also land in `capturedBodies`, so select by size. */
  const mainBody = () =>
    capturedBodies.find((b) => (b as { size?: number }).size === 20) as Record<string, unknown>;

  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("appends a rescore that re-orders by BM25(gloss) over the topic content fields", async () => {
    await searchPeople({ ...topicOpts, rescoreQuery: GLOSS, rescoreWeight: 0.5, rescoreWindow: 100 });
    const rescore = mainBody().rescore as {
      window_size: number;
      query: {
        rescore_query: { multi_match: { query: string; fields: string[]; type: string; operator: string } };
        query_weight: number;
        rescore_query_weight: number;
        score_mode: string;
      };
    };
    expect(rescore.window_size).toBe(100);
    expect(rescore.query.query_weight).toBe(1);
    expect(rescore.query.rescore_query_weight).toBe(0.5);
    expect(rescore.query.score_mode).toBe("total");
    // Same content fields the bare-token topic query targets (peopleTopicFields()).
    expect(rescore.query.rescore_query.multi_match.query).toBe(GLOSS);
    expect(rescore.query.rescore_query.multi_match.fields).toEqual(TOPIC_FIELDS);
    expect(rescore.query.rescore_query.multi_match.operator).toBe("or");
  });

  it("λ defaults to 1 when rescoreWeight is omitted", async () => {
    await searchPeople({ ...topicOpts, rescoreQuery: GLOSS, rescoreWindow: 100 });
    const rescore = mainBody().rescore as { query: { rescore_query_weight: number } };
    expect(rescore.query.rescore_query_weight).toBe(1);
  });

  it("window_size never drops below the current page (from+size), even with a tiny rescoreWindow", async () => {
    await searchPeople({ ...topicOpts, rescoreQuery: GLOSS, rescoreWeight: 1, rescoreWindow: 10 });
    // page 0 ⇒ from+size = 0 + 20 = 20 > 10 ⇒ the page floor wins, so a page's window always spans it.
    expect((mainBody().rescore as { window_size: number }).window_size).toBe(20);
  });

  it("pageSize override widens from/size AND the window_size floor to the whole pool (spine one-request path)", async () => {
    // Recall-neutrality fix: the spine passes pageSize=TERM_DEPTH (100) so the rescore applies ONCE
    // over the full pool instead of stitching 5 independently-rescored 20-hit pages.
    await searchPeople({ ...topicOpts, pageSize: 100, rescoreQuery: GLOSS, rescoreWeight: 0.5, rescoreWindow: 10 });
    // The hit-returning body now has size:100, so mainBody()'s size:20 selector no longer matches it.
    const body = capturedBodies.find((b) => (b as { size?: number }).size === 100) as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(body.from).toBe(0);
    expect(body.size).toBe(100);
    // window_size floor = from+size = 0+100 = 100 (> the tiny rescoreWindow=10), proving pageSize
    // threads into the floor — a paged 20-window can no longer under-cover the pool.
    expect((body.rescore as { window_size: number }).window_size).toBe(100);
  });

  it("NO rescoreQuery ⇒ the body has no rescore key (byte-identical guard)", async () => {
    await searchPeople({ ...topicOpts });
    expect(mainBody().rescore).toBeUndefined();
  });

  it("blank / whitespace-only rescoreQuery ⇒ no rescore (trim guard)", async () => {
    await searchPeople({ ...topicOpts, rescoreQuery: "   ", rescoreWeight: 0.5, rescoreWindow: 100 });
    expect(mainBody().rescore).toBeUndefined();
  });
});
