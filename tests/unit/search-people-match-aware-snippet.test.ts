/**
 * #824 follow-up — match-aware People snippet (`SEARCH_PEOPLE_MATCH_AWARE_SNIPPET`).
 *
 * Behavioral assertions on `searchPeople`'s per-hit reason derivation + the pure
 * helpers (`buildHumanizedAreas`, `cleanExemplarTools`, `humanizeAreaSlug`):
 *   (a) flag OFF ⇒ no method/topic reason, no humanizedAreas, no extra query;
 *   (b) flag ON + resolved method family + scholar in it ⇒ { kind:"method" }
 *       reason with the family label + deduped, ≤3 exemplar tools;
 *   (c) suppressed/sensitive resolved family ⇒ NO method reason (overlay gate);
 *   (d) topic-slug-in-areasOfInterest ⇒ { kind:"topic" } reason;
 *   (e) humanized areas: a slug like "single_cell_spatial_biology" renders without
 *       underscores (real Topic.label preferred).
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
  buildHumanizedAreas,
  cleanExemplarTools,
  humanizeAreaSlug,
} from "@/lib/api/search";
import {
  buildMatchAwareContext,
  type TaxonomyMatch,
  type TaxonomyMatchResult,
} from "@/lib/api/search-taxonomy";

const FLAG = "SEARCH_PEOPLE_MATCH_AWARE_SNIPPET";
let prior: string | undefined;

const isMethodReason = (r: unknown): boolean =>
  !!r && typeof r === "object" && "kind" in r && (r as { kind: string }).kind === "method";

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

describe("match-aware snippet — flag OFF (default)", () => {
  it("(a) emits no method/topic reason, no humanizedAreas, and never queries scholar_family", async () => {
    delete process.env[FLAG];
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: {
        methodFamily: FAMILY,
        topics: [{ slug: "single_cell_spatial_biology", label: "Single-cell & spatial biology" }],
      },
    });
    expect(result.hits.map((h) => h.matchReason)).toEqual([undefined, undefined]);
    expect(result.hits.every((h) => h.humanizedAreas === undefined)).toBe(true);
    // No extra derivation queries fired.
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
    expect(mockTopicFindMany).not.toHaveBeenCalled();
    expect(mockSuppressionOverlayFindMany).not.toHaveBeenCalled();
  });
});

describe("match-aware snippet — flag ON", () => {
  beforeEach(() => {
    process.env[FLAG] = "on";
  });

  it("(b) resolved method family + scholar in it ⇒ method reason with family + ≤3 deduped tools", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      {
        cwid: "oe1",
        familyLabel: "Single-cell RNA sequencing",
        // Dedupe (case-insensitive) + cap at 3: "scRNA-seq" twice, plus 4 distinct.
        exemplarTools: ["scRNA-seq", " single-nuclei ", "scrna-seq", "10x", "Smart-seq"],
      },
    ]);
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    const oe = result.hits.find((h) => h.cwid === "oe1")!;
    expect(oe.matchReason).toEqual({
      kind: "method",
      family: "Single-cell RNA sequencing",
      tools: ["scRNA-seq", "single-nuclei", "10x"],
    });
    // The batched query is filtered to the resolved family + page cwids.
    const arg = mockScholarFamilyFindMany.mock.calls[0][0];
    expect(arg.where.supercategory).toBe("sequencing");
    expect(arg.where.familyLabel).toBe("Single-cell RNA sequencing");
    expect(arg.where.cwid).toEqual({ in: ["oe1", "ks2"] });
    // Scholar NOT in the family gets no method reason (falls through; with empty
    // topics + no bio highlight that's a humanized-areas fallback, not a method).
    const ks = result.hits.find((h) => h.cwid === "ks2")!;
    expect(isMethodReason(ks.matchReason)).toBe(false);
  });

  it("(c) #800-suppressed resolved family ⇒ NO method reason, NO scholar_family query", async () => {
    // Suppression overlay marks the resolved (sc,label) — gate must skip it.
    mockSuppressionOverlayFindMany.mockResolvedValue([
      { supercategory: "sequencing", familyLabel: "Single-cell RNA sequencing" },
    ]);
    mockScholarFamilyFindMany.mockResolvedValue([
      { cwid: "oe1", familyLabel: "Single-cell RNA sequencing", exemplarTools: ["scRNA-seq"] },
    ]);
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(
      result.hits.some((h) => isMethodReason(h.matchReason)),
    ).toBe(false);
    // Defense-in-depth: the family query is never even issued when suppressed.
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("(c2) #801-sensitive resolved family ⇒ NO method reason (public surface, forceSensitive)", async () => {
    mockSensitivityOverlayFindMany.mockResolvedValue([
      { supercategory: "sequencing", familyLabel: "Single-cell RNA sequencing" },
    ]);
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(
      result.hits.some((h) => isMethodReason(h.matchReason)),
    ).toBe(false);
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("(d) topic-slug in areasOfInterest ⇒ topic reason with the clean human label", async () => {
    const result = await searchPeople({
      q: "single cell spatial biology",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: {
        methodFamily: null,
        topics: [
          { slug: "single_cell_spatial_biology", label: "Single-cell & spatial biology" },
        ],
      },
    });
    // Both scholars carry the matched slug in areasOfInterest.
    for (const h of result.hits) {
      expect(h.matchReason).toEqual({
        kind: "topic",
        label: "Single-cell & spatial biology",
      });
    }
  });

  it("(d2) method takes PRIORITY over topic for the same scholar", async () => {
    mockScholarFamilyFindMany.mockResolvedValue([
      { cwid: "oe1", familyLabel: "Single-cell RNA sequencing", exemplarTools: ["scRNA-seq"] },
    ]);
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: {
        methodFamily: FAMILY,
        topics: [
          { slug: "single_cell_spatial_biology", label: "Single-cell & spatial biology" },
        ],
      },
    });
    const oe = result.hits.find((h) => h.cwid === "oe1")!;
    expect(oe.matchReason && "kind" in oe.matchReason && oe.matchReason.kind).toBe("method");
    // ks2 has no method row but matches the topic slug → topic reason.
    const ks = result.hits.find((h) => h.cwid === "ks2")!;
    expect(ks.matchReason).toEqual({ kind: "topic", label: "Single-cell & spatial biology" });
  });

  it("(e) humanized areas fallback renders WITHOUT underscores, matched area first-bold-eligible", async () => {
    // No method, no topic-slug match for these areas → humanized-areas fallback.
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: {
        methodFamily: null,
        // A topic whose slug is NOT in either scholar's areasOfInterest, so no
        // topic reason fires and the humanized fallback is what surfaces.
        topics: [{ slug: "not_in_any_areas", label: "Unrelated topic" }],
      },
    });
    const oe = result.hits.find((h) => h.cwid === "oe1")!;
    expect(oe.matchReason).toBeUndefined();
    expect(oe.humanizedAreas).toBeDefined();
    expect(oe.humanizedAreas!.labels).toEqual([
      "Single-cell & spatial biology", // real Topic.label
      "Cell & molecular biology", // real Topic.label
      "Lung cancer", // slug with no Topic row → sentence-cased humanization
    ]);
    // None of the labels contain an underscore.
    expect(oe.humanizedAreas!.labels.every((l) => !l.includes("_"))).toBe(true);
    expect(oe.humanizedAreas!.matchedIndex).toBe(-1);
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

  it("cleanExemplarTools coerces, trims, dedupes (case-insensitive), caps at 3", () => {
    expect(cleanExemplarTools(["scRNA-seq", " scrna-seq ", "10x", "Smart-seq", "extra"])).toEqual([
      "scRNA-seq",
      "10x",
      "Smart-seq",
    ]);
    expect(cleanExemplarTools("not-an-array")).toEqual([]);
    expect(cleanExemplarTools([" ", "", 42], 3)).toEqual(["42"]);
  });

  it("buildHumanizedAreas prefers real labels, bolds the matched area, -1 when none", () => {
    const labelBySlug = new Map([
      ["single_cell_spatial_biology", "Single-cell & spatial biology"],
    ]);
    const ha = buildHumanizedAreas(
      "single_cell_spatial_biology lung_cancer",
      labelBySlug,
      new Set(["lung_cancer"]),
    );
    expect(ha).toEqual({
      labels: ["Single-cell & spatial biology", "Lung cancer"],
      matchedIndex: 1,
    });
    expect(buildHumanizedAreas("", labelBySlug, new Set())).toBeNull();
    expect(buildHumanizedAreas(undefined, labelBySlug, new Set())).toBeNull();
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
