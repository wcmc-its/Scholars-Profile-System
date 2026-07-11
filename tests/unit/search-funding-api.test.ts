import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

/**
 * Verifies the OpenSearch query body the funding port emits — multi-select
 * preserved on every axis, excluding-self facets, and hit hydration.
 *
 * The mock captures the request body so the test can assert against it
 * structurally rather than coupling to byte-for-byte output.
 */

// Issue #94 — the Investigator facet hydration looks up scholar names
// by CWID. Mock prisma so tests that exercise the hydration path don't
// require a live DB connection.
vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

let lastRequest: { index: string; body: Record<string, unknown> } | null = null;
const requests: Array<{ index: string; body: Record<string, unknown> }> = [];
/** PLAN P4 — funded-outputs pub-index agg response, keyed by projectId. The
 *  test sets this before a run; the mock returns it when the search hits the
 *  publications index. Empty → no funded-outputs counts. */
let pubAggByProject: Record<string, number> = {};

/** TIER 3 — override the `highlight` object on the funding hit the mock
 *  returns. `undefined` → the default title-only highlight. Tests set this to
 *  inject abstract/keywordsText/sponsorText fragments and assert the
 *  server-side `pickTextEvidence` output. */
let hitHighlightOverride:
  | { title?: string[]; abstract?: string[]; keywordsText?: string[]; sponsorText?: string[] }
  | undefined;

vi.mock("@/lib/search", () => ({
  FUNDING_INDEX: "scholars-funding",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_FIELD_BOOSTS: [
    "title^4",
    "sponsorText^2",
    "peopleNames^1",
    "abstract^1",
    "keywordsText^1",
  ],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search(req: { index: string; body: Record<string, unknown> }) {
      lastRequest = req;
      requests.push(req);
      // PLAN P4 — funded-outputs aggregation against the publications index.
      if (req.index === "scholars-publications") {
        return {
          body: {
            aggregations: {
              byProject: {
                buckets: Object.fromEntries(
                  Object.entries(pubAggByProject).map(([projectId, value]) => [
                    projectId,
                    { doc_count: value, d: { value } },
                  ]),
                ),
              },
            },
          },
        };
      }
      return {
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _source: {
                  projectId: "ACC-001",
                  title: "A study of widgets",
                  primeSponsor: "NCI",
                  primeSponsorRaw: "National Cancer Institute",
                  directSponsor: null,
                  isSubaward: false,
                  programType: "Grant",
                  mechanism: "R01",
                  nihIc: "NCI",
                  awardNumber: "R01 CA123456",
                  startDate: "2024-01-01T00:00:00.000Z",
                  endDate: "2027-01-01T00:00:00.000Z",
                  isMultiPi: false,
                  department: "Medicine",
                  totalPeople: 1,
                  people: [
                    {
                      cwid: "alice",
                      slug: "alice-aaron",
                      preferredName: "Alice Aaron",
                      role: "PI",
                    },
                  ],
                  pubCount: 3,
                  publications: [
                    { pmid: "111", title: "P1", journal: null, year: 2020, citationCount: 0, isLowerConfidence: false },
                    { pmid: "222", title: "P2", journal: null, year: 2021, citationCount: 0, isLowerConfidence: false },
                    { pmid: "333", title: "P3", journal: null, year: 2022, citationCount: 0, isLowerConfidence: false },
                  ],
                },
                highlight: hitHighlightOverride ?? {
                  title: ["A study of <mark>widgets</mark>"],
                },
                matched_queries: ["concept"],
              },
            ],
          },
          aggregations: {
            funders: { keys: { buckets: [{ key: "NCI", doc_count: 5 }] } },
            directFunders: { keys: { buckets: [] } },
            programTypes: {
              keys: { buckets: [{ key: "Grant", doc_count: 5 }] },
            },
            mechanisms: { keys: { buckets: [{ key: "R01", doc_count: 5 }] } },
            departments: {
              keys: { buckets: [{ key: "Medicine", doc_count: 5 }] },
            },
            roleBuckets: {
              keys: {
                buckets: [
                  { key: "PI", doc_count: 4 },
                  { key: "Multi-PI", doc_count: 1 },
                  { key: "Co-I", doc_count: 2 },
                ],
              },
            },
            statusActive: { doc_count: 3 },
            statusEndingSoon: { doc_count: 1 },
            statusRecentlyEnded: { doc_count: 1 },
          },
        },
      };
    },
  }),
}));

beforeEach(() => {
  lastRequest = null;
  requests.length = 0;
  pubAggByProject = {};
  hitHighlightOverride = undefined;
});
afterEach(() => {
  vi.clearAllMocks();
});

