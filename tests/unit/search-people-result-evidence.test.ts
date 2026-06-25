/**
 * #824 follow-up Phase 1 — `searchPeople` emits the single typed `evidence`
 * object per hit when `SEARCH_RESULT_EVIDENCE` is on (and nothing — byte-
 * identical to today — when off). Mirrors the match-aware-snippet test harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPubTopicGroupBy,
  mockScholarFamilyFindMany,
  mockTopicFindMany,
  mockSuppressionOverlayFindMany,
  mockSensitivityOverlayFindMany,
  mockSearch,
  mockReasonAgg,
} = vi.hoisted(() => ({
  mockPubTopicGroupBy: vi.fn(),
  mockScholarFamilyFindMany: vi.fn(),
  mockTopicFindMany: vi.fn(),
  mockSuppressionOverlayFindMany: vi.fn(),
  mockSensitivityOverlayFindMany: vi.fn(),
  mockSearch: vi.fn(),
  // Drives the reason-aggregation response (the publications-index `size:0`
  // query). Defaults to no buckets; individual tests override.
  mockReasonAgg: vi.fn((): unknown[] => []),
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

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensSensitiveGateOn: () => false,
  isMethodPagesEnabled: () => true,
  isMethodsLensEnabled: () => true,
  isMethodsFamilyDefinitionsOn: () => false,
}));

// One scholar with SIX areas (to exercise the N=4 cap), one with the method.
const HITS = [
  {
    _source: {
      cwid: "el1",
      slug: "ed-leon",
      preferredName: "Ed Leon",
      primaryTitle: "Professor",
      primaryDepartment: "Medicine",
      deptName: "Medicine",
      divisionName: null,
      personType: "full_time_faculty",
      publicationCount: 200,
      grantCount: 12,
      hasActiveGrants: true,
      areasOfInterest:
        "metabolic_endocrine_disease mental_health single_cell_spatial_biology genetics_precision transplantation_medicine neurodegenerative_disease",
    },
    highlight: undefined,
  },
];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ["preferredName^10", "overview^2"],
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: Object.freeze(["preferredName^1", "overview^2"]),
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
    async search(args: { index?: string }) {
      mockSearch(args);
      // The reason aggregation (#1 free-text mention disclosure) is a separate
      // `size:0` query against the PUBLICATIONS index. The test sets
      // `mockReasonAgg` to drive it; everything else is the people query.
      if (args?.index === "scholars-publications") {
        return { body: { aggregations: { byAuthor: { buckets: mockReasonAgg() } } } };
      }
      return {
        body: {
          hits: { total: { value: 1 }, hits: HITS },
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

const EVIDENCE = "SEARCH_RESULT_EVIDENCE";
const MATCH_AWARE = "SEARCH_PEOPLE_MATCH_AWARE_SNIPPET";

const TOPIC_ROWS = [
  { id: "single_cell_spatial_biology", label: "Single-cell & spatial biology" },
  { id: "metabolic_endocrine_disease", label: "Metabolic & endocrine disease" },
  { id: "mental_health", label: "Mental health & psychiatry" },
  { id: "genetics_precision", label: "Genetics, genomics & precision medicine" },
];

beforeEach(() => {
  mockPubTopicGroupBy.mockReset().mockResolvedValue([]);
  mockScholarFamilyFindMany.mockReset().mockResolvedValue([]);
  mockTopicFindMany.mockReset().mockResolvedValue(TOPIC_ROWS);
  mockSuppressionOverlayFindMany.mockReset().mockResolvedValue([]);
  mockSensitivityOverlayFindMany.mockReset().mockResolvedValue([]);
  mockSearch.mockReset();
  mockReasonAgg.mockReset().mockReturnValue([]);
  delete process.env[MATCH_AWARE];
});

afterEach(() => {
  delete process.env[EVIDENCE];
  delete process.env[MATCH_AWARE];
  vi.clearAllMocks();
});

const FAMILY = { supercategory: "sequencing", familyLabel: "Single-cell RNA sequencing" };

describe("searchPeople — evidence emission gated on SEARCH_RESULT_EVIDENCE", () => {
  it("flag OFF ⇒ no evidence field, no scholar_family query", async () => {
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(result.hits[0].evidence).toBeUndefined();
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("flag ON + method family the scholar is in ⇒ method evidence with REFINED tools", async () => {
    process.env[EVIDENCE] = "on";
    mockScholarFamilyFindMany.mockResolvedValue([
      {
        cwid: "el1",
        familyLabel: "Single-cell RNA sequencing",
        // family restatement (→ scRNA-seq), a 2-word tool, a platform phrase (→ 10x)
        exemplarTools: [
          "Single-cell RNA sequencing (scRNA-seq)",
          "single-cell transcriptomics",
          "10x single-cell transcriptome analysis",
        ],
      },
    ]);
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });
    expect(result.hits[0].evidence).toEqual({
      kind: "method",
      family: "Single-cell RNA sequencing",
      tools: ["scRNA-seq", "single-cell transcriptomics", "10x"],
    });
  });

  it("flag ON + matched topic slug in areas ⇒ topic evidence", async () => {
    process.env[EVIDENCE] = "on";
    const result = await searchPeople({
      q: "single cell spatial biology",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: {
        methodFamily: null,
        topics: [{ slug: "single_cell_spatial_biology", label: "Single-cell & spatial biology" }],
      },
    });
    expect(result.hits[0].evidence).toEqual({
      kind: "topic",
      label: "Single-cell & spatial biology",
      id: "single_cell_spatial_biology",
    });
  });

  it("flag ON + nothing matched ⇒ areas evidence, capped to N=4, total=6, NO matchedIndex", async () => {
    process.env[EVIDENCE] = "on";
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: {
        methodFamily: null,
        topics: [{ slug: "not_in_any_areas", label: "Unrelated" }],
      },
    });
    const ev = result.hits[0].evidence;
    expect(ev?.kind).toBe("areas");
    if (ev?.kind !== "areas") throw new Error("expected areas");
    expect(ev.labels).toHaveLength(4);
    expect(ev.total).toBe(6);
    // The dead `-1` field is intentionally absent (handoff §5.0A).
    expect("matchedIndex" in ev).toBe(false);
    // Humanized — no raw slugs.
    expect(ev.labels.every((l) => !l.includes("_"))).toBe(true);
  });
});

// Rep-papers disclosure (#1) — the content-shaped free-text mention path. A query
// that resolves to NO concept (`meshDescendantUis` empty, `queryShape` ===
// "restructured_msm") must, ONLY when the evidence flag is on, run the reason
// aggregation and surface `publications:mention`. With the flag OFF the agg gate
// falls back to the original pre-disclosure predicate, so neither the extra
// publications-index round-trip nor the new "publications mention" legacy reason
// line appears (off-path byte-identical).
const PUBLICATIONS_INDEX = "scholars-publications";

const MENTION_BUCKET = [
  {
    key: "el1",
    mention: {
      // A — the reason agg now reads the filter agg's intrinsic `doc_count`
      // (distinct-pmid count for a one-doc-per-pmid index) instead of a
      // redundant `cardinality(pmid)` sub-agg, so the mock carries `doc_count`.
      doc_count: 7,
      top: {
        hits: {
          hits: [
            {
              _source: { pmid: "33144353", title: "16S rRNA gut microbiome survey", year: 2021 },
              highlight: { title: ["<mark>16S rRNA</mark> gut microbiome survey"] },
            },
            {
              _source: { pmid: "31000000", title: "Microbial community profiling", year: 2019 },
            },
          ],
        },
      },
    },
  },
];

describe("searchPeople — free-text publications:mention evidence (#1)", () => {
  it("flag OFF + matchExplain on + free-text query ⇒ NO reason agg, NO mention reason line", async () => {
    // No EVIDENCE flag. matchExplain on, a free-text query with no shape →
    // queryShape stays "restructured_msm", no resolved descriptor. The widened
    // content-shape gate must NOT fire on the off-path.
    mockReasonAgg.mockReturnValue(MENTION_BUCKET);
    const result = await searchPeople({
      q: "16s rna",
      relevanceMode: "v3",
      matchExplain: true,
      representativePub: true,
    });
    // The publications-index reason aggregation must not have been issued.
    expect(
      mockSearch.mock.calls.some(([a]) => (a as { index?: string })?.index === PUBLICATIONS_INDEX),
    ).toBe(false);
    // No evidence object (flag off) and no "publications mention" legacy reason.
    expect(result.hits[0].evidence).toBeUndefined();
    const reason = result.hits[0].matchReason;
    if (reason && "text" in reason) {
      expect(reason.text).not.toMatch(/publications mention/i);
    }
  });

  it("flag ON + matchExplain/representativePub + free-text no-concept query ⇒ publications:mention with pubs", async () => {
    process.env[EVIDENCE] = "on";
    mockReasonAgg.mockReturnValue(MENTION_BUCKET);
    const result = await searchPeople({
      q: "16s rna",
      relevanceMode: "v3",
      matchExplain: true,
      representativePub: true,
      matchAwareContext: { methodFamily: null, topics: [] },
    });
    // The reason agg DID run against the publications index.
    expect(
      mockSearch.mock.calls.some(([a]) => (a as { index?: string })?.index === PUBLICATIONS_INDEX),
    ).toBe(true);
    const ev = result.hits[0].evidence;
    expect(ev?.kind).toBe("publications");
    if (ev?.kind !== "publications") throw new Error("expected publications evidence");
    expect(ev.strength).toBe("mention");
    // count is min(mention=7, pubCount=200) = 7; text is the human "N of M" line.
    expect(ev.count).toBe(7);
    expect(ev.text).toBe('7 of 200 publications mention “16s rna”');
    expect(ev.pubs).toEqual([
      {
        pmid: "33144353",
        title: "16S rRNA gut microbiome survey",
        titleHtml: "<mark>16S rRNA</mark> gut microbiome survey",
        year: 2021,
      },
      { pmid: "31000000", title: "Microbial community profiling", year: 2019 },
    ]);
  });

  it("flag ON + no descriptor ⇒ the `tagged` sub-agg is OMITTED from the request body", async () => {
    process.env[EVIDENCE] = "on";
    mockReasonAgg.mockReturnValue(MENTION_BUCKET);
    await searchPeople({
      q: "16s rna",
      relevanceMode: "v3",
      matchExplain: true,
      representativePub: true,
      matchAwareContext: { methodFamily: null, topics: [] },
    });
    const aggCall = mockSearch.mock.calls
      .map(([a]) => a as { index?: string; body?: { aggs?: { byAuthor?: { aggs?: Record<string, unknown> } } } })
      .find((a) => a?.index === PUBLICATIONS_INDEX);
    expect(aggCall).toBeDefined();
    const byAuthorAggs = aggCall?.body?.aggs?.byAuthor?.aggs ?? {};
    // No resolved descriptor ⇒ only `mention` is computed; `tagged` is absent.
    expect("tagged" in byAuthorAggs).toBe(false);
    expect("mention" in byAuthorAggs).toBe(true);
  });

  // Scaling fix B — `skipReasonAgg` defers the per-row reason line so the People
  // list can paint without blocking on the slow publications-index agg. The fast
  // call must NOT issue the agg, yet still return the hits.
  it("skipReasonAgg true ⇒ NO publications-index reason agg, hits still returned", async () => {
    process.env[EVIDENCE] = "on";
    mockReasonAgg.mockReturnValue(MENTION_BUCKET);
    const result = await searchPeople({
      q: "16s rna",
      relevanceMode: "v3",
      matchExplain: true,
      representativePub: true,
      matchAwareContext: { methodFamily: null, topics: [] },
      skipReasonAgg: true,
    });
    // The deferred fast path skips the publications-index round-trip entirely.
    expect(
      mockSearch.mock.calls.some(([a]) => (a as { index?: string })?.index === PUBLICATIONS_INDEX),
    ).toBe(false);
    // The list still gets its hits (the reason line streams in separately).
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].cwid).toBe("el1");
  });
});
