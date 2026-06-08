/**
 * Issue #645 — recency-weighted Relevance on the publications tab.
 *
 * Captures the `body.query` sent to OpenSearch by `searchPublications` and
 * asserts the `function_score` Gaussian-decay wrapper applied on the relevance
 * path. See `docs/search-recency-relevance-spec.md` §5/§8/§10.
 *
 *   - off    → no wrapper (rollback / byte-identical target).
 *   - gentle → bounded-additive `1 + 2·gauss(year)`, ceiling 3×, gauss gated by
 *              an `exists: year` filter so missing-year docs stay at 1× (E1).
 *   - strong → pure multiplicative `gauss(year)`, no floor.
 *   - explicit sort / countOnly → unwrapped (E3 / E6).
 *   - concept_expanded → wrapper around the whole admission bool (E4).
 *
 * Mirrors the capture-the-body harness in `search-pub-query-shape.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    scholar: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn().mockResolvedValue(new Map()),
  fetchAuthorBylineForPmids: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/api/mentoring-pmids", () => ({
  getMentoringPmidBuckets: vi.fn().mockResolvedValue({
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  }),
  // countOnly path reads this synchronously instead of the async buckets.
  EMPTY_MENTORING_BUCKETS: {
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  },
}));

const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PUBLICATION_FIELD_BOOSTS: [
    "title^4",
    "meshTerms^2",
    "authorNames^2",
    "journal^1",
    "abstract^0.5",
  ],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      return {
        body: {
          hits: { total: { value: 0 }, hits: [] },
          aggregations: {
            publicationTypes: { keys: { buckets: [] } },
            journals: { keys: { buckets: [] } },
            wcmRoleFirst: { doc_count: 0 },
            wcmRoleSenior: { doc_count: 0 },
            wcmRoleMiddle: { doc_count: 0 },
            wcmAuthors: { keys: { buckets: [] }, total: { value: 0 } },
            mentoringPrograms: {
              buckets: {
                md: { doc_count: 0 },
                mdphd: { doc_count: 0 },
                phd: { doc_count: 0 },
                postdoc: { doc_count: 0 },
                ecr: { doc_count: 0 },
              },
            },
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

type Body = Record<string, unknown>;
type Query = Record<string, unknown>;

function topQuery(body: Body): Query {
  return body.query as Query;
}

function functionScore(body: Body): Record<string, unknown> {
  const q = topQuery(body);
  expect(q).toHaveProperty("function_score");
  return q.function_score as Record<string, unknown>;
}

type GaussParams = { origin: number; offset: number; scale: number; decay: number };

/** Re-implements the OpenSearch gauss decay from the *emitted* params so the
 *  calibration assertion (T9) is tied to the real constants in code. */
function gauss(p: GaussParams, year: number): number {
  const d = Math.max(0, Math.abs(p.origin - year) - p.offset);
  const sigmaSq = -(p.scale * p.scale) / (2 * Math.log(p.decay));
  return Math.exp(-(d * d) / (2 * sigmaSq));
}

type MeshResolutionForTest = {
  descriptorUi: string;
  name: string;
  matchedForm: string;
  confidence: "exact" | "entry-term";
  scopeNote: string | null;
  entryTerms: string[];
  curatedTopicAnchors: string[];
  descendantUis: string[];
};

const RESOLUTION_WITH_ANCHORS: MeshResolutionForTest = {
  descriptorUi: "D057286",
  name: "Electronic Health Records",
  matchedForm: "electronic health records",
  confidence: "exact",
  scopeNote: null,
  entryTerms: ["EHR", "EMR", "Electronic Medical Records"],
  curatedTopicAnchors: ["digital-health", "informatics"],
  descendantUis: ["D057286", "D000077863"],
};

async function importSearch() {
  return (await import("@/lib/api/search")) as {
    searchPublications: (opts: unknown) => Promise<{ queryShape: string; recencyMode: string; recencyOriginYear: number | null }>;
    resolvePubRecencyMode?: unknown;
  };
}

