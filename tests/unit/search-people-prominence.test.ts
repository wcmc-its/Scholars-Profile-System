/**
 * Issue #513 / baseline §5.4 — v3 prominence factor body assertions.
 *
 * The name / department / hybrid bodies (which carry no function_score of their
 * own) are wrapped in an additive prominence `function_score`:
 *
 *   final = text × ( BASE + ln1p(FACTOR·publicationCount)
 *                    + FACULTY·[full_time_faculty] + GRANT·[hasActiveGrants] )
 *
 * (`score_mode: sum`, `boost_mode: multiply`). Publication count leads
 * (log-saturated — the only §5.4 probe variant that fixed #4 `wong`); faculty
 * and active-grant are additive boosts. For the topic shape, the prominence
 * `function_score` is the OUTER layer wrapping the inner multiplicative
 * attribution + productive-author + sparse-decay `function_score` — the
 * §5.4 calibration follow-up. This file locks the wrapper shape, the exact
 * functions, the v3 gate, and the additive-over-multiplicative nesting for
 * topic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

const capturedBodies: Array<Record<string, unknown>> = [];
// #1343 — author buckets the mocked concept-concentration aggs return (set per test).
// `conceptBuckets` = on-topic agg (meshDescriptorUi filter); `totalBuckets` = the
// per-author total-pub agg (wcmAuthorCwids filter, the fraction denominator).
let conceptBuckets: { key: string; doc_count: number }[] = [];
let totalBuckets: { key: string; doc_count: number }[] = [];

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
  // Research-Area concentration boost constants (spec §3.2).
  AREA_BOOST_W_HI: 8,
  AREA_BOOST_W_MID: 4,
  AREA_BOOST_W_LO: 1.5,
  AREA_BOOST_HI_FRAC: 0.5,
  AREA_BOOST_MID_FRAC: 0.2,
  AREA_BOOST_TOP_N: 200,
  CONCEPT_CONCENTRATION_MIN_PUBS: 3,
  concentrationExponent: () => 2,
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  // #726 — searchPeople now dereferences these on the topic-attribution path.
  MESH_ADMIT_WEIGHT: { exact: 3, "anchored-entry": 1.5, entry: 0.7 },
  MESH_ATTRIBUTION_WEIGHT: { exact: 1.5, "anchored-entry": 1.3, entry: 1.15 },
  MESH_ESCALATION_THRESHOLD: 50,
  MESH_MIN_MATCHED_FORM_LEN: 4,
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      // #1343 concept-concentration aggs — the on-topic agg filters on
      // meshDescriptorUi; the total-pub agg (fraction denominator) filters on
      // wcmAuthorCwids. Return the matching bucket set per call.
      const aggs = req.body.aggs as { byAuthor?: unknown } | undefined;
      if (aggs && "byAuthor" in aggs) {
        const filter =
          ((req.body.query as { bool?: { filter?: { terms?: Record<string, unknown> }[] } })?.bool
            ?.filter ?? [])[0]?.terms ?? {};
        const buckets = "wcmAuthorCwids" in filter ? totalBuckets : conceptBuckets;
        return { body: { aggregations: { byAuthor: { buckets } } } };
      }
      return {
        body: {
          hits: { total: { value: 1 }, hits: [] },
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

import { searchPeople, getConceptScholarConcentration } from "@/lib/api/search";

type FnScore = {
  query: Record<string, unknown>;
  functions: Array<Record<string, unknown>>;
  score_mode: string;
  boost_mode: string;
};

function functionScore(body: Record<string, unknown>): FnScore | undefined {
  return (body.query as { function_score?: FnScore }).function_score;
}

/** The four prominence functions, in any order. */
const EXPECTED_PROMINENCE_FUNCTIONS = [
  { weight: 1.0 },
  {
    field_value_factor: {
      field: "publicationCount",
      modifier: "ln1p",
      factor: 1,
      missing: 0,
    },
  },
  { filter: { term: { personType: "full_time_faculty" } }, weight: 1.0 },
  { filter: { term: { hasActiveGrants: true } }, weight: 0.5 },
];

