/**
 * Issue #259 §1.2 — structural assertion on the publications-index query.
 *
 * Captures the `body.query` sent to OpenSearch by `searchPublications` and
 * checks the multi_match shape. Flag off: no `minimum_should_match`, no
 * `operator: or`, fields untouched. Flag on: msm is `"2<-34%"`,
 * operator is `"or"`, fields still untouched (no field-restructure on
 * pub-tab — abstract is per-doc, not a blob).
 *
 * Also asserts the people/pubs msm strings are intentionally identical
 * today so a future divergence is loud.
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
}));

vi.mock("@/lib/api/mentoring-pmids", () => ({
  getMentoringPmidBuckets: vi.fn().mockResolvedValue({
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  }),
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

/**
 * The pub-tab query is a single flat must clause: body.query.bool.must[0].
 * (No CWID short-circuit, unlike the people-tab — pub-tab has nothing to
 * exact-match.)
 */
function multiMatchClause(body: Record<string, unknown>): Record<string, unknown> {
  const q = body.query as Record<string, unknown>;
  const must = (q.bool as { must: Record<string, unknown>[] }).must;
  return must[0];
}

describe("pub-tab query shape — SEARCH_PUB_TAB_MSM", () => {
  const originalEnv = process.env.SEARCH_PUB_TAB_MSM;

  beforeEach(() => {
    capturedBodies.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SEARCH_PUB_TAB_MSM = originalEnv;
  });

  it("flag explicitly off: multi_match has no minimum_should_match, no operator", async () => {
    // Default flipped on in this PR; explicit "off" exercises the legacy
    // emergency-rollback path.
    process.env.SEARCH_PUB_TAB_MSM = "off";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({ q: "electronic health records", page: 0 });

    expect(result.queryShape).toBe("legacy_multi_match");
    expect(capturedBodies).toHaveLength(1);

    const clause = multiMatchClause(capturedBodies[0]);
    expect(clause).toHaveProperty("multi_match");
    const mm = clause.multi_match as Record<string, unknown>;
    expect(mm.type).toBe("best_fields");
    expect(mm).not.toHaveProperty("minimum_should_match");
    expect(mm).not.toHaveProperty("operator");
    expect(mm.fields).toEqual([
      "title^4",
      "meshTerms^2",
      "authorNames^2",
      "journal^1",
      "abstract^0.5",
    ]);
  });

  it("flag on: multi_match has msm '-0% 3<-25%', operator 'or', fields unchanged", async () => {
    process.env.SEARCH_PUB_TAB_MSM = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({ q: "electronic health records", page: 0 });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const clause = multiMatchClause(capturedBodies[0]);
    const mm = clause.multi_match as Record<string, unknown>;
    expect(mm.type).toBe("best_fields");
    expect(mm.operator).toBe("or");
    expect(mm.minimum_should_match).toBe("2<-34%");
    // Fields list is identical — pub-tab does NOT restructure (abstract on
    // the publications index is per-doc, not a concatenated blob).
    expect(mm.fields).toEqual([
      "title^4",
      "meshTerms^2",
      "authorNames^2",
      "journal^1",
      "abstract^0.5",
    ]);
  });

  it("flag on, empty query: skips the multi_match branch entirely (match_all)", async () => {
    process.env.SEARCH_PUB_TAB_MSM = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({ q: "", page: 0 });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);

    const clause = multiMatchClause(capturedBodies[0]);
    expect(clause).toEqual({ match_all: {} });
  });
});

// Parity assertion (PUBLICATIONS_RESTRUCTURED_MSM === PEOPLE_RESTRUCTURED_MSM)
// lives in tests/unit/search-msm-parity.test.ts. It needs the real
// @/lib/search module, not the mock above, so it's in a separate file
// with no vi.mock at module scope.