async function runSearch(opts: Parameters<typeof import("@/lib/api/search-funding").searchFunding>[0]) {
  const mod = await import("@/lib/api/search-funding");
  return mod.searchFunding(opts);
}

describe("searchFunding (OpenSearch)", () => {
  it("emits a multi_match against title + sponsorText + peopleNames when q is non-empty", async () => {
    await runSearch({ q: "widgets" });
    const must = (lastRequest!.body.query as { bool: { must: unknown[] } }).bool.must;
    expect(must).toHaveLength(1);
    expect(must[0]).toEqual({
      multi_match: {
        query: "widgets",
        fields: [
          "title^4",
          "sponsorText^2",
          "peopleNames^1",
          "abstract^1",
          "keywordsText^1",
        ],
        type: "best_fields",
      },
    });
  });

  it("falls back to match_all when q is empty", async () => {
    await runSearch({ q: "" });
    const must = (lastRequest!.body.query as { bool: { must: unknown[] } }).bool.must;
    expect(must).toEqual([{ match_all: {} }]);
  });

  it("preserves multi-select on funder via terms filter", async () => {
    await runSearch({ q: "", filters: { funder: ["NCI", "NHLBI"] } });
    const postFilter = (lastRequest!.body.post_filter as {
      bool: { filter: unknown[] };
    }).bool.filter;
    expect(postFilter).toContainEqual({
      terms: { primeSponsor: ["NCI", "NHLBI"] },
    });
  });

  it("preserves multi-select on investigator via terms filter on wcmInvestigatorCwids (issue #94)", async () => {
    await runSearch({
      q: "",
      filters: { investigator: ["alice", "bob"] },
    });
    const postFilter = (lastRequest!.body.post_filter as {
      bool: { filter: unknown[] };
    }).bool.filter;
    expect(postFilter).toContainEqual({
      terms: { wcmInvestigatorCwids: ["alice", "bob"] },
    });
  });

  it("emits an investigators agg with terms + cardinality, excluding-self (issue #94)", async () => {
    await runSearch({ q: "", filters: { investigator: ["alice"], funder: ["NCI"] } });
    const aggs = lastRequest!.body.aggs as Record<string, unknown>;
    expect(aggs.investigators).toBeDefined();
    const inv = aggs.investigators as {
      filter: { bool: { filter: unknown[] } };
      aggs: { keys: unknown; total: unknown };
    };
    // investigator axis is excluded from its own agg; funder IS included.
    expect(inv.filter.bool.filter).not.toContainEqual({
      terms: { wcmInvestigatorCwids: ["alice"] },
    });
    expect(inv.filter.bool.filter).toContainEqual({
      terms: { primeSponsor: ["NCI"] },
    });
    expect(inv.aggs.keys).toEqual({
      terms: { field: "wcmInvestigatorCwids", size: 500 },
    });
    expect(inv.aggs.total).toEqual({
      cardinality: { field: "wcmInvestigatorCwids", precision_threshold: 4000 },
    });
  });

  it("preserves multi-select on directFunder, mechanism, programType, department, role", async () => {
    await runSearch({
      q: "",
      filters: {
        directFunder: ["Duke", "Yale"],
        mechanism: ["R01", "U54"],
        programType: ["Grant", "Fellowship"],
        department: ["Medicine", "Surgery"],
        role: ["PI", "Co-I"],
      },
    });
    const postFilter = (lastRequest!.body.post_filter as {
      bool: { filter: unknown[] };
    }).bool.filter;
    expect(postFilter).toContainEqual({
      terms: { directSponsor: ["Duke", "Yale"] },
    });
    expect(postFilter).toContainEqual({ terms: { mechanism: ["R01", "U54"] } });
    expect(postFilter).toContainEqual({
      terms: { programType: ["Grant", "Fellowship"] },
    });
    expect(postFilter).toContainEqual({
      terms: { department: ["Medicine", "Surgery"] },
    });
    expect(postFilter).toContainEqual({ terms: { roles: ["PI", "Co-I"] } });
  });

  it("multi-select status OR-s the date ranges via bool/should", async () => {
    await runSearch({
      q: "",
      filters: { status: ["active", "ending_soon"] },
    });
    const postFilter = (lastRequest!.body.post_filter as {
      bool: { filter: unknown[] };
    }).bool.filter;
    const statusFilter = postFilter.find(
      (f) => typeof f === "object" && f !== null && "bool" in (f as object),
    ) as { bool: { should: unknown[]; minimum_should_match: number } };
    expect(statusFilter).toBeTruthy();
    expect(statusFilter.bool.minimum_should_match).toBe(1);
    expect(statusFilter.bool.should).toHaveLength(2);
  });

  it("does NOT include the funder filter inside the funder facet aggregation (excluding-self)", async () => {
    await runSearch({ q: "", filters: { funder: ["NCI"], programType: ["Grant"] } });
    const aggs = lastRequest!.body.aggs as Record<
      string,
      { filter: { bool: { filter: unknown[] } } }
    >;
    const funderAggFilter = aggs.funders.filter.bool.filter;
    // funder axis is excluded from its own agg; programType IS included.
    expect(funderAggFilter).not.toContainEqual({
      terms: { primeSponsor: ["NCI"] },
    });
    expect(funderAggFilter).toContainEqual({
      terms: { programType: ["Grant"] },
    });
  });

  it("does NOT include the status filter inside the status aggregations", async () => {
    await runSearch({
      q: "",
      filters: { status: ["active"], funder: ["NCI"] },
    });
    const aggs = lastRequest!.body.aggs as Record<
      string,
      { filter: { bool: { filter: unknown[] } } }
    >;
    // statusActive's filter chain includes the active range plus all
    // OTHER axes (funder), but not the status axis itself.
    const statusActiveFilter = aggs.statusActive.filter.bool.filter;
    const hasStatusBoolWrapper = statusActiveFilter.some(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        "bool" in (f as object) &&
        "should" in ((f as { bool: object }).bool as object),
    );
    expect(hasStatusBoolWrapper).toBe(false);
    expect(statusActiveFilter).toContainEqual({
      terms: { primeSponsor: ["NCI"] },
    });
  });

  it("hydrates a hit with isActive/status derived from endDate", async () => {
    const result = await runSearch({ q: "" });
    expect(result.hits[0].projectId).toBe("ACC-001");
    expect(result.hits[0].people[0].identityImageEndpoint).toContain("alice");
    // endDate 2027-01-01 with NCE grace → active in 2026
    expect(result.hits[0].isActive).toBe(true);
  });

  it("returns role bucket counts mapped to {pi, multiPi, coI}", async () => {
    const result = await runSearch({ q: "" });
    expect(result.facets.roles).toEqual({ pi: 4, multiPi: 1, coI: 2 });
  });

  it("returns status counts mapped from the per-bucket aggs", async () => {
    const result = await runSearch({ q: "" });
    expect(result.facets.status).toEqual({
      active: 3,
      endingSoon: 1,
      recentlyEnded: 1,
    });
  });

  it("includes track_total_hits so the count reflects the full dataset", async () => {
    await runSearch({ q: "" });
    expect(lastRequest!.body.track_total_hits).toBe(true);
  });

  it("emits an endDate-asc sort with a script that pins active first", async () => {
    await runSearch({ q: "", sort: "endDate" });
    const sort = lastRequest!.body.sort as Array<Record<string, unknown>>;
    expect(sort).toHaveLength(2);
    expect(sort[0]).toHaveProperty("_script");
    expect(sort[1]).toEqual({ endDate: "asc" });
  });
});

