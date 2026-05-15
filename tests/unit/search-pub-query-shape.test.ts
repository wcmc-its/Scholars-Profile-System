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
 * Issue #259 §5 — concept-mode admission shapes. The §1.6 describe block
 * that previously lived here tested `SEARCH_PUB_TAB_OR_OF_EVIDENCE`, which
 * was retired in commit d875b3e ("retire issue #259 transitional flags").
 * Same admission behaviors are now covered by the `SEARCH_PUB_TAB_CONCEPT_MODE`
 * cases below (strict mode = the old OR_OF_EVIDENCE=on shape).
 */
type MeshResolutionForTest = {
  descriptorUi: string;
  name: string;
  matchedForm: string;
  confidence: "exact" | "entry-term";
  scopeNote: string | null;
  entryTerms: string[];
  curatedTopicAnchors: string[];
  /** Issue #259 §5.4.2 / PR 2 — self at index 0, then descendants. */
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

const RESOLUTION_WITHOUT_ANCHORS: MeshResolutionForTest = {
  ...RESOLUTION_WITH_ANCHORS,
  curatedTopicAnchors: [],
};

const RESOLUTION_EMPTY_DESCENDANTS: MeshResolutionForTest = {
  ...RESOLUTION_WITH_ANCHORS,
  descendantUis: [],
};

function topLevelBool(body: Record<string, unknown>): {
  must: Record<string, unknown>[];
  should?: Record<string, unknown>[];
} {
  const q = body.query as Record<string, unknown>;
  return q.bool as { must: Record<string, unknown>[]; should?: Record<string, unknown>[] };
}

/**
 * Issue #259 SPEC §5 — `SEARCH_PUB_TAB_CONCEPT_MODE` query-shape cases.
 *
 *   `strict`   (default at PR-3 merge) — body byte-identical to today's
 *              `concept_filtered` / `concept_fallback` / §1.2 paths.
 *   `expanded` — §5.2 four-clause body when resolution+descendants present.
 *   `off`      — §1.2 path even when resolution is present (resolution is
 *              logged but not applied).
 *
 * §6.2 — `meshStrict` opt-in forces strict-mode admission under flag=expanded.
 */
describe("pub-tab query shape — SEARCH_PUB_TAB_CONCEPT_MODE (§5)", () => {
  const originalMsm = process.env.SEARCH_PUB_TAB_MSM;
  const originalNew = process.env.SEARCH_PUB_TAB_CONCEPT_MODE;

  beforeEach(() => {
    capturedBodies.length = 0;
    vi.resetModules();
    process.env.SEARCH_PUB_TAB_MSM = "on";
    delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
  });

  afterEach(() => {
    process.env.SEARCH_PUB_TAB_MSM = originalMsm;
    if (originalNew === undefined) delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
    else process.env.SEARCH_PUB_TAB_CONCEPT_MODE = originalNew;
  });

  it("case 1 — strict, resolution=null: §1.2 shape, no top-level should", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "strict";
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
    expect(bool).not.toHaveProperty("minimum_should_match");
    expect(bool.must).toHaveLength(1);
  });

  it("case 2 — strict, resolution with anchors: concept_filtered shape with Path A + Path B", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "strict";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    expect(result.queryShape).toBe("concept_filtered");
    const bool = topLevelBool(capturedBodies[0]);

    // Top-level should = [BM25 multi_match with msm].
    expect(bool.should).toBeDefined();
    expect(bool.should).toHaveLength(1);

    // Top-level must = [{ bool: { should: [Path A, Path B], msm: 1 } }].
    expect(bool.must).toHaveLength(1);
    const evidence = bool.must[0] as { bool: Record<string, unknown> };
    expect(evidence.bool.minimum_should_match).toBe(1);
    const evidenceShould = evidence.bool.should as Record<string, unknown>[];
    expect(evidenceShould).toHaveLength(2);
    expect(evidenceShould[0]).toEqual({
      match_phrase: {
        meshTerms: { query: "Electronic Health Records", boost: 8 },
      },
    });
    expect(evidenceShould[1]).toEqual({
      terms: {
        reciterParentTopicId: ["digital-health", "informatics"],
        boost: 6,
      },
    });
  });

  it("case 3 — expanded, resolution with anchors + descendants: §5.2 four-clause body", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "EHR",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    expect(result.queryShape).toBe("concept_expanded");
    const bool = topLevelBool(capturedBodies[0]);

    // SPEC §5.2 — no `must` key (admission lives in top-level should).
    expect(bool).not.toHaveProperty("must");
    // minimum_should_match: 1 at top-level bool.
    expect((bool as { minimum_should_match?: number }).minimum_should_match).toBe(1);

    // Four clauses: BM25(q) + BM25(name) + terms(descendantUis) + terms(anchors).
    const should = bool.should as Record<string, unknown>[];
    expect(should).toHaveLength(4);

    const bm25Q = should[0] as { multi_match: Record<string, unknown> };
    expect(bm25Q.multi_match.query).toBe("EHR");
    expect(bm25Q.multi_match.boost).toBe(1);

    const bm25Name = should[1] as { multi_match: Record<string, unknown> };
    expect(bm25Name.multi_match.query).toBe("Electronic Health Records");
    expect(bm25Name.multi_match.boost).toBe(1);

    const meshUi = should[2] as { terms: Record<string, unknown> };
    expect(meshUi.terms.meshDescriptorUi).toEqual(["D057286", "D000077863"]);
    expect(meshUi.terms.boost).toBe(8);

    const anchors = should[3] as { terms: Record<string, unknown> };
    expect(anchors.terms.reciterParentTopicId).toEqual([
      "digital-health",
      "informatics",
    ]);
    expect(anchors.terms.boost).toBe(6);
  });

  it("case 4 — expanded, resolution without anchors: §5.2 with clause 4 omitted (3 clauses)", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "EHR",
      page: 0,
      meshResolution: RESOLUTION_WITHOUT_ANCHORS,
    });
    expect(result.queryShape).toBe("concept_expanded");
    const bool = topLevelBool(capturedBodies[0]);
    const should = bool.should as Record<string, unknown>[];
    expect(should).toHaveLength(3);
    // No anchor clause; reciterParentTopicId absent from the serialized body.
    expect(JSON.stringify(capturedBodies[0])).not.toContain("reciterParentTopicId");
  });

  it("case 5 — expanded + meshStrict=true: byte-identical to strict-mode concept_filtered (chip narrow override)", async () => {
    // Run expanded + meshStrict.
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    const modExp = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const rExp = await modExp.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
      meshStrict: true,
    });
    expect(rExp.queryShape).toBe("concept_filtered");
    const expandedNarrowBody = capturedBodies[0];

    // Reset and run pure strict mode.
    capturedBodies.length = 0;
    vi.resetModules();
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "strict";
    const modStrict = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    await modStrict.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    const strictBody = capturedBodies[0];

    expect(expandedNarrowBody).toEqual(strictBody);
  });

  it("case 6 — off, resolution present: §1.2 shape (resolution logged but not applied)", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "off";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    const result = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    expect(result.queryShape).toBe("restructured_msm");
    const bool = topLevelBool(capturedBodies[0]);
    expect(bool).not.toHaveProperty("should");
    expect(JSON.stringify(capturedBodies[0])).not.toContain("reciterParentTopicId");
    expect(JSON.stringify(capturedBodies[0])).not.toContain("meshDescriptorUi");
  });

  it("case 7 — expanded + empty descendantUis: falls through to §1.2 + logs invariant violation", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mod = (await import("@/lib/api/search")) as {
        searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
      };
      const result = await mod.searchPublications({
        q: "EHR",
        page: 0,
        meshResolution: RESOLUTION_EMPTY_DESCENDANTS,
      });
      // Defensive fall-through: not concept_expanded, body is the §1.2 shape.
      expect(result.queryShape).toBe("restructured_msm");
      expect(JSON.stringify(capturedBodies[0])).not.toContain("meshDescriptorUi");
      // Loud log fired exactly once with the descriptor UI for grep.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(payload.event).toBe("concept_expanded_invariant_violated");
      expect(payload.descriptorUi).toBe("D057286");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("case 8 — expanded shape: facet aggs reference top-level should + msm:1, not must", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    await mod.searchPublications({
      q: "EHR",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    const body = capturedBodies[0];
    const aggs = body.aggs as Record<string, Record<string, unknown>>;
    const expectedShould = (topLevelBool(body).should as Record<string, unknown>[]);

    for (const aggName of ["publicationTypes", "journals", "wcmRoleFirst"]) {
      const filter = aggs[aggName].filter as { bool: Record<string, unknown> };
      expect(filter.bool).not.toHaveProperty("must");
      expect(filter.bool.should).toEqual(expectedShould);
      expect(filter.bool.minimum_should_match).toBe(1);
    }
  });

  it("case 9 — strict mode aggs still carry `must` (byte-identical to legacy)", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "strict";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{ queryShape: string }>;
    };
    await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    const body = capturedBodies[0];
    const aggs = body.aggs as Record<string, Record<string, unknown>>;
    const expectedMust = (topLevelBool(body).must as Record<string, unknown>[]);
    const pubTypesFilter = aggs.publicationTypes.filter as { bool: Record<string, unknown> };
    expect(pubTypesFilter.bool.must).toEqual(expectedMust);
    expect(pubTypesFilter.bool).not.toHaveProperty("should");
  });

  it("case 10 — telemetry fields populated unconditionally on the result", async () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "strict";
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        queryShape: string;
        meshDescendantSetSize: number | null;
        meshAnchorCount: number | null;
      }>;
    };
    const withResolution = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: RESOLUTION_WITH_ANCHORS,
    });
    expect(withResolution.meshDescendantSetSize).toBe(2);
    expect(withResolution.meshAnchorCount).toBe(2);

    const withoutResolution = await mod.searchPublications({
      q: "electronic health records",
      page: 0,
      meshResolution: null,
    });
    expect(withoutResolution.meshDescendantSetSize).toBe(null);
    expect(withoutResolution.meshAnchorCount).toBe(null);
  });
});