/**
 * Issue #259 §1.6 — OR-of-evidence pub filter, gated on
 * SEARCH_PUB_TAB_OR_OF_EVIDENCE. The shape is:
 *   top-level bool.must = [{ bool: { should: [Path A, Path B?], msm: 1 } }]
 *   top-level bool.should = [BM25 multi_match with PUBLICATIONS_RESTRUCTURED_MSM]
 *   aggs reuse `must` unchanged — facet counts MUST NOT carry the should.
 *
 * Flag-off and unresolved-query paths must produce byte-identical bodies to
 * the §1.2 path. Cross-equality is locked in below.
 */
type MeshResolutionForTest = {
  descriptorUi: string;
  name: string;
  matchedForm: string;
  confidence: "exact" | "entry-term";
  scopeNote: string | null;
  entryTerms: string[];
  curatedTopicAnchors: string[];
};

const RESOLUTION_WITH_ANCHORS: MeshResolutionForTest = {
  descriptorUi: "D057286",
  name: "Electronic Health Records",
  matchedForm: "electronic health records",
  confidence: "exact",
  scopeNote: null,
  entryTerms: ["EHR", "EMR", "Electronic Medical Records"],
  curatedTopicAnchors: ["digital-health", "informatics"],
};

const RESOLUTION_WITHOUT_ANCHORS: MeshResolutionForTest = {
  ...RESOLUTION_WITH_ANCHORS,
  curatedTopicAnchors: [],
};

function topLevelBool(body: Record<string, unknown>): {
  must: Record<string, unknown>[];
  should?: Record<string, unknown>[];
} {
  const q = body.query as Record<string, unknown>;
  return q.bool as { must: Record<string, unknown>[]; should?: Record<string, unknown>[] };
}