describe("searchFunding — issue #295 MeSH concept clause", () => {
  const original = process.env.SEARCH_FUNDING_TAB_CONCEPT;
  const reasonOriginal = process.env.SEARCH_FUNDING_MATCH_REASON;
  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
    // Isolate #295 concept admission from the P4 reason layer: with the reason
    // flag on (now the default) searchFunding tags the terms clause with
    // `_name` and fires a second pub-index request, so pin it off here.
    process.env.SEARCH_FUNDING_MATCH_REASON = "off";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
    else process.env.SEARCH_FUNDING_TAB_CONCEPT = original;
    if (reasonOriginal === undefined) delete process.env.SEARCH_FUNDING_MATCH_REASON;
    else process.env.SEARCH_FUNDING_MATCH_REASON = reasonOriginal;
  });

  const NEOPLASMS: MeshResolution = {
    descriptorUi: "D009369",
    name: "Neoplasms",
    matchedForm: "neoplasms",
    confidence: "exact",
    scopeNote: null,
    entryTerms: [],
    curatedTopicAnchors: [],
    descendantUis: ["D009369", "D001943"],
  };

  const textClause = {
    multi_match: {
      query: "cancer",
      fields: [
        "title^4",
        "sponsorText^2",
        "peopleNames^1",
        "abstract^1",
        "keywordsText^1",
      ],
      type: "best_fields",
    },
  };

  const mustOf = () =>
    (lastRequest!.body.query as { bool: { must: unknown[] } }).bool.must;

  it("wraps the text clause in an OR-of-evidence bool when the flag is on and q resolves", async () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    const must = mustOf();
    expect(must).toHaveLength(1);
    expect(must[0]).toEqual({
      bool: {
        should: [
          textClause,
          { terms: { meshDescriptorUi: ["D009369", "D001943"], boost: 4 } },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it("leaves the query text-only when the flag is off", async () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "off";
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    expect(mustOf()).toEqual([textClause]);
  });

  it("leaves the query text-only when the flag is on but q does not resolve", async () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    await runSearch({ q: "cancer", meshResolution: null });
    expect(mustOf()).toEqual([textClause]);
  });

  it("leaves the query text-only when the resolution's descendant set is empty", async () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    await runSearch({
      q: "cancer",
      meshResolution: { ...NEOPLASMS, descendantUis: [] },
    });
    expect(mustOf()).toEqual([textClause]);
  });

  it("#1411 — keeps the concept clause in the main query must; excluding-self aggs inherit it (no re-embed)", async () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    await runSearch({
      q: "cancer",
      meshResolution: NEOPLASMS,
      filters: { funder: ["NCI"] },
    });
    // The concept-wrapped admission lives in the MAIN query must (the reason the clause
    // stays inside `must` rather than a top-level should) ...
    const mainMust = mustOf();
    expect(mainMust).toHaveLength(1);
    expect(mainMust[0]).toHaveProperty("bool");
    // ... and the excluding-self aggs carry ONLY their filter — a top-level filter-agg
    // already runs inside that admission, so re-embedding it per agg is redundant.
    const aggs = lastRequest!.body.aggs as Record<
      string,
      { filter: { bool: Record<string, unknown> } }
    >;
    expect(aggs.funders.filter.bool).not.toHaveProperty("must");
    expect(aggs.funders.filter.bool).toHaveProperty("filter");
  });
});

