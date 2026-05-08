import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies the OpenSearch query body the funding port emits — multi-select
 * preserved on every axis, excluding-self facets, and hit hydration.
 *
 * The mock captures the request body so the test can assert against it
 * structurally rather than coupling to byte-for-byte output.
 */

let lastRequest: { index: string; body: Record<string, unknown> } | null = null;

vi.mock("@/lib/search", () => ({
  FUNDING_INDEX: "scholars-funding",
  FUNDING_FIELD_BOOSTS: ["title^4", "sponsorText^2", "peopleNames^1"],
  searchClient: () => ({
    async search(req: { index: string; body: Record<string, unknown> }) {
      lastRequest = req;
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
                },
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
