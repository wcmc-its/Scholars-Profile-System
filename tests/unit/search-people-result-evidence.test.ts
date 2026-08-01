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

// #1955 — the descendant-LABEL lookup is the one step of the provenance path that
// reaches Prisma (`descriptorLabelsForUis` → `getMeshMap` → `prisma.meshDescriptor`),
// which the `@/lib/db` mock above does not carry. Stub just that export so the terms are
// real names instead of the UI-code fallback a fail-closed empty map would force — the
// assertions below should not be reading through an error branch. Everything else in the
// module passes through unchanged. The UI literal is inlined because a `vi.mock` factory
// runs before this file's own consts are initialized.
vi.mock("@/lib/api/search-taxonomy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/search-taxonomy")>();
  return {
    ...actual,
    descriptorLabelsForUis: async () => new Map([["D000072761", "Mycobiome"]]),
  };
});

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

// #1955 — per-test `_source` patch for the single hit above. The MeSH provenance
// path keys off `publicationMeshUi` (and, on the reason-from-doc route,
// `meshSubtreeCounts`), neither of which the base fixture has any reason to carry.
// Reset to `{}` in `beforeEach`, so every test that doesn't set it sees today's hit.
let hitSourcePatch: Record<string, unknown> = {};

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
          hits: {
            total: { value: 1 },
            hits: HITS.map((h) => ({ ...h, _source: { ...h._source, ...hitSourcePatch } })),
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

import { searchPeople, methodIndexedPubCounts } from "@/lib/api/search";
import { familyOverlayKey, type FamilyOverlayGate } from "@/lib/api/methods-overlay";

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
  hitSourcePatch = {};
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

// #2071 (E1b) — the topic evidence line's count, resolved query-time via
// `publicationTopic.groupBy` instead of read from the index-time `_source`
// total. Mirrors the "methodPubCount on the hit" block below.
describe("searchPeople — topic evidence count (#2071 E1b)", () => {
  const runWithTopic = () =>
    searchPeople({
      q: "single cell spatial biology",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: {
        methodFamily: null,
        topics: [{ slug: "single_cell_spatial_biology", label: "Single-cell & spatial biology" }],
      },
    });

  it("carries a count sourced from the live groupBy, not a doc field", async () => {
    process.env[EVIDENCE] = "on";
    // `count` only surfaces on the stacked (#1366) evidence path — the single-
    // evidence `evidence` object never carries one, by design.
    process.env.SEARCH_EVIDENCE_REASON_COUNTS = "on";
    mockPubTopicGroupBy.mockResolvedValue([
      { cwid: "el1", parentTopicId: "single_cell_spatial_biology", _count: { pmid: 9 } },
    ]);
    const result = await runWithTopic();
    expect(result.hits[0].evidenceLines).toEqual([
      {
        kind: "topic",
        label: "Single-cell & spatial biology",
        id: "single_cell_spatial_biology",
        count: 9,
      },
    ]);
    delete process.env.SEARCH_EVIDENCE_REASON_COUNTS;
  });

  it("the query is scoped to the page cwids and to the topics THIS query resolved to", async () => {
    process.env[EVIDENCE] = "on";
    mockPubTopicGroupBy.mockResolvedValue([]);
    await runWithTopic();
    expect(mockPubTopicGroupBy).toHaveBeenCalledTimes(1);
    const args = mockPubTopicGroupBy.mock.calls[0][0];
    expect(args.where.cwid).toEqual({ in: ["el1"] });
    expect(args.where.parentTopicId).toEqual({ in: ["single_cell_spatial_biology"] });
  });

  it("nothing matched ⇒ NO groupBy query is issued", async () => {
    process.env[EVIDENCE] = "on";
    const result = await searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: null, topics: [] },
    });
    expect(mockPubTopicGroupBy).not.toHaveBeenCalled();
    expect(result.hits[0].evidence?.kind).not.toBe("topic");
  });

  it("a row for a DIFFERENT cwid never leaks onto this scholar's count", async () => {
    process.env[EVIDENCE] = "on";
    process.env.SEARCH_EVIDENCE_REASON_COUNTS = "on";
    mockPubTopicGroupBy.mockResolvedValue([
      { cwid: "someone-else", parentTopicId: "single_cell_spatial_biology", _count: { pmid: 400 } },
    ]);
    const result = await runWithTopic();
    delete process.env.SEARCH_EVIDENCE_REASON_COUNTS;
    const ev = result.hits[0].evidenceLines?.[0];
    if (ev?.kind !== "topic") throw new Error("expected topic");
    expect(ev.count).toBeUndefined();
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

// #1952 — the tagged label and the `match=concept` set gate must share ONE
// admission predicate. The gate filters on `publicationMeshUi`, which the ETL
// min-evidence-filters; the tagged COUNT comes from sources that do not (the
// doc's `meshSubtreeCounts`, and the agg's raw pub count). So a scholar with one
// middle-author paper on the concept used to read "N of M publications tagged X"
// while `match=concept` hid them. The gate lives at the reasonCounts READ, so
// both the doc path and the agg path are covered by these two assertions.
describe("searchPeople — tagged label obeys the concept-set predicate (#1952)", () => {
  const CONCEPT_UI = "D000078277";
  const source = HITS[0]._source as Record<string, unknown>;
  const taggedBucket = [{ key: "el1", tagged: { doc_count: 1 }, mention: { doc_count: 0 } }];

  afterEach(() => {
    delete source.publicationMeshUi;
  });

  const run = () =>
    searchPeople({
      q: "gun violence",
      relevanceMode: "v3",
      shape: "topic",
      matchExplain: true,
      meshDescendantUis: [CONCEPT_UI],
      meshDescriptorName: "Gun Violence",
      matchAwareContext: { methodFamily: null, topics: [] },
    });

  it("descriptor NOT in publicationMeshUi ⇒ the tagged count is withheld", async () => {
    process.env[EVIDENCE] = "on";
    mockReasonAgg.mockReturnValue(taggedBucket);
    // HITS[0]._source carries no `publicationMeshUi` — the scholar the ETL's
    // min-evidence gate excluded, i.e. exactly who `match=concept` hides.
    const result = await run();
    const ev = result.hits[0].evidence ?? result.hits[0].evidenceLines?.[0];
    expect(ev?.kind === "publications" && ev.strength === "tagged").toBe(false);
  });

  it("descriptor IS in publicationMeshUi ⇒ the tagged count survives", async () => {
    process.env[EVIDENCE] = "on";
    mockReasonAgg.mockReturnValue(taggedBucket);
    source.publicationMeshUi = [CONCEPT_UI];
    const result = await run();
    const lines = result.hits[0].evidenceLines ?? [result.hits[0].evidence];
    expect(
      lines.some((e) => e?.kind === "publications" && e.strength === "tagged"),
    ).toBe(true);
  });

  // The residual after the first fix. #726's escalate-on-sparse admission ORs the
  // descendant-UI terms clause INTO the lexical must, so a scholar with NO lexical
  // match is admitted on the tag alone. They genuinely carry the tag, so the tag
  // half of the predicate passes — but `match=concept` never relaxes the lexical
  // clause, so it excludes them, and the label claimed a match the filter rejects.
  // Escalation names both arms; the gate reads `matched_queries` to tell them apart.
  describe("escalation admits (#726) — the lexical half of the predicate", () => {
    const hit = HITS[0] as Record<string, unknown>;

    afterEach(() => {
      delete hit.matched_queries;
    });

    // Escalation needs meshConceptEligible: an unambiguous resolution whose matched
    // form clears MESH_MIN_MATCHED_FORM_LEN, on a topic template, outside concept
    // scope — plus a sparse lexical total (the mock returns 1, well under 50).
    const runEscalated = () =>
      searchPeople({
        q: "gun violence",
        relevanceMode: "v3",
        shape: "topic",
        matchExplain: true,
        meshDescendantUis: [CONCEPT_UI],
        meshDescriptorName: "Gun Violence",
        meshMatchTier: "exact",
        meshAmbiguous: false,
        meshMatchedFormLength: 12,
        matchAwareContext: { methodFamily: null, topics: [] },
      });

    const taggedSurvives = (r: Awaited<ReturnType<typeof searchPeople>>) => {
      const lines = r.hits[0].evidenceLines ?? [r.hits[0].evidence];
      return lines.some((e) => e?.kind === "publications" && e.strength === "tagged");
    };

    it("mesh-ONLY admit (no lexical match) ⇒ the tagged count is withheld", async () => {
      process.env[EVIDENCE] = "on";
      mockReasonAgg.mockReturnValue(taggedBucket);
      source.publicationMeshUi = [CONCEPT_UI]; // carries the tag — passes the tag half
      hit.matched_queries = ["meshAdmit"]; // …but matched no lexical clause
      expect(taggedSurvives(await runEscalated())).toBe(false);
    });

    it("lexical admit that also carries the tag ⇒ the tagged count survives", async () => {
      process.env[EVIDENCE] = "on";
      mockReasonAgg.mockReturnValue(taggedBucket);
      source.publicationMeshUi = [CONCEPT_UI];
      hit.matched_queries = ["lexicalAdmit", "meshAdmit"];
      expect(taggedSurvives(await runEscalated())).toBe(true);
    });

    // Fail-open. msm:1 over two NAMED arms means an admitted hit always matched a
    // named clause, so an empty list can only mean named-query reporting did not
    // survive the outer function_score wrapper. Degrade to today's behaviour rather
    // than silently zero every tagged label on the sparse path.
    it("named-query reporting absent ⇒ fails OPEN, not closed", async () => {
      process.env[EVIDENCE] = "on";
      mockReasonAgg.mockReturnValue(taggedBucket);
      source.publicationMeshUi = [CONCEPT_UI];
      // no `matched_queries` on the hit at all
      expect(taggedSurvives(await runEscalated())).toBe(true);
    });
  });
});

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
    // No evidence object (flag off).
    expect(result.hits[0].evidence).toBeUndefined();
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
    // count is min(mention=7, pubCount=200) = 7; #1361 — the prefix is the "N of M"
    // line and the literal term is split into `term` (rendered semibold).
    expect(ev.count).toBe(7);
    expect(ev.text).toBe("7 of 200 publications mention");
    expect(ev.term).toBe("“16s rna”");
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

  // #2094 — the reason agg's `maxYear` sub-agg rides the SAME round-trip and puts
  // the most recent counted-publication year on the evidence line. The missing case
  // is the point of this test: OpenSearch answers `{ value: null }` when the filter
  // matched nothing (or no matching pub carries a `year`), and an older cached /
  // pre-deploy bucket carries no `maxYear` at all. BOTH must leave the key ABSENT —
  // an unknown year that arrives as 0, or as the current year, is exactly the
  // defaulting bug this field exists to avoid.
  it("mention `latestYear` — present from the agg, ABSENT (never 0) when the year is unknown", async () => {
    process.env[EVIDENCE] = "on";
    const run = async () =>
      (
        await searchPeople({
          q: "16s rna",
          relevanceMode: "v3",
          matchExplain: true,
          representativePub: true,
          matchAwareContext: { methodFamily: null, topics: [] },
        })
      ).hits[0].evidence;

    // (a) year present — the stale-scholar signal the payload is for.
    mockReasonAgg.mockReturnValue([
      { key: "el1", mention: { doc_count: 7, maxYear: { value: 1989 } } },
    ]);
    const withYear = await run();
    if (withYear?.kind !== "publications") throw new Error("expected publications evidence");
    expect(withYear.latestYear).toBe(1989);

    // (b) sub-agg ran but has no year ⇒ omitted, not 0.
    mockReasonAgg.mockReturnValue([
      { key: "el1", mention: { doc_count: 7, maxYear: { value: null } } },
    ]);
    const nullYear = await run();
    if (nullYear?.kind !== "publications") throw new Error("expected publications evidence");
    expect("latestYear" in nullYear).toBe(false);

    // (c) no `maxYear` in the bucket at all (pre-#2094 response / cached bucket).
    mockReasonAgg.mockReturnValue(MENTION_BUCKET);
    const noAgg = await run();
    if (noAgg?.kind !== "publications") throw new Error("expected publications evidence");
    expect("latestYear" in noAgg).toBe(false);
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

// #1955 — `alsoParent` reaches the card ONLY because `lib/api/search.ts` attaches it to
// the two `SelectEvidenceInput` spreads it builds (`pub.tagged` and `pub.concept`).
// Nothing else in the suite crosses that hop: delete the field from those two spreads and
// every other test stays green while the renderer emits "matched on narrower term " for
// 100% of scholars — #1955 silently unfixed, green CI. This block is that hop's coverage,
// asserted on what `searchPeople` actually emits rather than on the pure selectors.
const MICROBIOTA = "D064307"; // the resolved parent descriptor
const MYCOBIOME = "D000072761"; // a strict descendant of it

type PeopleSearchHit = Awaited<ReturnType<typeof searchPeople>>["hits"][number];
/** The card's LEAD evidence, whichever shape the stacked-lines flag emitted. */
const leadEvidence = (hit: PeopleSearchHit) => hit.evidenceLines?.[0] ?? hit.evidence;

/** One concept search over the fixture scholar, with `_source` patched per case.
 *  `extra` overrides the search args (#1977 needs a boost set that differs from the
 *  provenance set). */
async function leadEvidenceFor(
  source: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  process.env[EVIDENCE] = "on";
  hitSourcePatch = source;
  const result = await searchPeople({
    q: "microbiome",
    relevanceMode: "v3",
    shape: "topic", // arms `applyTopicTemplate`, without which there is no provenance
    matchExplain: true,
    // Doc-sourced tagged count (`meshSubtreeCounts[meshDescriptorUi]`), so the "N of M
    // publications tagged" lead needs no publications-index agg mock at all.
    reasonFromDoc: true,
    meshDescriptorUi: MICROBIOTA,
    meshDescriptorName: "Microbiota",
    // >1 entry is what arms `provenanceOn`; [0] is the parent by invariant.
    meshDescendantUis: [MICROBIOTA, MYCOBIOME],
    matchAwareContext: { methodFamily: null, topics: [] },
    ...extra,
  });
  return leadEvidence(result.hits[0]);
}

describe("searchPeople — #1955 `alsoParent` survives the hop into the evidence input", () => {
  it("parent AND descendant tagged ⇒ `alsoParent: true` on the counted `tagged` lead", async () => {
    const ev = await leadEvidenceFor({
      publicationMeshUi: [MICROBIOTA, MYCOBIOME],
      meshSubtreeCounts: { [MICROBIOTA]: 12 },
    });
    // The whole point of the field: this scholar carries the parent tag too, so the card
    // may say "also tagged Mycobiome" instead of claiming a route through the descendant.
    expect(ev).toMatchObject({
      kind: "publications",
      strength: "tagged",
      text: "12 of 200 publications tagged under",
      term: "Microbiota",
      descendantTerms: ["Mycobiome"],
      alsoParent: true,
    });
  });

  it("descendant ONLY ⇒ `alsoParent: false` on the same lead", async () => {
    const ev = await leadEvidenceFor({
      publicationMeshUi: [MYCOBIOME],
      meshSubtreeCounts: { [MICROBIOTA]: 12 },
    });
    expect(ev).toMatchObject({
      strength: "tagged",
      descendantTerms: ["Mycobiome"],
      alsoParent: false,
    });
  });

  it("the uncounted `concept` lead carries it too — the SECOND spread in search.ts", async () => {
    // No `meshSubtreeCounts` ⇒ tagged count 0 ⇒ the lead falls through to "via related
    // concept", which is the other place `search.ts` attaches the flag and the variant
    // where the wording has no count to lean on.
    const ev = await leadEvidenceFor({ publicationMeshUi: [MICROBIOTA, MYCOBIOME] });
    expect(ev).toMatchObject({
      kind: "publications",
      strength: "concept",
      text: "via related concept",
      term: "Microbiota",
      descendantTerms: ["Mycobiome"],
      alsoParent: true,
    });
  });
});

// #1959 — the below-gate parent set crosses TWO hops in `lib/api/search.ts` that no
// pure test can see: the `_source` include-list entry that ships the field, and the
// `belowThresholdMeshUi` argument that hands it to `computeMatchProvenance`. Delete
// either and the fix is a silent no-op with the whole suite green — the #1957 failure
// mode. This block is that coverage, asserted on what `searchPeople` emits and requests.
describe("searchPeople — #1959 the below-gate parent set survives both hops", () => {
  it("descendant kept + parent BELOW THE GATE ⇒ `alsoParent: true`", async () => {
    // The measured cohort: the parent sits on one middle-author pub, so the people-doc
    // gate dropped it from `publicationMeshUi` — while `meshSubtreeCounts` (ungated)
    // still counts that pub in the "12 of 200 tagged under Microbiota" lead.
    const ev = await leadEvidenceFor({
      publicationMeshUi: [MYCOBIOME],
      publicationMeshUiBelowThreshold: [MICROBIOTA],
      meshSubtreeCounts: { [MICROBIOTA]: 12 },
    });
    expect(ev).toMatchObject({
      kind: "publications",
      strength: "tagged",
      text: "12 of 200 publications tagged under",
      term: "Microbiota",
      descendantTerms: ["Mycobiome"],
      alsoParent: true,
    });
  });

  it("requests the field in the people `_source` when a concept resolved", async () => {
    await leadEvidenceFor({ publicationMeshUi: [MYCOBIOME] });
    const peopleCall = mockSearch.mock.calls.find(
      ([a]) => (a as { index?: string })?.index !== PUBLICATIONS_INDEX,
    );
    const body = (peopleCall?.[0] as { body: { _source: string[] } }).body;
    expect(body._source).toContain("publicationMeshUiBelowThreshold");
  });

  it("does NOT request it when no concept resolved — every other search keeps today's shape", async () => {
    process.env[EVIDENCE] = "on";
    await searchPeople({ q: "microbiome", relevanceMode: "v3" }); // no topic template, no descendants
    const peopleCall = mockSearch.mock.calls.find(
      ([a]) => (a as { index?: string })?.index !== PUBLICATIONS_INDEX,
    );
    const body = (peopleCall?.[0] as { body: { _source: string[] } }).body;
    expect(body._source).not.toContain("publicationMeshUiBelowThreshold");
  });

  it("still reads `alsoParent: false` on a pre-rebuild doc that lacks the field", async () => {
    const ev = await leadEvidenceFor({
      publicationMeshUi: [MYCOBIOME],
      meshSubtreeCounts: { [MICROBIOTA]: 12 },
    });
    expect(ev).toMatchObject({ strength: "tagged", alsoParent: false });
  });
});

// #1977 — the matcha spine widens `meshDescendantUis` to a cluster UNION so the boost
// spans merged synonyms, but the representative is the cluster's EARLIEST member, not its
// broadest. Everything past `[0]` gets rendered as a "narrower term" of the rep, so a
// sibling in the union becomes a false claim — beside a lead count that is the rep's own
// subtree and excludes those very papers. `meshProvenanceUis` keeps the two apart.
describe("searchPeople — #1977 provenance reads its own set, not the boost union", () => {
  const SIBLING = "D007943"; // in the union via a merged synonym; NOT under Microbiota
  /** `descendantTerms` off whichever evidence variant arrived — only `publications`
   *  declares it, and the point of these tests is that it must not be populated. */
  const descTerms = (ev: unknown) => (ev as { descendantTerms?: string[] })?.descendantTerms;

  it("does NOT name a union sibling as a narrower term", async () => {
    const ev = await leadEvidenceFor(
      { publicationMeshUi: [SIBLING], meshSubtreeCounts: { [MICROBIOTA]: 12 } },
      {
        meshDescendantUis: [MICROBIOTA, SIBLING], // boost spans the cluster
        meshProvenanceUis: [MICROBIOTA, MYCOBIOME], // wording sees the rep's subtree only
      },
    );
    // The scholar carries nothing in the rep's subtree, so there is no narrower term to
    // name and no parent tag either — the honest output names neither. Pre-fix this read
    // `descendantTerms: ["D007943"]`, i.e. a sibling billed as narrower than Microbiota.
    expect(descTerms(ev)).toBeUndefined();
  });

  it("still names a REAL descendant of the rep when the scholar carries one", async () => {
    const ev = await leadEvidenceFor(
      { publicationMeshUi: [MYCOBIOME, SIBLING], meshSubtreeCounts: { [MICROBIOTA]: 12 } },
      { meshDescendantUis: [MICROBIOTA, MYCOBIOME, SIBLING], meshProvenanceUis: [MICROBIOTA, MYCOBIOME] },
    );
    expect(ev).toMatchObject({ strength: "tagged", term: "Microbiota", alsoParent: false });
    // The sibling is carried and is in the boost set, but only the true descendant is named.
    expect(descTerms(ev)).toEqual(["Mycobiome"]);
  });

  it("a LEAF rep names nothing, but keeps its own direct-match explanation", async () => {
    // Surfaced by a surviving mutation: narrowing the provenance GATE to the rep's set
    // would also kill the `concept` variant here, which is correct and has nothing to do
    // with the union. So the gate still reads the boost set; only the naming moved.
    const ev = await leadEvidenceFor(
      { publicationMeshUi: [MICROBIOTA] }, // carries the rep itself, no subtree count
      { meshDescendantUis: [MICROBIOTA, MYCOBIOME, SIBLING], meshProvenanceUis: [MICROBIOTA] },
    );
    expect(ev).toMatchObject({ kind: "publications", strength: "concept", term: "Microbiota" });
    expect(descTerms(ev)).toBeUndefined();
  });
});

/**
 * The METHOD line's denominator (`methodPubCount`).
 *
 * The line read "11 of 923 publications used AAV gene-therapy vectors" with a 1.2% share,
 * where 923 is the scholar's TOTAL authored output. Method extraction covers 2020+ BY
 * DESIGN, so the numerator was drawn from a ~27-paper eligible pool and divided by a
 * 923-paper one — and at 1.2% the card's low-coverage rule then dimmed the scholar's
 * strongest signal. The honest line is "11 of 27 method-indexed publications", i.e. 41%.
 *
 * SPS stores no method-eligible count anywhere, so it is folded at query time from the
 * union of `ScholarFamily.pmids` over the scholar's publicly-visible families. The union
 * is load-bearing twice over: a SUM of `pmidCount` would double-count a paper that puts a
 * scholar in two families, and a MISSING `pmids` (the column is nullable and backfilled by
 * the full-replace ETL) must yield no denominator at all rather than a low one — a low
 * denominator INFLATES the percentage, which is worse than the bug it replaces.
 */
describe("methodIndexedPubCounts — the method line's denominator", () => {
  const OPEN: FamilyOverlayGate = { suppressed: new Set(), sensitive: new Set() };
  const row = (cwid: string, familyLabel: string, pmids: unknown, supercategory = "sequencing") => ({
    cwid,
    supercategory,
    familyLabel,
    pmids,
  });

  it("unions pmids across a scholar's families — a shared paper counts ONCE", () => {
    const counts = methodIndexedPubCounts(
      [
        row("el1", "Single-cell RNA sequencing", ["1", "2", "3"]),
        row("el1", "Confocal microscopy", ["3", "4"], "imaging"),
      ],
      OPEN,
    );
    // 4, not 5: pmid 3 puts this scholar in both families and is ONE publication.
    expect(counts.get("el1")).toBe(4);
  });

  it("a NULL pmids on a gate-visible family ⇒ NO denominator for that scholar", () => {
    // THE RULE THIS BLOCK EXISTS FOR. Returning 3 here would state a share against a pool
    // we know is incomplete, and a small denominator makes a thin match look like a
    // headline. The card degrades to the count alone instead — less, not wrong.
    const counts = methodIndexedPubCounts(
      [
        row("el1", "Single-cell RNA sequencing", ["1", "2", "3"]),
        row("el1", "Confocal microscopy", null, "imaging"),
      ],
      OPEN,
    );
    expect(counts.has("el1")).toBe(false);
  });

  it("a non-array pmids is UNKNOWN too, never empty", () => {
    // A JSON column can hold an object or a string as easily as an array. `Array.isArray`
    // is the only shape that can be counted; everything else is unknown, not zero.
    for (const bad of [{}, "1,2,3", 3, undefined]) {
      expect(methodIndexedPubCounts([row("el1", "F", bad)], OPEN).has("el1")).toBe(false);
    }
  });

  it("one scholar's unknown does not poison another's", () => {
    const counts = methodIndexedPubCounts([row("el1", "F", null), row("bo2", "F", ["1", "2"])], OPEN);
    expect(counts.has("el1")).toBe(false);
    expect(counts.get("bo2")).toBe(2);
  });

  it("a suppressed / sensitive family contributes NOTHING — not even to the denominator", () => {
    // An overlay-gated family must not surface on a public cross-scholar surface, and a
    // denominator IS a disclosure: a pool larger than the visible families account for
    // says a hidden family exists.
    const gate: FamilyOverlayGate = {
      suppressed: new Set([familyOverlayKey("sequencing", "Suppressed family")]),
      sensitive: new Set([familyOverlayKey("imaging", "Sensitive family")]),
    };
    const counts = methodIndexedPubCounts(
      [
        row("el1", "Single-cell RNA sequencing", ["1", "2"]),
        row("el1", "Suppressed family", ["3", "4"]),
        row("el1", "Sensitive family", ["5", "6"], "imaging"),
      ],
      gate,
    );
    expect(counts.get("el1")).toBe(2);
  });

  it("a suppressed family with a NULL pmids does not make the scholar unknown", () => {
    // The gate check runs FIRST. A row we are not allowed to read cannot be the reason we
    // withhold a denominator the visible rows fully account for.
    const gate: FamilyOverlayGate = {
      suppressed: new Set([familyOverlayKey("sequencing", "Suppressed family")]),
      sensitive: new Set<string>(),
    };
    const counts = methodIndexedPubCounts(
      [row("el1", "Single-cell RNA sequencing", ["1", "2"]), row("el1", "Suppressed family", null)],
      gate,
    );
    expect(counts.get("el1")).toBe(2);
  });

  it("an EMPTY union is not a denominator — a 0 would divide the share", () => {
    expect(methodIndexedPubCounts([row("el1", "F", [])], OPEN).has("el1")).toBe(false);
  });

  it("numeric and string pmids are the SAME publication", () => {
    // The artifact writes PMIDs as JSON numbers in some loads and strings in others; a Set
    // keyed on the raw value would count 33144353 twice and overstate the pool.
    expect(methodIndexedPubCounts([row("el1", "F", [33144353, "33144353"])], OPEN).get("el1")).toBe(1);
  });

  it("no rows ⇒ an empty map, never a zero entry", () => {
    expect(methodIndexedPubCounts([], OPEN).size).toBe(0);
  });
});

describe("searchPeople — methodPubCount on the hit", () => {
  /** Per-call routing: the DENOMINATOR query is the one that selects `pmids`. */
  const routeFamilyQueries = (familyRows: unknown[], memberRows: unknown[]) =>
    mockScholarFamilyFindMany.mockImplementation((args: { select?: Record<string, unknown> }) =>
      Promise.resolve(args?.select?.pmids ? memberRows : familyRows),
    );

  const runWithFamily = () =>
    searchPeople({
      q: "single cell rna sequencing",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: FAMILY, topics: [] },
    });

  const METHOD_ROW = { cwid: "el1", familyLabel: "Single-cell RNA sequencing", exemplarTools: [] };

  it("emits the UNION of the scholar's visible families, NOT their pubCount", async () => {
    process.env[EVIDENCE] = "on";
    routeFamilyQueries(
      [METHOD_ROW],
      [
        {
          cwid: "el1",
          supercategory: "sequencing",
          familyLabel: "Single-cell RNA sequencing",
          pmids: ["1", "2", "3"],
        },
        { cwid: "el1", supercategory: "imaging", familyLabel: "Confocal microscopy", pmids: ["3", "4"] },
      ],
    );
    const result = await runWithFamily();
    // The fixture scholar authored 200 publications; 4 of them are method-indexed.
    expect(result.hits[0].pubCount).toBe(200);
    expect(result.hits[0].methodPubCount).toBe(4);
  });

  it("a NULL pmids anywhere ⇒ the field is ABSENT, never a partial count", async () => {
    process.env[EVIDENCE] = "on";
    routeFamilyQueries(
      [METHOD_ROW],
      [
        {
          cwid: "el1",
          supercategory: "sequencing",
          familyLabel: "Single-cell RNA sequencing",
          pmids: ["1", "2", "3"],
        },
        { cwid: "el1", supercategory: "imaging", familyLabel: "Confocal microscopy", pmids: null },
      ],
    );
    const result = await runWithFamily();
    expect(result.hits[0].methodPubCount).toBeUndefined();
  });

  it("nobody on the page is in the resolved family ⇒ NO denominator query is issued", async () => {
    // The whole point of gating it: a page with no method line must cost exactly what it
    // costs today. If this regresses, every people search pays for a query it cannot use.
    process.env[EVIDENCE] = "on";
    mockScholarFamilyFindMany.mockResolvedValue([]);
    const result = await runWithFamily();
    expect(mockScholarFamilyFindMany).toHaveBeenCalledTimes(1);
    expect(mockScholarFamilyFindMany.mock.calls[0][0].select.pmids).toBeUndefined();
    expect(result.hits[0].methodPubCount).toBeUndefined();
  });

  it("no method family resolved ⇒ no query and no field", async () => {
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
    expect(mockScholarFamilyFindMany).not.toHaveBeenCalled();
    expect(result.hits[0].methodPubCount).toBeUndefined();
  });

  it("the denominator query is scoped to the page and to LIVE scholars, not to the family", async () => {
    process.env[EVIDENCE] = "on";
    routeFamilyQueries(
      [METHOD_ROW],
      [
        {
          cwid: "el1",
          supercategory: "sequencing",
          familyLabel: "Single-cell RNA sequencing",
          pmids: ["1"],
        },
      ],
    );
    await runWithFamily();
    const call = mockScholarFamilyFindMany.mock.calls.find((c) => c[0]?.select?.pmids);
    expect(call).toBeTruthy();
    const where = call![0].where;
    expect(where.cwid).toEqual({ in: ["el1"] });
    expect(where.scholar).toEqual({ deletedAt: null, status: "active" });
    // NOT filtered to the resolved family: `methodFamily` narrows the NUMERATOR, while the
    // denominator answers "how much of this scholar's output is method-indexed AT ALL".
    expect(where.familyLabel).toBeUndefined();
    expect(where.supercategory).toBeUndefined();
  });
});

// #1367 Gap 1 — the clinical evidence line's DISPLAY-ONLY on-topic pub count. Both
// `count` (`_source.clinicalOnTopicCounts[specialty]`) and `eligiblePubCount`
// (`_source.meshTaggedPubCount`) are read O(1) off the hit and forwarded onto the
// `clinical` evidence object; neither touches `selectEvidence`'s count-gated
// clinical-vs-tagged precedence (covered, unchanged, by `result-evidence-select.test.ts`).
describe("searchPeople — clinical evidence on-topic pub count (#1367 Gap 1)", () => {
  const CLINICAL_FLAG = "SEARCH_PEOPLE_CLINICAL_FN";

  afterEach(() => {
    delete process.env[CLINICAL_FLAG];
  });

  const runClinical = (source: Record<string, unknown>) => {
    process.env[EVIDENCE] = "on";
    process.env[CLINICAL_FLAG] = "on";
    hitSourcePatch = source;
    return searchPeople({
      q: "cardiology",
      relevanceMode: "v3",
      shape: "topic",
      matchAwareContext: { methodFamily: null, topics: [] },
    });
  };

  it("both fields present in `_source` ⇒ forwarded onto the clinical evidence", async () => {
    const result = await runClinical({
      clinicalSpecialties: ["Cardiology"],
      clinicalBoardSet: ["Cardiology"],
      clinicalOnTopicCounts: { Cardiology: 12 },
      meshTaggedPubCount: 340,
    });
    expect(result.hits[0].evidence).toEqual({
      kind: "clinical",
      specialty: "Cardiology",
      boardCertified: true,
      count: 12,
      eligiblePubCount: 340,
    });
  });

  it("neither field present ⇒ label-only clinical evidence, unchanged from today", async () => {
    const result = await runClinical({
      clinicalSpecialties: ["Cardiology"],
      clinicalBoardSet: ["Cardiology"],
    });
    expect(result.hits[0].evidence).toEqual({
      kind: "clinical",
      specialty: "Cardiology",
      boardCertified: true,
    });
  });

  it("the matched specialty has no entry in `clinicalOnTopicCounts` ⇒ no count (under-claim, not a 0)", async () => {
    const result = await runClinical({
      clinicalSpecialties: ["Cardiology"],
      clinicalBoardSet: ["Cardiology"],
      // A different specialty's count is present, but not this one's.
      clinicalOnTopicCounts: { Nephrology: 8 },
      meshTaggedPubCount: 340,
    });
    expect(result.hits[0].evidence).toEqual({
      kind: "clinical",
      specialty: "Cardiology",
      boardCertified: true,
    });
  });

  it("requests both fields in the people `_source` when SEARCH_PEOPLE_CLINICAL_FN is on", async () => {
    await runClinical({ clinicalSpecialties: ["Cardiology"], clinicalBoardSet: [] });
    const peopleCall = mockSearch.mock.calls.find(
      ([a]) => (a as { index?: string })?.index !== PUBLICATIONS_INDEX,
    );
    const body = (peopleCall?.[0] as { body: { _source: string[] } }).body;
    expect(body._source).toContain("clinicalOnTopicCounts");
    expect(body._source).toContain("meshTaggedPubCount");
  });

  it("does NOT request either field when the flag is off — every other search keeps today's `_source` shape", async () => {
    process.env[EVIDENCE] = "on";
    await searchPeople({ q: "cardiology", relevanceMode: "v3" });
    const peopleCall = mockSearch.mock.calls.find(
      ([a]) => (a as { index?: string })?.index !== PUBLICATIONS_INDEX,
    );
    const body = (peopleCall?.[0] as { body: { _source: string[] } }).body;
    expect(body._source).not.toContain("clinicalOnTopicCounts");
    expect(body._source).not.toContain("meshTaggedPubCount");
  });
});