describe("searchFunding — Tier 1 relevance gate (SEARCH_FUNDING_TAB_MSM)", () => {
  const original = process.env.SEARCH_FUNDING_TAB_MSM;
  const conceptOriginal = process.env.SEARCH_FUNDING_TAB_CONCEPT;
  const reasonOriginal = process.env.SEARCH_FUNDING_MATCH_REASON;
  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_TAB_MSM;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_TAB_MSM;
    else process.env.SEARCH_FUNDING_TAB_MSM = original;
    if (conceptOriginal === undefined) delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
    else process.env.SEARCH_FUNDING_TAB_CONCEPT = conceptOriginal;
    if (reasonOriginal === undefined) delete process.env.SEARCH_FUNDING_MATCH_REASON;
    else process.env.SEARCH_FUNDING_MATCH_REASON = reasonOriginal;
  });

  const NEOPLASMS: MeshResolution = {
    descriptorUi: "D009369",
    name: "Neoplasms",
    matchedForm: "neoplasms",
    confidence: "exact",
    scopeNote: null,
    entryTerms: [],
    curatedTopicAnchors: [],
    descendantUis: ["D009369", "D001943"],
  };

  const mustOf = () =>
    (lastRequest!.body.query as { bool: { must: unknown[] } }).bool.must;

  it("adds minimum_should_match + abstract^0.5 when the flag is on (and leaves the shared constant intact)", async () => {
    process.env.SEARCH_FUNDING_TAB_MSM = "on";
    await runSearch({ q: "natural language processing" });
    const must = mustOf();
    expect(must).toHaveLength(1);
    expect(must[0]).toEqual({
      multi_match: {
        query: "natural language processing",
        fields: [
          "title^4",
          "sponsorText^2",
          "peopleNames^1",
          "abstract^0.5",
          "keywordsText^1",
        ],
        type: "best_fields",
        operator: "or",
        minimum_should_match: "2<-34%",
      },
    });
  });

  it("emits a byte-identical-to-today multi_match when the flag is off", async () => {
    delete process.env.SEARCH_FUNDING_TAB_MSM;
    await runSearch({ q: "natural language processing" });
    const must = mustOf();
    expect(must).toHaveLength(1);
    expect(must[0]).toEqual({
      multi_match: {
        query: "natural language processing",
        fields: [
          "title^4",
          "sponsorText^2",
          "peopleNames^1",
          "abstract^1",
          "keywordsText^1",
        ],
        type: "best_fields",
      },
    });
  });

  it("does not touch the empty-query match_all path when the flag is on", async () => {
    process.env.SEARCH_FUNDING_TAB_MSM = "on";
    await runSearch({ q: "" });
    expect(mustOf()).toEqual([{ match_all: {} }]);
  });

  it("propagates the MSM gate through the #295 OR-of-evidence concept wrap", async () => {
    process.env.SEARCH_FUNDING_TAB_MSM = "on";
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    process.env.SEARCH_FUNDING_MATCH_REASON = "off";
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    const must = mustOf();
    expect(must).toHaveLength(1);
    const should = (must[0] as { bool: { should: unknown[] } }).bool.should;
    expect(should[0]).toEqual({
      multi_match: {
        query: "cancer",
        fields: [
          "title^4",
          "sponsorText^2",
          "peopleNames^1",
          "abstract^0.5",
          "keywordsText^1",
        ],
        type: "best_fields",
        operator: "or",
        minimum_should_match: "2<-34%",
      },
    });
  });
});

