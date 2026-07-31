/**
 * #824 follow-up — match-aware People snippet (`SEARCH_PEOPLE_MATCH_AWARE_SNIPPET`).
 *
 * The legacy `matchReason`/`humanizedAreas` hit fields this file used to assert
 * on were deleted (#2118 remainder) — they lost their only renderer in #2134 and
 * had no other consumer. Equivalent (and more thorough) coverage of method/topic/
 * areas derivation now lives in `search-people-result-evidence.test.ts` (the
 * `evidence`/`evidenceLines` fields those legacy fields were duplicating). What
 * remains here:
 *   (f)/(f-off) the raw `areasOfInterest` highlight-request regression;
 *   `humanizeAreaSlug` / `pickMatchedAreaIndex` — the pure helpers still used by
 *   the live evidence path (`buildHitEvidenceInput` in `lib/api/search.ts`);
 *   `buildMatchAwareContext` — unrelated, still live.
 *
 * Mocks @/lib/db + @/lib/search per the existing search-test harness pattern
 * (search-people-topic-template.test.ts / search-people-query-shape.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPubTopicGroupBy,
  mockScholarFamilyFindMany,
  mockTopicFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockSearch,
} = vi.hoisted(() => ({
  mockPubTopicGroupBy: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockSearch: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: mockPubTopicGroupBy },
    scholarFamily: { findMany: mockScholarFamilyFindMany },
    topic: { findMany: mockTopicFindMany },
    familySuppressionOverlay: { findMany: mockSuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mockSensitivityOverlayFindMany },
  },
}));

// `loadFamilyOverlayGate` reads this; forceSensitive:true ignores it, but the
// import must resolve.
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensSensitiveGateOn: () => false,
  isMethodPagesEnabled: () => true,
  isMethodsLensEnabled: () => true,
  isMethodsFamilyDefinitionsOn: () => false,
}));

// Two scholars on the page. `areasOfInterest` returned only when the flag adds it
// to `_source`; the mock returns it unconditionally and searchPeople reads it iff
// the flag is on.
const HITS = [
  {
    _source: {
      cwid: "oe1",
      slug: "olivier-elemento",
      preferredName: "Olivier Elemento",
      primaryTitle: "Professor",
      primaryDepartment: "Systems Biomedicine",
      deptName: "Systems Biomedicine",
      divisionName: null,
      personType: "full_time_faculty",
      publicationCount: 538,
      grantCount: 132,
      hasActiveGrants: true,
      areasOfInterest: "single_cell_spatial_biology cell_molecular_biology lung_cancer",
    },
    highlight: undefined,
  },
  {
    _source: {
      cwid: "ks2",
      slug: "karsten-suhre",
      preferredName: "Karsten Suhre",
      primaryTitle: "Professor",
      primaryDepartment: "Systems Biomedicine",
      deptName: "Systems Biomedicine",
      divisionName: null,
      personType: "full_time_faculty",
      publicationCount: 319,
      grantCount: 10,
      hasActiveGrants: true,
      areasOfInterest: "metabolic_endocrine_disease single_cell_spatial_biology",
    },
    highlight: undefined,
  },
];

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
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_METHOD_CONTEXT_BOOST: 0.5,
  PEOPLE_TOPIC_METHOD_CONTEXT_BOOST: 0.8,
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  MESH_ADMIT_WEIGHT: { exact: 3, "anchored-entry": 1.5, entry: 0.7 },
  MESH_ATTRIBUTION_WEIGHT: { exact: 1.5, "anchored-entry": 1.3, entry: 1.15 },
  MESH_ESCALATION_THRESHOLD: 50,
  MESH_MIN_MATCHED_FORM_LEN: 4,
  searchClient: () => ({
    async search(args: unknown) {
      mockSearch(args);
      return {
        body: {
          hits: { total: { value: 2 }, hits: HITS },
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

import {
  searchPeople,
  pickMatchedAreaIndex,
  humanizeAreaSlug,
} from "@/lib/api/search";
import {
  buildMatchAwareContext,
  type TaxonomyMatch,
  type TaxonomyMatchResult,
} from "@/lib/api/search-taxonomy";

const FLAG = "SEARCH_PEOPLE_MATCH_AWARE_SNIPPET";
let prior: string | undefined;

const TOPIC_ROWS = [
  { id: "single_cell_spatial_biology", label: "Single-cell & spatial biology" },
  { id: "metabolic_endocrine_disease", label: "Metabolic & endocrine disease" },
  { id: "cell_molecular_biology", label: "Cell & molecular biology" },
];

beforeEach(() => {
  prior = process.env[FLAG];
  mockPubTopicGroupBy.mockReset().mockResolvedValue([]);
  mockScholarFamilyFindMany.mockReset().mockResolvedValue([]);
  mockTopicFindMany.mockReset().mockResolvedValue(TOPIC_ROWS);
  mockSuppressionOverlayFindMany.mockReset().mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockReset().mockResolvedValue([]);
  mockSearch.mockReset();
});

// Pull the people-index search request body (the call whose highlight targets
// the self-reported name field, not the pub-agg `title` highlight).
function peopleHighlightFields(): Record<string, unknown> {
  const call = mockSearch.mock.calls.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c) => (c[0] as any)?.body?.highlight?.fields?.preferredName !== undefined,
  );
  if (!call) throw new Error("no people-index search captured");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (call[0] as any).body.highlight.fields as Record<string, unknown>;
}

afterEach(() => {
  if (prior === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prior;
  vi.clearAllMocks();
});

const FAMILY = { supercategory: "sequencing", familyLabel: "Single-cell RNA sequencing" };

describe("match-aware snippet — flag ON", () => {
  beforeEach(() => {
    process.env[FLAG] = "on";
  });

  // The method/topic/areas OUTPUT these used to assert on (`matchReason`,
  // `humanizedAreas`) is gone (#2118 remainder); equivalent coverage of the
  // resolution itself (family match, ≤3 deduped/refined tools, topic label,
  // areas fallback) lives in `search-people-result-evidence.test.ts` against
  // the live `evidence` field. What's still unique here is the #800/#801
  // defense-in-depth: the `scholar_family` query is never even ISSUED for a
  // suppressed/sensitive family, independent of which output field would have
  // consumed the result.
  it("(c) #800-suppressed resolved family ⇒ NO scholar_family query", async () => {
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: "sequencing", familyLabel: "Single-cell RNA sequencing" },
    ]);
    await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("(c2) #801-sensitive resolved family ⇒ NO scholar_family query (public surface, forceSensitive)", async () => {
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: "sequencing", familyLabel: "Single-cell RNA sequencing" },
    ]);
    await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });
});

describe("match-aware snippet — raw areasOfInterest highlight is replaced (regression)", () => {
  // The bug: the server kept highlighting `areasOfInterest` even with the flag on,
  // so the raw `under_score` slug fragment came back as `hit.highlight` and the
  // card rendered it BEFORE `humanizedAreas` — the slug dump still showed (e.g.
  // Olivier Elemento, row 1, on staging). Fix: drop areasOfInterest from the
  // highlight request when matchAwareContext is set, so humanized areas (or a real
  // overview sentence) is the only areas-grade snippet.
  it("(f) flag ON + context ⇒ areasOfInterest is NOT in the people highlight; overview stays", async () => {
    process.env[FLAG] = "on";
    await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    const fields = peopleHighlightFields();
    expect(fields).not.toHaveProperty("areasOfInterest");
    expect(fields).toHaveProperty("overview");
    expect(fields).toHaveProperty("preferredName");
  });

  it("(f-off) flag OFF ⇒ areasOfInterest IS highlighted (today's behavior unchanged)", async () => {
    delete process.env[FLAG];
    await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(peopleHighlightFields()).toHaveProperty("areasOfInterest");
  });
});

describe("pure helpers", () => {
  it("humanizeAreaSlug sentence-cases a snake_case slug", () => {
    expect(humanizeAreaSlug("single_cell_spatial_biology")).toBe("Single cell spatial biology");
    expect(humanizeAreaSlug("")).toBe("");
  });

  describe("E1 selection half — pickMatchedAreaIndex", () => {
    // The real staging shape that motivated this: a hematopathologist whose
    // `areasOfInterest` string LEADS with breast_cancer (count 1) while the corpus the
    // query actually matched lives in hematology (count 21).
    const INGHIRAMI = "breast_cancer lung_cancer gene_cell_therapy hematology gi_cancer".split(" ");
    const COUNTS = { breast_cancer: 1, lung_cancer: 1, hematology: 21, gi_cancer: 4 };
    const ALL_CANCER = new Set(["breast_cancer", "lung_cancer", "hematology", "gi_cancer"]);

    it("picks the BEST-EVIDENCED intersecting area, not the first in the scholar's list", () => {
      expect(pickMatchedAreaIndex(INGHIRAMI, ALL_CANCER, COUNTS)).toBe(3); // hematology (21)
    });

    it("a narrower query still picks the area that query matched, however small", () => {
      // The rule must not become "always the scholar's biggest area" — only the
      // intersecting ones are candidates.
      expect(pickMatchedAreaIndex(INGHIRAMI, new Set(["breast_cancer"]), COUNTS)).toBe(0);
    });

    it("no areaCounts (doc not yet reindexed) ⇒ first intersecting, i.e. the OLD behavior", () => {
      expect(pickMatchedAreaIndex(INGHIRAMI, ALL_CANCER, undefined)).toBe(0);
      expect(pickMatchedAreaIndex(INGHIRAMI, ALL_CANCER, {})).toBe(0);
    });

    it("ties keep the scholar's own order — `>` is strict, so the rule is stable", () => {
      expect(pickMatchedAreaIndex(INGHIRAMI, new Set(["breast_cancer", "lung_cancer"]), COUNTS)).toBe(0);
    });

    it("an area with no count still beats no match at all, and no intersection is -1", () => {
      expect(pickMatchedAreaIndex(INGHIRAMI, new Set(["gene_cell_therapy"]), COUNTS)).toBe(2);
      expect(pickMatchedAreaIndex(INGHIRAMI, new Set(["cardiology"]), COUNTS)).toBe(-1);
      expect(pickMatchedAreaIndex([], ALL_CANCER, COUNTS)).toBe(-1);
    });
  });
});

describe("buildMatchAwareContext (search-taxonomy)", () => {
  function tm(over: Partial<TaxonomyMatch>): TaxonomyMatch {
    return {
      entityType: "parentTopic",
      id: "x",
      name: "X",
      parentTopicId: null,
      parentTopicLabel: null,
      href: "/topics/x",
      scholarCount: 1,
      publicationCount: 1,
      similarity: 1,
      description: null,
      subtopicCount: 0,
      supercategory: null,
      familyLabel: null,
      ...over,
    };
  }
  function matchesResult(over: Partial<Extract<TaxonomyMatchResult, { state: "matches" }>>): TaxonomyMatchResult {
    const primary = tm({ id: "p", name: "P" });
    return {
      state: "matches",
      primary,
      secondary: [],
      overflowCount: 0,
      query: "q",
      meshResolution: null,
      areas: [],
      totalMatched: 0,
      methodMatches: [],
      ...over,
    };
  }

  it("returns undefined on a non-matches result", () => {
    expect(buildMatchAwareContext({ state: "none", meshResolution: null })).toBeUndefined();
  });

  it("derives the method family from the top method match", () => {
    const ctx = buildMatchAwareContext(
      matchesResult({
        methodMatches: [
          tm({
            entityType: "methodFamily",
            id: "fam",
            name: "Single-cell RNA sequencing",
            supercategory: "sequencing",
            familyLabel: "Single-cell RNA sequencing",
          }),
        ],
      }),
    );
    expect(ctx?.methodFamily).toEqual({
      supercategory: "sequencing",
      familyLabel: "Single-cell RNA sequencing",
    });
  });

  it("a bare supercategory match (no familyLabel) yields no method family", () => {
    const ctx = buildMatchAwareContext(
      matchesResult({
        methodMatches: [
          tm({ entityType: "supercategory", supercategory: "sequencing", familyLabel: null }),
        ],
      }),
    );
    expect(ctx?.methodFamily).toBeNull();
  });

  it("maps topic areas to { parent-slug, parent-label } and keys subtopics on the parent", () => {
    const ctx = buildMatchAwareContext(
      matchesResult({
        areas: [
          tm({
            entityType: "parentTopic",
            id: "single_cell_spatial_biology",
            name: "Single-cell & spatial biology",
          }),
          tm({
            entityType: "subtopic",
            id: "spatial_transcriptomics",
            name: "Spatial transcriptomics",
            parentTopicId: "single_cell_spatial_biology",
            parentTopicLabel: "Single-cell & spatial biology",
          }),
        ],
      }),
    );
    // The subtopic dedupes against its parent's slug.
    expect(ctx?.topics).toEqual([
      { slug: "single_cell_spatial_biology", label: "Single-cell & spatial biology" },
    ]);
  });
});