describe("pub-tab recency tilt — SEARCH_PUB_RELEVANCE_RECENCY (#645)", () => {
  const originalRecency = process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  const originalConcept = process.env.SEARCH_PUB_TAB_CONCEPT_MODE;

  beforeEach(() => {
    capturedBodies.length = 0;
    vi.resetModules();
    delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
  });

  afterEach(() => {
    if (originalRecency === undefined) delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
    else process.env.SEARCH_PUB_RELEVANCE_RECENCY = originalRecency;
    if (originalConcept === undefined) delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
    else process.env.SEARCH_PUB_TAB_CONCEPT_MODE = originalConcept;
  });

  // T1 — off: no wrapper (rollback / byte-identical target).
  it("off: relevance path is the plain bool, no function_score", async () => {
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
    const { searchPublications } = await importSearch();
    const result = await searchPublications({ q: "cancer", page: 0, nowYear: 2026 });

    expect(topQuery(capturedBodies[0])).toHaveProperty("bool");
    expect(topQuery(capturedBodies[0])).not.toHaveProperty("function_score");
    expect(result.recencyMode).toBe("off");
    expect(result.recencyOriginYear).toBeNull();
  });

  // T2 — gentle (default): bounded-additive sum, gauss params, inner bool intact.
  it("gentle (default): function_score sum of {floor 1} + {gauss exists:year, weight 2}", async () => {
    // unset → default gentle
    delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
    const { searchPublications } = await importSearch();
    const result = await searchPublications({ q: "cancer", page: 0, nowYear: 2026 });

    expect(result.recencyMode).toBe("gentle");
    expect(result.recencyOriginYear).toBe(2026);

    const fs = functionScore(capturedBodies[0]);
    expect(fs.score_mode).toBe("sum");
    expect(fs.boost_mode).toBe("multiply");

    const funcs = fs.functions as Array<Record<string, unknown>>;
    expect(funcs).toHaveLength(2);
    // constant floor → multiplier never < 1×
    expect(funcs[0]).toEqual({ weight: 1 });
    // gauss term, weight 2, gated by exists:year (E1)
    expect(funcs[1].weight).toBe(2);
    expect(funcs[1].filter).toEqual({ exists: { field: "year" } });
    expect(funcs[1].gauss).toEqual({
      year: { origin: 2026, offset: 2, scale: 8, decay: 0.5 },
    });

    // inner query is the un-wrapped admission bool (§1.2 multi_match path)
    const inner = (fs.query as Query).bool as { must: Record<string, unknown>[] };
    expect(inner.must[0]).toHaveProperty("multi_match");
  });

  // T3 — strong: pure multiplicative gauss, no floor.
  it("strong: function_score with a single filtered gauss, no constant floor", async () => {
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "strong";
    const { searchPublications } = await importSearch();
    const result = await searchPublications({ q: "cancer", page: 0, nowYear: 2026 });

    expect(result.recencyMode).toBe("strong");
    const fs = functionScore(capturedBodies[0]);
    expect(fs.boost_mode).toBe("multiply");
    const funcs = fs.functions as Array<Record<string, unknown>>;
    expect(funcs).toHaveLength(1);
    // no `{ weight: 1 }` floor function
    expect(funcs.some((f) => Object.keys(f).length === 1 && f.weight === 1)).toBe(false);
    expect(funcs[0].filter).toEqual({ exists: { field: "year" } });
    expect(funcs[0].gauss).toEqual({
      year: { origin: 2026, offset: 2, scale: 8, decay: 0.5 },
    });
  });

  // T4 — explicit sort overrides _score → no wrapper (E3).
  it("explicit sort=year: no function_score, sort clause present", async () => {
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "gentle";
    const { searchPublications } = await importSearch();
    const result = await searchPublications({ q: "cancer", page: 0, sort: "year", nowYear: 2026 });

    expect(topQuery(capturedBodies[0])).toHaveProperty("bool");
    expect(topQuery(capturedBodies[0])).not.toHaveProperty("function_score");
    expect(capturedBodies[0].sort).toEqual([{ year: "desc" }]);
    // resolved-but-not-applied
    expect(result.recencyMode).toBe("gentle");
    expect(result.recencyOriginYear).toBeNull();
  });

  // T5 — countOnly badge path uses the unwrapped query (E6).
  it("countOnly: count body uses the unwrapped bool", async () => {
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "gentle";
    const { searchPublications } = await importSearch();
    const result = await searchPublications({ q: "cancer", page: 0, countOnly: true, nowYear: 2026 });

    expect(capturedBodies[0].size).toBe(0);
    expect(topQuery(capturedBodies[0])).toHaveProperty("bool");
    expect(topQuery(capturedBodies[0])).not.toHaveProperty("function_score");
    expect(result.recencyOriginYear).toBeNull();
  });

  // T6 — concept_expanded: wrapper around the whole admission bool (E4).
  it("concept_expanded: function_score wraps the should+msm:1 admission bool", async () => {
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "gentle";
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    const { searchPublications } = await importSearch();
    const result = await searchPublications({
      q: "EHR",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
      nowYear: 2026,
    });

    expect(result.queryShape).toBe("concept_expanded");
    const fs = functionScore(capturedBodies[0]);
    const innerBool = (fs.query as Query).bool as {
      should: unknown[];
      minimum_should_match: number;
      must?: unknown;
    };
    // admission preserved under the wrapper: 4-clause should + msm:1, no must
    expect(innerBool).not.toHaveProperty("must");
    expect(innerBool.minimum_should_match).toBe(1);
    expect(innerBool.should).toHaveLength(4);
  });

  // T7 — missing-year is handled by the exists filter, not OpenSearch's
  // neutral 1.0 (which under `sum` would read as max freshness). E1.
  it("gentle: gauss is gated by exists:year so missing-year falls to the floor", async () => {
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "gentle";
    const { searchPublications } = await importSearch();
    await searchPublications({ q: "cancer", page: 0, nowYear: 2026 });

    const funcs = functionScore(capturedBodies[0]).functions as Array<Record<string, unknown>>;
    const gaussFn = funcs.find((f) => "gauss" in f)!;
    expect(gaussFn.filter).toEqual({ exists: { field: "year" } });
  });

  // T9 — calibration: the emitted constants yield ≈3:1 current-vs-2001 (§5.4).
  it("calibration: emitted gauss gives M(2024)/M(2001) ≈ 3:1", async () => {
    delete process.env.SEARCH_PUB_RELEVANCE_RECENCY; // gentle
    const { searchPublications } = await importSearch();
    await searchPublications({ q: "cancer", page: 0, nowYear: 2026 });

    const funcs = functionScore(capturedBodies[0]).functions as Array<Record<string, unknown>>;
    const floorW = funcs[0].weight as number; // 1
    const gaussFn = funcs.find((f) => "gauss" in f)!;
    const gw = gaussFn.weight as number; // 2
    const params = (gaussFn.gauss as { year: GaussParams }).year;

    const M = (year: number) => floorW + gw * gauss(params, year);

    expect(M(2024)).toBeCloseTo(3, 1); // freshest → 3×
    expect(M(2024) / M(2001)).toBeCloseTo(3, 1); // ≈ 3 : 1
    // bounded: old papers floored at 1×, never penalized below BM25
    expect(M(1999)).toBeGreaterThanOrEqual(1);
    expect(M(1999)).toBeLessThan(1.1);
  });
});

// T8 — resolver parsing (kept apart so the env-mutating cases don't fight the
// capture suite's resetModules).
describe("resolvePubRecencyMode parsing (#645)", () => {
  const original = process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
    else process.env.SEARCH_PUB_RELEVANCE_RECENCY = original;
  });

  it("maps off/gentle/strong verbatim; unset and garbage → gentle", async () => {
    const { resolvePubRecencyMode } = await import("@/lib/api/search-flags");

    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
    expect(resolvePubRecencyMode()).toBe("off");
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "gentle";
    expect(resolvePubRecencyMode()).toBe("gentle");
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "strong";
    expect(resolvePubRecencyMode()).toBe("strong");
    process.env.SEARCH_PUB_RELEVANCE_RECENCY = "banana";
    expect(resolvePubRecencyMode()).toBe("gentle");
    delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
    expect(resolvePubRecencyMode()).toBe("gentle");
  });
});