describe("searchFunding — PLAN P4 match-reason (funded outputs + named queries)", () => {
  const conceptOriginal = process.env.SEARCH_FUNDING_TAB_CONCEPT;
  const reasonOriginal = process.env.SEARCH_FUNDING_MATCH_REASON;
  beforeEach(() => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    process.env.SEARCH_FUNDING_MATCH_REASON = "on";
  });
  afterEach(() => {
    if (conceptOriginal === undefined) delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
    else process.env.SEARCH_FUNDING_TAB_CONCEPT = conceptOriginal;
    if (reasonOriginal === undefined) delete process.env.SEARCH_FUNDING_MATCH_REASON;
    else process.env.SEARCH_FUNDING_MATCH_REASON = reasonOriginal;
  });

  const NEOPLASMS: MeshResolution = {
    descriptorUi: "D009369",
    name: "Neoplasms",
    matchedForm: "neoplasms",
    confidence: "exact",
    scopeNote: null,
    entryTerms: [],
    curatedTopicAnchors: [],
    descendantUis: ["D009369", "D001943"],
  };

  const fundingRequest = () =>
    requests.find((req) => req.index === "scholars-funding")!;
  const pubRequest = () => requests.find((req) => req.index === "scholars-publications");

  it("tags the expanded concept terms clause with _name 'concept' (score-neutral)", async () => {
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    const must = (fundingRequest().body.query as { bool: { must: unknown[] } }).bool.must;
    const should = (must[0] as { bool: { should: unknown[] } }).bool.should;
    expect(should[1]).toEqual({
      terms: { meshDescriptorUi: ["D009369", "D001943"], boost: 4, _name: "concept" },
    });
  });

  it("tags the concept-only terms clause with _name 'concept'", async () => {
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS, scope: "concept" });
    const must = (fundingRequest().body.query as { bool: { must: unknown[] } }).bool.must;
    expect(must[0]).toEqual({
      terms: { meshDescriptorUi: ["D009369", "D001943"], _name: "concept" },
    });
  });

  it("adds a title highlight to the full-body funding query", async () => {
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    const highlight = fundingRequest().body.highlight as {
      fields: { title: unknown };
      highlight_query: unknown;
    };
    // Match-reason-only path (text-evidence OFF) keeps the original top-level
    // `highlight_query` + single `title` field shape. The per-field shape is
    // exercised ONLY under SEARCH_FUNDING_TEXT_EVIDENCE (Tier 3 describe block).
    // #1351 — with a concept resolved, the title highlight widens to a should of
    // [literal `match`, concept `match_phrase`] so a grant that matched on the
    // concept term marks it (not just the literal query).
    expect(highlight.fields.title).toEqual({ number_of_fragments: 0 });
    expect(highlight.highlight_query).toEqual({
      bool: {
        should: [{ match: { title: "cancer" } }, { match_phrase: { title: "Neoplasms" } }],
      },
    });
  });

  it("runs a per-project pub-index cardinality(pmid) agg over the funded pmids", async () => {
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    const body = pubRequest()!.body as {
      size: number;
      query: { bool: { filter: unknown[] } };
      aggs: { byProject: { filters: { filters: Record<string, unknown> }; aggs: unknown } };
    };
    expect(body.size).toBe(0);
    // Top-level filter: the union of funded pmids ∩ the resolved descendant set.
    expect(body.query.bool.filter).toContainEqual({ terms: { pmid: ["111", "222", "333"] } });
    expect(body.query.bool.filter).toContainEqual({
      terms: { meshDescriptorUi: ["D009369", "D001943"] },
    });
    // One named per-project filter scoped to that project's pmids; cardinality sub-agg.
    expect(body.aggs.byProject.filters.filters).toEqual({
      "ACC-001": { terms: { pmid: ["111", "222", "333"] } },
    });
    expect(body.aggs.byProject.aggs).toEqual({ d: { cardinality: { field: "pmid" } } });
  });

  it("emits matchedFundedPubs (X, distinct-pmid) capped at pubCount (Y)", async () => {
    pubAggByProject = { "ACC-001": 2 };
    const result = await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    expect(result.hits[0].matchedFundedPubs).toBe(2);
    expect(result.hits[0].pubCount).toBe(3);
  });

  it("caps X at Y when the agg over-counts vs the uncapped pubCount", async () => {
    pubAggByProject = { "ACC-001": 99 };
    const result = await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    // Math.min(X, pubCount) keeps "X of Y" coherent (PUB_LIST_CAP edge).
    expect(result.hits[0].matchedFundedPubs).toBe(3);
  });

  it("emits matchedConcept from matched_queries and matchedLiteralTitle + titleHighlight from the highlight", async () => {
    pubAggByProject = { "ACC-001": 1 };
    const result = await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    expect(result.hits[0].matchedConcept).toBe(true);
    expect(result.hits[0].matchedLiteralTitle).toBe(true);
    expect(result.hits[0].titleHighlight).toBe("A study of <mark>widgets</mark>");
  });

  it("skips the pub-index agg and emits zero/false reason fields when no concept resolved", async () => {
    const result = await runSearch({ q: "cancer", meshResolution: null });
    expect(pubRequest()).toBeUndefined();
    expect(result.hits[0].matchedFundedPubs).toBe(0);
    expect(result.hits[0].matchedConcept).toBe(false);
  });

  it("leaves the funding query body untagged when the reason flag is off (expanded non-regression)", async () => {
    process.env.SEARCH_FUNDING_MATCH_REASON = "off";
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    const must = (fundingRequest().body.query as { bool: { must: unknown[] } }).bool.must;
    const should = (must[0] as { bool: { should: unknown[] } }).bool.should;
    // No `_name`, no highlight, no pub-index agg → byte-identical to today's body.
    expect(should[1]).toEqual({
      terms: { meshDescriptorUi: ["D009369", "D001943"], boost: 4 },
    });
    expect(fundingRequest().body.highlight).toBeUndefined();
    expect(pubRequest()).toBeUndefined();
  });
});