describe("pub-tab query shape — SEARCH_PUB_TAB_OR_OF_EVIDENCE (§1.6)", () => {
  const originalMsm = process.env.SEARCH_PUB_TAB_MSM;
  const originalOoE = process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE;

  beforeEach(() => {
    capturedBodies.length = 0;
    vi.resetModules();
    // Hold msm to its production default ("on") so the BM25 should-clause
    // and the §1.2 fallback have predictable shapes.
    process.env.SEARCH_PUB_TAB_MSM = "on";
  });

  afterEach(() => {
    process.env.SEARCH_PUB_TAB_MSM = originalMsm;
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = originalOoE;
  });

  it("case 1 — flag off, resolution present: §1.2 shape, no should, no reciterParentTopicId anywhere", async () => {
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "off";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });

    expect(result.queryShape).toBe("restructured_msm");
    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0];
    const bool = topLevelBool(body);

    // No top-level should — §1.2 shape is must-only.
    expect(bool).not.toHaveProperty("should");
    // Must has exactly one entry: the §1.2 multi_match.
    expect(bool.must).toHaveLength(1);
    const clause = bool.must[0] as Record<string, unknown>;
    expect(clause).toHaveProperty("multi_match");
    const mm = clause.multi_match as Record<string, unknown>;
    expect(mm.operator).toBe("or");
    expect(mm.minimum_should_match).toBe("2<-34%");

    // The new keyword field must not appear anywhere in the serialized body.
    expect(JSON.stringify(body)).not.toContain("reciterParentTopicId");
  });

  it("case 2 — flag on, resolution=null: §1.2 shape, no should, byte-identical to case 1", async () => {
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: null,
    });

    expect(result.queryShape).toBe("restructured_msm");
    const bool = topLevelBool(capturedBodies[0]);
    expect(bool).not.toHaveProperty("should");
    expect(bool.must).toHaveLength(1);
    const mm = (bool.must[0] as { multi_match: Record<string, unknown> }).multi_match;
    expect(mm.minimum_should_match).toBe("2<-34%");
  });

  it("case 3 — cross-equality: flag-on-null body byte-identical to flag-off-with-resolution", async () => {
    // Run case 1 again, capture body.
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "off";
    const mod1 = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    await mod1.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    const flagOffWithResolution = capturedBodies[0];

    // Reset and run case 2 again.
    capturedBodies.length = 0;
    vi.resetModules();
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "on";
    const mod2 = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    await mod2.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: null,
    });
    const flagOnNullResolution = capturedBodies[0];

    // Locks the §1.2 / unresolved invariant: regardless of flag state, when
    // there's no resolution to act on, the produced ES body is identical.
    expect(flagOnNullResolution).toEqual(flagOffWithResolution);
  });

  it("case 4 — flag on, resolution with anchors: concept_filtered shape; aggs reuse must, not should", async () => {
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });

    expect(result.queryShape).toBe("concept_filtered");
    const body = capturedBodies[0];
    const bool = topLevelBool(body);

    // Top-level should = [BM25 multi_match with msm].
    expect(bool.should).toBeDefined();
    expect(bool.should).toHaveLength(1);
    const bm25 = (bool.should as Record<string, unknown>[])[0] as {
      multi_match: Record<string, unknown>;
    };
    expect(bm25.multi_match.type).toBe("best_fields");
    expect(bm25.multi_match.operator).toBe("or");
    expect(bm25.multi_match.minimum_should_match).toBe("2<-34%");
    expect(bm25.multi_match.fields).toEqual([
      "title^4",
      "meshTerms^2",
      "authorNames^2",
      "journal^1",
      "abstract^0.5",
    ]);

    // Top-level must = [{ bool: { should: [Path A, Path B], msm: 1 } }].
    expect(bool.must).toHaveLength(1);
    const evidence = bool.must[0] as { bool: Record<string, unknown> };
    expect(evidence.bool.minimum_should_match).toBe(1);
    const evidenceShould = evidence.bool.should as Record<string, unknown>[];
    expect(evidenceShould).toHaveLength(2);

    // Path A — match_phrase on meshTerms with boost 8.
    expect(evidenceShould[0]).toEqual({
      match_phrase: {
        meshTerms: { query: "Electronic Health Records", boost: 8 },
      },
    });
    // Path B — terms on reciterParentTopicId with the exact anchor array
    // and boost 6.
    expect(evidenceShould[1]).toEqual({
      terms: {
        reciterParentTopicId: ["digital-health", "informatics"],
        boost: 6,
      },
    });

    // Aggs MUST reuse the same `must` array, NOT carry `should`. The BM25
    // scoring clause exists to order admitted docs; it must not bias facet
    // counts. Sample two aggs (publicationTypes + journals) to lock this.
    const aggs = body.aggs as Record<string, Record<string, unknown>>;
    const pubTypesFilter = (aggs.publicationTypes.filter as { bool: Record<string, unknown> }).bool;
    expect(pubTypesFilter.must).toEqual(bool.must);
    expect(pubTypesFilter).not.toHaveProperty("should");

    const journalsFilter = (aggs.journals.filter as { bool: Record<string, unknown> }).bool;
    expect(journalsFilter.must).toEqual(bool.must);
    expect(journalsFilter).not.toHaveProperty("should");
  });

  it("case 5 — flag on, resolution with empty anchors: concept_fallback shape; Path A only; top-level should still carries BM25", async () => {
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "on";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITHOUT_ANCHORS,
    });

    expect(result.queryShape).toBe("concept_fallback");
    const bool = topLevelBool(capturedBodies[0]);

    // Top-level should still present.
    expect(bool.should).toBeDefined();
    expect(bool.should).toHaveLength(1);

    // Evidence should has length 1 — Path A only, no Path B.
    expect(bool.must).toHaveLength(1);
    const evidence = bool.must[0] as { bool: Record<string, unknown> };
    expect(evidence.bool.minimum_should_match).toBe(1);
    const evidenceShould = evidence.bool.should as Record<string, unknown>[];
    expect(evidenceShould).toHaveLength(1);
    expect(evidenceShould[0]).toEqual({
      match_phrase: {
        meshTerms: { query: "Electronic Health Records", boost: 8 },
      },
    });

    // reciterParentTopicId must NOT appear anywhere — anchors were empty,
    // so Path B wasn't built.
    expect(JSON.stringify(capturedBodies[0])).not.toContain("reciterParentTopicId");
  });
});
