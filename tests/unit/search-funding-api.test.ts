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

vi.mock("@/lib/search", () => ({
  FUNDING_INDEX: "scholars-funding",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_FIELD_BOOSTS: ["title^4", "sponsorText^2", "peopleNames^1"],
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
                highlight: { title: ["A study of <mark>widgets</mark>"] },
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
        fields: ["title^4", "sponsorText^2", "peopleNames^1"],
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
  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
    else process.env.SEARCH_FUNDING_TAB_CONCEPT = original;
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
      fields: ["title^4", "sponsorText^2", "peopleNames^1"],
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

  it("leaves the query text-only when the flag is off (default)", async () => {
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

  it("propagates the concept clause into the excluding-self facet aggregations", async () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    await runSearch({
      q: "cancer",
      meshResolution: NEOPLASMS,
      filters: { funder: ["NCI"] },
    });
    // The funder agg re-applies the main `must` (now concept-wrapped) so its
    // admission count matches the main query — the reason the clause stays
    // inside `must` rather than a top-level should.
    const aggs = lastRequest!.body.aggs as Record<
      string,
      { filter: { bool: { must: unknown[] } } }
    >;
    expect(aggs.funders.filter.bool.must).toHaveLength(1);
    expect(aggs.funders.filter.bool.must[0]).toHaveProperty("bool");
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
    expect(highlight.fields.title).toEqual({ number_of_fragments: 0 });
    expect(highlight.highlight_query).toEqual({ match: { title: "cancer" } });
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
    delete process.env.SEARCH_FUNDING_MATCH_REASON;
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