describe("searchFunding — SEARCH_FUNDING_MESH_GATE (funded-pub MeSH gate)", () => {
  const conceptOriginal = process.env.SEARCH_FUNDING_TAB_CONCEPT;
  const gateOriginal = process.env.SEARCH_FUNDING_MESH_GATE;
  const reasonOriginal = process.env.SEARCH_FUNDING_MATCH_REASON;
  beforeEach(() => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    // Pin the reason layer off so the gate `terms` clause is untagged — this
    // block isolates the admission FIELD, not the `_name` provenance.
    process.env.SEARCH_FUNDING_MATCH_REASON = "off";
  });
  afterEach(() => {
    if (conceptOriginal === undefined) delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
    else process.env.SEARCH_FUNDING_TAB_CONCEPT = conceptOriginal;
    if (gateOriginal === undefined) delete process.env.SEARCH_FUNDING_MESH_GATE;
    else process.env.SEARCH_FUNDING_MESH_GATE = gateOriginal;
    if (reasonOriginal === undefined) delete process.env.SEARCH_FUNDING_MATCH_REASON;
    else process.env.SEARCH_FUNDING_MATCH_REASON = reasonOriginal;
  });

  const NEOPLASMS: MeshResolution = {
    descriptorUi: "D009369",
    name: "Neoplasms",
    matchedForm: "neoplasms",
    confidence: "exact",
    scopeNote: null,
    entryTerms: [],
    curatedTopicAnchors: [],
    descendantUis: ["D009369", "D001943"],
  };
  const mustOf = () =>
    (lastRequest!.body.query as { bool: { must: unknown[] } }).bool.must;

  it("gates concept-scope admission on meshDescriptorUi by default (byte-identical)", async () => {
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS, scope: "concept" });
    expect(mustOf()[0]).toEqual({
      terms: { meshDescriptorUi: ["D009369", "D001943"] },
    });
  });

  it("gates on fundedPubMeshUi when SEARCH_FUNDING_MESH_GATE=fundedPubMeshUi", async () => {
    process.env.SEARCH_FUNDING_MESH_GATE = "fundedPubMeshUi";
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS, scope: "concept" });
    expect(mustOf()[0]).toEqual({
      terms: { fundedPubMeshUi: ["D009369", "D001943"] },
    });
  });

  it("switches the expanded OR-clause admission field too", async () => {
    process.env.SEARCH_FUNDING_MESH_GATE = "fundedPubMeshUi";
    await runSearch({ q: "cancer", meshResolution: NEOPLASMS });
    const should = (mustOf()[0] as { bool: { should: unknown[] } }).bool.should;
    expect(should[1]).toEqual({
      terms: { fundedPubMeshUi: ["D009369", "D001943"], boost: 4 },
    });
  });
});

