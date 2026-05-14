/**
 * Issue #259 §1.8 — pub-tab sort clauses + per-hit `impactScore` /
 * `conceptImpactScore` mapping in `searchPublications`. Gated on
 * `SEARCH_PUB_TAB_IMPACT`.
 *
 * What this exercises:
 *   - Sort clause for `impact` is `[{ impactScore: desc }, { pmid: asc }]`
 *     (impactScore desc with a stable tiebreak for pagination).
 *   - Sort clause for `recency` is `[{ year: desc }, { dateAddedToEntrez:
 *     desc }]` per spec §1.8.
 *   - Flag off + sort=impact/recency falls through to no sort clause
 *     (relevance) so a hand-crafted URL doesn't 500.
 *   - Legacy `year` and `citations` sort values keep working under either
 *     flag state (back-compat for saved URLs / cross-deploy window).
 *   - Per-hit `impactScore` and `conceptImpactScore` map from `_source`
 *     (flag on) and are forced to null (flag off).
 *   - `conceptImpactScore` is the MAX of `topicImpacts[].impactScore`
 *     restricted to `meshResolution.curatedTopicAnchors`. Null when no
 *     resolution / no anchors / no matching rows / all matching nulls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    scholar: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/api/mentoring-pmids", () => ({
  getMentoringPmidBuckets: vi.fn().mockResolvedValue({
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  }),
}));

// Body capture + injectable response hits. Each test resets `nextHits` to
// the fixture it wants returned from OpenSearch; the search-index module
// reads them via `r.hits.hits` in the hit-mapping path.
const capturedBodies: Array<Record<string, unknown>> = [];
let nextHits: Array<{ _source: Record<string, unknown> }> = [];

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
          hits: { total: { value: nextHits.length }, hits: nextHits },
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

type MeshResolutionForTest = {
  descriptorUi: string;
  name: string;
  matchedForm: string;
  confidence: "exact" | "entry-term";
  scopeNote: string | null;
  entryTerms: string[];
  curatedTopicAnchors: string[];
};

const RESOLUTION: MeshResolutionForTest = {
  descriptorUi: "D057286",
  name: "Electronic Health Records",
  matchedForm: "electronic health records",
  confidence: "exact",
  scopeNote: null,
  entryTerms: ["EHR"],
  curatedTopicAnchors: ["digital-health", "informatics"],
};

function sortOf(body: Record<string, unknown>): unknown {
  return body.sort;
}

describe("searchPublications sort clauses — SEARCH_PUB_TAB_IMPACT (§1.8)", () => {
  const originalImpact = process.env.SEARCH_PUB_TAB_IMPACT;
  const originalMsm = process.env.SEARCH_PUB_TAB_MSM;

  beforeEach(() => {
    capturedBodies.length = 0;
    nextHits = [];
    vi.resetModules();
    // Hold msm to production default so the produced query shape is stable;
    // §1.8 sort logic doesn't depend on it but the body would differ.
    process.env.SEARCH_PUB_TAB_MSM = "on";
  });

  afterEach(() => {
    process.env.SEARCH_PUB_TAB_IMPACT = originalImpact;
    process.env.SEARCH_PUB_TAB_MSM = originalMsm;
  });

  it("flag on + sort=impact → [impactScore desc, pmid asc] for stable paging", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<unknown>;
    };
    await mod.searchPublications({ q: "cancer", page: 0, sort: "impact" });
    expect(sortOf(capturedBodies[0])).toEqual([
      { impactScore: "desc" },
      { pmid: "asc" },
    ]);
  });

  it("flag on + sort=recency → [year desc, dateAddedToEntrez desc] per spec", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<unknown>;
    };
    await mod.searchPublications({ q: "cancer", page: 0, sort: "recency" });
    expect(sortOf(capturedBodies[0])).toEqual([
      { year: "desc" },
      { dateAddedToEntrez: "desc" },
    ]);
  });

  it("flag off + sort=impact → falls through to relevance (no sort clause)", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "off";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<unknown>;
    };
    await mod.searchPublications({ q: "cancer", page: 0, sort: "impact" });
    // No `sort` key on the body when no clause; OpenSearch defaults to _score.
    expect(capturedBodies[0]).not.toHaveProperty("sort");
  });

  it("legacy sort=year still emits { year: desc } regardless of flag state", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<unknown>;
    };
    await mod.searchPublications({ q: "cancer", page: 0, sort: "year" });
    expect(sortOf(capturedBodies[0])).toEqual([{ year: "desc" }]);
  });

  it("legacy sort=citations still emits { citationCount: desc }", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "off";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<unknown>;
    };
    await mod.searchPublications({ q: "cancer", page: 0, sort: "citations" });
    expect(sortOf(capturedBodies[0])).toEqual([{ citationCount: "desc" }]);
  });
});

/* ============================================================
 * Per-hit `impactScore` and `conceptImpactScore` mapping.
 *
 * Fixture pub topic-impacts (mirrors what §1.8 ETL writes to `_source`):
 *
 *   pmid 1 — broad pub, two topics, one anchored
 *     impactScore = 78  (doc-level MAX)
 *     topicImpacts = [
 *       { parentTopicId: "digital-health", impactScore: 78 },  // anchored
 *       { parentTopicId: "policy",         impactScore: 33 },
 *     ]
 *
 *   pmid 2 — only non-anchored topic
 *     impactScore = 50
 *     topicImpacts = [{ parentTopicId: "policy", impactScore: 50 }]
 *
 *   pmid 3 — no topic rows at all (fields omitted from _source)
 * ============================================================ */

