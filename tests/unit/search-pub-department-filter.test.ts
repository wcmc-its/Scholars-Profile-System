/**
 * Issue #837 — Publications-tab Department facet query builder.
 *
 * Captures the body `searchPublications` sends to OpenSearch and asserts:
 *   - the `wcmAuthorDepartments` post_filter clause is present ONLY when the
 *     `department` filter is set AND `SEARCH_PUB_DEPARTMENT_FILTER=on`;
 *   - the `departments` terms aggregation is present ONLY when the flag is on;
 *   - the mapped `facets.departments` buckets reflect the aggregation result;
 *   - flag-off (default) leaves the body byte-equivalent to today (no
 *     department clause, no department agg) even with a `department` param.
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
  fetchAuthorBylineForPmids: vi.fn().mockResolvedValue(new Map()),
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
      const hasDeptAgg = !!(req.body.aggs as Record<string, unknown>)?.departments;
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
            // Only echo a department agg result when the body actually asked
            // for one, so the off-flag mapping is exercised too.
            ...(hasDeptAgg
              ? {
                  departments: {
                    keys: {
                      buckets: [
                        { key: "MED", doc_count: 7 },
                        { key: "name:Anesthesiology", doc_count: 2 },
                      ],
                    },
                  },
                }
              : {}),
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

/** post_filter user-axis clauses, or [] when there's no post_filter. */
function postFilterClauses(body: Record<string, unknown>): Record<string, unknown>[] {
  const pf = body.post_filter as { bool?: { filter?: Record<string, unknown>[] } } | undefined;
  return pf?.bool?.filter ?? [];
}

function deptClause(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return postFilterClauses(body).find(
    (c) => "terms" in c && (c.terms as Record<string, unknown>).wcmAuthorDepartments !== undefined,
  );
}

// The recency tilt wraps body.query in a function_score; pin it off so this
// file reasons only about post_filter / aggs (unaffected by the tilt).
const originalRecency = process.env.SEARCH_PUB_RELEVANCE_RECENCY;
const originalDeptFlag = process.env.SEARCH_PUB_DEPARTMENT_FILTER;

beforeEach(() => {
  capturedBodies.length = 0;
  vi.resetModules();
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
});

afterEach(() => {
  if (originalRecency === undefined) delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  else process.env.SEARCH_PUB_RELEVANCE_RECENCY = originalRecency;
  if (originalDeptFlag === undefined) delete process.env.SEARCH_PUB_DEPARTMENT_FILTER;
  else process.env.SEARCH_PUB_DEPARTMENT_FILTER = originalDeptFlag;
});

type SP = (opts: unknown) => Promise<{
  facets: { departments: Array<{ value: string; count: number }> };
}>;

describe("pub-tab Department facet — SEARCH_PUB_DEPARTMENT_FILTER", () => {
  it("flag ON + department param: adds the wcmAuthorDepartments post_filter clause", async () => {
    process.env.SEARCH_PUB_DEPARTMENT_FILTER = "on";
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    await searchPublications({
      q: "cancer",
      page: 0,
      filters: { department: ["MED", "PEDS"] },
    });
    const body = capturedBodies[0];
    const clause = deptClause(body);
    expect(clause).toBeDefined();
    expect((clause!.terms as Record<string, unknown>).wcmAuthorDepartments).toEqual([
      "MED",
      "PEDS",
    ]);
  });

  it("flag ON + department param: adds the departments terms aggregation", async () => {
    process.env.SEARCH_PUB_DEPARTMENT_FILTER = "on";
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    await searchPublications({
      q: "cancer",
      page: 0,
      filters: { department: ["MED"] },
    });
    const aggs = capturedBodies[0].aggs as Record<string, unknown>;
    const deptAgg = aggs.departments as { aggs: { keys: { terms: { field: string } } } };
    expect(deptAgg).toBeDefined();
    expect(deptAgg.aggs.keys.terms.field).toBe("wcmAuthorDepartments");
  });

  it("flag ON: the departments agg runs even with NO department selection (facet rail seed)", async () => {
    process.env.SEARCH_PUB_DEPARTMENT_FILTER = "on";
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    const result = await searchPublications({ q: "cancer", page: 0 });
    // No selection → no department post_filter clause...
    expect(deptClause(capturedBodies[0])).toBeUndefined();
    // ...but the aggregation still computes the rail.
    expect((capturedBodies[0].aggs as Record<string, unknown>).departments).toBeDefined();
    // ...and the mapped facet carries the echoed buckets.
    expect(result.facets.departments).toEqual([
      { value: "MED", count: 7 },
      { value: "name:Anesthesiology", count: 2 },
    ]);
  });

  it("flag OFF (default): no department clause, no department agg, empty facet", async () => {
    delete process.env.SEARCH_PUB_DEPARTMENT_FILTER;
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    // A stale `?department=` param must be inert when the flag is off.
    const result = await searchPublications({
      q: "cancer",
      page: 0,
      filters: { department: ["MED"] },
    });
    expect(deptClause(capturedBodies[0])).toBeUndefined();
    expect((capturedBodies[0].aggs as Record<string, unknown>).departments).toBeUndefined();
    expect(result.facets.departments).toEqual([]);
  });

  it("flag ON but empty department selection: no department post_filter clause", async () => {
    process.env.SEARCH_PUB_DEPARTMENT_FILTER = "on";
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    await searchPublications({ q: "cancer", page: 0, filters: { department: [] } });
    expect(deptClause(capturedBodies[0])).toBeUndefined();
  });
});