describe("searchFunding — TIER 2 phrase boost (SEARCH_FUNDING_PHRASE_BOOST)", () => {
  const original = process.env.SEARCH_FUNDING_PHRASE_BOOST;
  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_PHRASE_BOOST;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_PHRASE_BOOST;
    else process.env.SEARCH_FUNDING_PHRASE_BOOST = original;
  });

  const boolOf = () =>
    (lastRequest!.body.query as {
      bool: { must: unknown[]; should?: unknown[] };
    }).bool;

  // The lone multi_match the must should still hold under the flag — built
  // from the MOCK FUNDING_FIELD_BOOSTS (which omits abstract^1/keywordsText^1
  // mutations; the mock array IS the source of truth for the fields assertion).
  const TEXT_MUST = {
    multi_match: {
      query: "natural language processing",
      fields: [
        "title^4",
        "sponsorText^2",
        "peopleNames^1",
        "abstract^1",
        "keywordsText^1",
      ],
      type: "best_fields",
    },
  };

  it("adds a phrase should-clause (title^6 + abstract^2) when the flag is on and q is non-empty", async () => {
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "on";
    await runSearch({ q: "natural language processing" });
    const should = boolOf().should;
    expect(should).toContainEqual({
      match_phrase: { title: { query: "natural language processing", boost: 6 } },
    });
    expect(should).toContainEqual({
      match_phrase: { abstract: { query: "natural language processing", boost: 2 } },
    });
  });

  it("leaves admission (the must array) byte-identical when the flag is on — the should never leaks into must, and no minimum_should_match is introduced", async () => {
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "on";
    await runSearch({ q: "natural language processing" });
    const bool = boolOf();
    expect(bool.must).toEqual([TEXT_MUST]);
    expect(bool).not.toHaveProperty("minimum_should_match");
  });

  it("keeps the phrase should out of every excluding-self facet aggregation (#1411 filter-only) when the flag is on — ranking-only contract", async () => {
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "on";
    await runSearch({ q: "natural language processing", filters: { funder: ["NCI"] } });
    const aggs = lastRequest!.body.aggs as Record<string, { filter: { bool: Record<string, unknown> } }>;
    for (const key of [
      "funders",
      "directFunders",
      "programTypes",
      "mechanisms",
      "departments",
      "roleBuckets",
      "investigators",
    ]) {
      // #1411 — the agg carries ONLY its excluding-self `filter`; the admission `must`
      // (and therefore never the ranking-only phrase `should`) is inherited from the
      // main-query scope this filter-agg runs in.
      expect(aggs[key].filter.bool).not.toHaveProperty("should");
      expect(aggs[key].filter.bool).not.toHaveProperty("must");
      expect(aggs[key].filter.bool).toHaveProperty("filter");
    }
  });

  it("is byte-identical to today when the flag is off (default) — no should key, lone multi_match must", async () => {
    delete process.env.SEARCH_FUNDING_PHRASE_BOOST;
    await runSearch({ q: "natural language processing" });
    const bool = boolOf();
    expect(bool.should).toBeUndefined();
    expect(bool.must).toEqual([TEXT_MUST]);
  });

  it("emits no should-clause when the flag is on but q is empty (a phrase on match_all is meaningless)", async () => {
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "on";
    await runSearch({ q: "" });
    const bool = boolOf();
    expect(bool.must).toEqual([{ match_all: {} }]);
    expect(bool.should).toBeUndefined();
  });

  it("does not add a should-clause to the countOnly body when the flag is on — tab-badge total stays must-only", async () => {
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "on";
    await runSearch({ q: "natural language processing", countOnly: true });
    const bool = boolOf();
    expect(bool.must).toEqual([TEXT_MUST]);
    expect(bool.should).toBeUndefined();
  });
});