describe("people-index prominence factor — issue #513 / §5.4", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  for (const shape of ["name", "department", "hybrid"] as const) {
    it(`${shape} shape under v3 wraps the body in the additive prominence function_score`, async () => {
      const q = shape === "hybrid" ? "cantley ras" : shape === "name" ? "cantley" : "cardiology";
      await searchPeople({ q, relevanceMode: "v3", shape });

      const fs = functionScore(capturedBodies[0]);
      expect(fs).toBeDefined();
      expect(fs!.score_mode).toBe("sum");
      expect(fs!.boost_mode).toBe("multiply");

      // All four prominence functions present, none extra.
      expect(fs!.functions).toHaveLength(EXPECTED_PROMINENCE_FUNCTIONS.length);
      for (const fn of EXPECTED_PROMINENCE_FUNCTIONS) {
        expect(fs!.functions).toContainEqual(fn);
      }

      // The wrapped query is still the template body (bool), not lost.
      expect(fs!.query).toHaveProperty("bool");
    });
  }

  it("publication count leads via a log-saturated field_value_factor (ln1p)", async () => {
    await searchPeople({ q: "cantley", relevanceMode: "v3", shape: "name" });
    const fns = functionScore(capturedBodies[0])!.functions;
    expect(fns).toContainEqual({
      field_value_factor: {
        field: "publicationCount",
        modifier: "ln1p",
        factor: 1,
        missing: 0,
      },
    });
    // Faculty / active-grant are additive weights, not standalone multipliers.
    expect(fns).toContainEqual({
      filter: { term: { personType: "full_time_faculty" } },
      weight: 1.0,
    });
    expect(fns).toContainEqual({
      filter: { term: { hasActiveGrants: true } },
      weight: 0.5,
    });
  });

  it("topic shape is nested: outer additive prominence wraps inner multiply (#513 §5.4 follow-up)", async () => {
    await searchPeople({
      q: "ras signaling pancreatic cancer",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D012345"],
    });

    // Outer = prominence (additive sum, the four functions).
    const outer = functionScore(capturedBodies[0]);
    expect(outer).toBeDefined();
    expect(outer!.score_mode).toBe("sum");
    expect(outer!.boost_mode).toBe("multiply");
    expect(outer!.functions).toHaveLength(EXPECTED_PROMINENCE_FUNCTIONS.length);
    for (const fn of EXPECTED_PROMINENCE_FUNCTIONS) {
      expect(outer!.functions).toContainEqual(fn);
    }

    // Inner = the PR-3 multiplicative topic ladder, untouched.
    const inner = (outer!.query as { function_score?: FnScore }).function_score;
    expect(inner).toBeDefined();
    expect(inner!.score_mode).toBe("multiply");
    expect(inner!.boost_mode).toBe("multiply");
    // The attribution ×1.5 still rides the inner layer.
    expect(inner!.functions).toContainEqual({
      filter: { terms: { publicationMeshUi: ["D012345"] } },
      weight: 1.5,
    });
    // Innermost is the topic body bool.
    expect(inner!.query).toHaveProperty("bool");
  });

  it("legacy mode does NOT apply the prominence factor (gated on v3)", async () => {
    await searchPeople({ q: "cantley", relevanceMode: "legacy", shape: "name" });
    expect(capturedBodies[0].query).not.toHaveProperty("function_score");
    expect(capturedBodies[0].query).toHaveProperty("bool");
  });
});

describe("research-area concentration boost — Track B", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  const areaConcentration = [
    { cwid: "hi", total: 100 }, // 1.0 → hi
    { cwid: "mid", total: 30 }, // 0.3 → mid
    { cwid: "lo", total: 5 }, //  0.05 → lo
  ];

  it("topic shape appends tiered cwid clauses to the outer prominence functions", async () => {
    await searchPeople({
      q: "children's health",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D012345"],
      areaConcentration,
    });
    const fns = functionScore(capturedBodies[0])!.functions;
    expect(fns).toContainEqual({ filter: { terms: { cwid: ["hi"] } }, weight: 8 });
    expect(fns).toContainEqual({ filter: { terms: { cwid: ["mid"] } }, weight: 4 });
    expect(fns).toContainEqual({ filter: { terms: { cwid: ["lo"] } }, weight: 1.5 });
    // The four prominence functions are still present (boost is additive, not a replacement).
    for (const fn of EXPECTED_PROMINENCE_FUNCTIONS) expect(fns).toContainEqual(fn);
  });

  it("name shape does NOT apply the area boost (topic/hybrid only)", async () => {
    await searchPeople({
      q: "cantley",
      relevanceMode: "v3",
      shape: "name",
      areaConcentration,
    });
    const fns = functionScore(capturedBodies[0])!.functions;
    expect(fns.some((f) => "filter" in f && JSON.stringify(f).includes('"cwid"'))).toBe(
      false,
    );
    // Exactly the four prominence functions, nothing extra.
    expect(fns).toHaveLength(EXPECTED_PROMINENCE_FUNCTIONS.length);
  });

  it("topic shape with NO areaConcentration is unchanged (today's ranking)", async () => {
    await searchPeople({
      q: "children's health",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D012345"],
    });
    const fns = functionScore(capturedBodies[0])!.functions;
    expect(fns).toHaveLength(EXPECTED_PROMINENCE_FUNCTIONS.length);
  });
});