function makeHit(pmid: string, extra: Record<string, unknown> = {}) {
  return {
    _source: {
      pmid,
      title: `pub ${pmid}`,
      journal: "J",
      year: 2024,
      publicationType: "Journal Article",
      citationCount: 0,
      doi: null,
      pmcid: null,
      pubmedUrl: null,
      ...extra,
    },
  };
}

describe("searchPublications hit mapping — §1.8 impactScore / conceptImpactScore", () => {
  const originalImpact = process.env.SEARCH_PUB_TAB_IMPACT;
  const originalMsm = process.env.SEARCH_PUB_TAB_MSM;

  beforeEach(() => {
    capturedBodies.length = 0;
    nextHits = [];
    vi.resetModules();
    process.env.SEARCH_PUB_TAB_MSM = "on";
  });

  afterEach(() => {
    process.env.SEARCH_PUB_TAB_IMPACT = originalImpact;
    process.env.SEARCH_PUB_TAB_MSM = originalMsm;
  });

  it("flag off → both fields null on every hit, even when _source carries them", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "off";
    nextHits = [
      makeHit("1", {
        impactScore: 78,
        topicImpacts: [{ parentTopicId: "digital-health", impactScore: 78 }],
      }),
    ];
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        hits: Array<{ impactScore: number | null; conceptImpactScore: number | null }>;
      }>;
    };
    const result = await mod.searchPublications({
      q: "ehr",
      page: 0,
      meshResolution: RESOLUTION,
    });
    expect(result.hits[0].impactScore).toBeNull();
    expect(result.hits[0].conceptImpactScore).toBeNull();
  });

  it("flag on, no resolution → impactScore from _source, conceptImpactScore null", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    nextHits = [
      makeHit("1", {
        impactScore: 78,
        topicImpacts: [{ parentTopicId: "digital-health", impactScore: 78 }],
      }),
    ];
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        hits: Array<{ impactScore: number | null; conceptImpactScore: number | null }>;
      }>;
    };
    const result = await mod.searchPublications({ q: "ehr", page: 0, meshResolution: null });
    expect(result.hits[0].impactScore).toBe(78);
    expect(result.hits[0].conceptImpactScore).toBeNull();
  });

  it("flag on + resolution anchored, hit has matching topic → conceptImpactScore = MAX over anchored", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    nextHits = [
      makeHit("1", {
        impactScore: 78,
        topicImpacts: [
          { parentTopicId: "digital-health", impactScore: 78 },
          { parentTopicId: "policy", impactScore: 33 },
        ],
      }),
    ];
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        hits: Array<{ impactScore: number | null; conceptImpactScore: number | null }>;
      }>;
    };
    const result = await mod.searchPublications({
      q: "ehr",
      page: 0,
      meshResolution: RESOLUTION,
    });
    // digital-health is one of RESOLUTION.curatedTopicAnchors; max over
    // matching rows is 78. impactScore (doc-level) remains 78.
    expect(result.hits[0].impactScore).toBe(78);
    expect(result.hits[0].conceptImpactScore).toBe(78);
  });

  it("flag on + resolution, hit has no matching topic → impactScore set, conceptImpactScore null", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    nextHits = [
      makeHit("2", {
        impactScore: 50,
        topicImpacts: [{ parentTopicId: "policy", impactScore: 50 }],
      }),
    ];
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        hits: Array<{ impactScore: number | null; conceptImpactScore: number | null }>;
      }>;
    };
    const result = await mod.searchPublications({
      q: "ehr",
      page: 0,
      meshResolution: RESOLUTION,
    });
    expect(result.hits[0].impactScore).toBe(50);
    expect(result.hits[0].conceptImpactScore).toBeNull();
  });

  it("flag on + resolution without anchors → conceptImpactScore null even if topicImpacts present", async () => {
    // Spec §1.4: a resolved descriptor may have zero curated anchors.
    // §1.8 must not synthesize a "Concept impact" badge in that case.
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    nextHits = [
      makeHit("1", {
        impactScore: 78,
        topicImpacts: [{ parentTopicId: "digital-health", impactScore: 78 }],
      }),
    ];
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        hits: Array<{ impactScore: number | null; conceptImpactScore: number | null }>;
      }>;
    };
    const result = await mod.searchPublications({
      q: "ehr",
      page: 0,
      meshResolution: { ...RESOLUTION, curatedTopicAnchors: [] },
    });
    expect(result.hits[0].impactScore).toBe(78);
    expect(result.hits[0].conceptImpactScore).toBeNull();
  });

  it("flag on, hit with no topic data → both fields null (OMIT-on-empty source contract)", async () => {
    process.env.SEARCH_PUB_TAB_IMPACT = "on";
    nextHits = [makeHit("3")]; // no impactScore / topicImpacts in _source
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        hits: Array<{ impactScore: number | null; conceptImpactScore: number | null }>;
      }>;
    };
    const result = await mod.searchPublications({
      q: "ehr",
      page: 0,
      meshResolution: RESOLUTION,
    });
    expect(result.hits[0].impactScore).toBeNull();
    expect(result.hits[0].conceptImpactScore).toBeNull();
  });
});