describe("searchFunding — TIER 3 text-hit evidence (SEARCH_FUNDING_TEXT_EVIDENCE)", () => {
  const original = process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
  const reasonOriginal = process.env.SEARCH_FUNDING_MATCH_REASON;
  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
    else process.env.SEARCH_FUNDING_TEXT_EVIDENCE = original;
    if (reasonOriginal === undefined) delete process.env.SEARCH_FUNDING_MATCH_REASON;
    else process.env.SEARCH_FUNDING_MATCH_REASON = reasonOriginal;
  });

  type Highlight = {
    fields: Record<string, { number_of_fragments?: number; highlight_query?: unknown }>;
    pre_tags?: string[];
    post_tags?: string[];
  };
  const highlightOf = () => lastRequest!.body.highlight as Highlight | undefined;

  it("requests abstract/keywordsText/sponsorText highlights only when the flag is on", async () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "on";
    await runSearch({ q: "widgets" });
    const hl = highlightOf()!;
    expect(hl.fields.abstract).toEqual({
      number_of_fragments: 1,
      highlight_query: { match: { abstract: "widgets" } },
    });
    expect(hl.fields.keywordsText).toEqual({
      number_of_fragments: 1,
      highlight_query: { match: { keywordsText: "widgets" } },
    });
    expect(hl.fields.sponsorText).toEqual({
      number_of_fragments: 1,
      highlight_query: { match: { sponsorText: "widgets" } },
    });
    expect(hl.pre_tags).toEqual(["<mark>"]);
    expect(hl.post_tags).toEqual(["</mark>"]);
  });

  it("does not request the text-evidence highlight fields when the flag is off (title-only under match-reason)", async () => {
    delete process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
    // match-reason defaults on → a title-only highlight is requested.
    await runSearch({ q: "widgets" });
    const hl = highlightOf()!;
    expect(Object.keys(hl.fields)).toEqual(["title"]);
    expect(hl.fields.abstract).toBeUndefined();
    expect(hl.fields.keywordsText).toBeUndefined();
    expect(hl.fields.sponsorText).toBeUndefined();
  });

  it("omits the highlight key entirely when BOTH gates are off and q is present", async () => {
    delete process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
    process.env.SEARCH_FUNDING_MATCH_REASON = "off";
    await runSearch({ q: "widgets" });
    expect(highlightOf()).toBeUndefined();
  });

  it("requests no highlight when the flag is on but q is empty (no text to mark)", async () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "on";
    process.env.SEARCH_FUNDING_MATCH_REASON = "off";
    await runSearch({ q: "" });
    expect(highlightOf()).toBeUndefined();
  });

  it("emits textEvidence on a hit when an abstract highlight fragment is returned (flag on)", async () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "on";
    hitHighlightOverride = {
      abstract: ["a study of fancy <mark>widgets</mark> and gadgets"],
    };
    const result = await runSearch({ q: "widgets" });
    expect(result.hits[0].textEvidence).toEqual({
      field: "abstract",
      snippet: "a study of fancy <mark>widgets</mark> and gadgets",
    });
  });

  it("clamps a long abstract fragment mark-aware (no literal '<mark>' leak, one balanced mark)", async () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "on";
    hitHighlightOverride = {
      abstract: ["x ".repeat(120) + "<mark>widgets</mark>" + " y".repeat(120)],
    };
    const result = await runSearch({ q: "widgets" });
    const ev = result.hits[0].textEvidence!;
    expect(ev.field).toBe("abstract");
    // exactly one balanced mark, never a truncated tag
    expect((ev.snippet.match(/<mark>/g) ?? []).length).toBe(1);
    expect((ev.snippet.match(/<\/mark>/g) ?? []).length).toBe(1);
    expect(ev.snippet).toContain("<mark>widgets</mark>");
    // visible length bounded by the budget (TEXT_EVIDENCE_MAX_LEN=160) + region
    expect(ev.snippet.replace(/<\/?mark>/g, "").length).toBeLessThanOrEqual(160 + "widgets".length);
  });

  it("prefers abstract over keyword over sponsor when several fields highlight", async () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "on";
    hitHighlightOverride = {
      abstract: ["the <mark>widgets</mark> abstract"],
      keywordsText: ["<mark>widgets</mark> keyword"],
      sponsorText: ["<mark>widgets</mark> sponsor"],
    };
    const result = await runSearch({ q: "widgets" });
    expect(result.hits[0].textEvidence?.field).toBe("abstract");
  });

  it("skips a text field whose first fragment has no mark, falling through to the next", async () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "on";
    hitHighlightOverride = {
      abstract: ["an unmarked abstract fragment"],
      keywordsText: ["<mark>widgets</mark> keyword"],
    };
    const result = await runSearch({ q: "widgets" });
    expect(result.hits[0].textEvidence).toEqual({
      field: "keywordsText",
      snippet: "<mark>widgets</mark> keyword",
    });
  });

  it("textEvidence is null when the flag is off even if the index returns a text fragment (server-side gating)", async () => {
    delete process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
    hitHighlightOverride = {
      abstract: ["a study of fancy <mark>widgets</mark> and gadgets"],
    };
    const result = await runSearch({ q: "widgets" });
    expect(result.hits[0].textEvidence).toBeNull();
  });
});