describe("faculty-prominence lever — #1345", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    groupByMock.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it("facultyProminence:false drops the full_time_faculty term (others intact)", async () => {
    await searchPeople({ q: "cantley", relevanceMode: "v3", shape: "name", facultyProminence: false });
    const fns = functionScore(capturedBodies[0])!.functions;
    expect(fns).not.toContainEqual({
      filter: { term: { personType: "full_time_faculty" } },
      weight: 1.0,
    });
    expect(fns).toHaveLength(EXPECTED_PROMINENCE_FUNCTIONS.length - 1);
    expect(fns).toContainEqual({ weight: 1.0 }); // BASE survives
    expect(fns).toContainEqual({ filter: { term: { hasActiveGrants: true } }, weight: 0.5 });
  });

  it("default (omitted) keeps all four prominence functions (byte-identical)", async () => {
    await searchPeople({ q: "cantley", relevanceMode: "v3", shape: "name" });
    const fns = functionScore(capturedBodies[0])!.functions;
    expect(fns).toHaveLength(EXPECTED_PROMINENCE_FUNCTIONS.length);
    for (const fn of EXPECTED_PROMINENCE_FUNCTIONS) expect(fns).toContainEqual(fn);
  });
});

describe("getConceptScholarConcentration — #1343 concept-axis source", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    conceptBuckets = [];
    totalBuckets = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("empty descendant set short-circuits to [] (no agg round-trip)", async () => {
    const out = await getConceptScholarConcentration([], 200);
    expect(out).toEqual([]);
    expect(capturedBodies).toHaveLength(0);
  });

  it("scores by concentration (n²/total), not raw on-topic count, and builds both agg bodies", async () => {
    // `a` = high-volume generalist (40 on-topic of 800 total → 40²/800 = 2),
    // `b` = niche specialist (10 on-topic of 12 total → 10²/12 ≈ 8.33).
    // Raw-count ordering would put `a` first; concentration flips it to `b`.
    conceptBuckets = [
      { key: "a", doc_count: 40 },
      { key: "b", doc_count: 10 },
    ];
    totalBuckets = [
      { key: "a", doc_count: 800 },
      { key: "b", doc_count: 12 },
    ];
    const out = await getConceptScholarConcentration(["D2", "D1"], 200);
    expect(out.map((o) => o.cwid)).toEqual(["b", "a"]);
    expect(out[0].total).toBeCloseTo(100 / 12, 5);
    expect(out[1].total).toBeCloseTo(2, 5);

    // 1st body: on-topic agg — filter on the descriptor set, terms agg capped at limit.
    const onTopic = capturedBodies[0] as {
      query: { bool: { filter: { terms: { meshDescriptorUi: string[] } }[] } };
      aggs: { byAuthor: { terms: { field: string; size: number } } };
    };
    expect(onTopic.query.bool.filter[0].terms.meshDescriptorUi).toEqual(["D2", "D1"]);
    expect(onTopic.aggs.byAuthor.terms).toEqual({ field: "wcmAuthorCwids", size: 200 });
    // 2nd body: total-pub agg — filter+include pinned to the on-topic authors.
    const total = capturedBodies[1] as {
      query: { bool: { filter: { terms: { wcmAuthorCwids: string[] } }[] } };
      aggs: { byAuthor: { terms: { field: string; size: number; include: string[] } } };
    };
    expect(total.query.bool.filter[0].terms.wcmAuthorCwids).toEqual(["a", "b"]);
    expect(total.aggs.byAuthor.terms).toEqual({
      field: "wcmAuthorCwids",
      size: 2,
      include: ["a", "b"],
    });
  });

  it("floors out authors below CONCEPT_CONCENTRATION_MIN_PUBS before the total-pub round-trip", async () => {
    conceptBuckets = [
      { key: "a", doc_count: 5 },
      { key: "tiny", doc_count: 2 }, // < 3 → ineligible, never weighted
    ];
    totalBuckets = [{ key: "a", doc_count: 10 }];
    const out = await getConceptScholarConcentration(["D1"], 200);
    expect(out.map((o) => o.cwid)).toEqual(["a"]);
    // total-pub agg only asks for the eligible author, not the floored one.
    const total = capturedBodies[1] as {
      aggs: { byAuthor: { terms: { include: string[] } } };
    };
    expect(total.aggs.byAuthor.terms.include).toEqual(["a"]);
  });

  it("all authors floored → [] and no total-pub round-trip", async () => {
    conceptBuckets = [{ key: "x", doc_count: 1 }];
    const out = await getConceptScholarConcentration(["D1"], 200);
    expect(out).toEqual([]);
    expect(capturedBodies).toHaveLength(1); // only the on-topic agg ran
  });
});
