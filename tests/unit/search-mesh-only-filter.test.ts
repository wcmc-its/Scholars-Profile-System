/**
 * Issue #396 — Publications-tab "Show only MeSH-tagged matches" query builder.
 *
 * Captures the body `searchPublications` sends to OpenSearch and asserts:
 *   - `resolvePublicationMeshOnlyFilter()` reads the `SEARCH_PUB_MESH_ONLY_FILTER`
 *     env flag;
 *   - with `filters.meshOnly === true` the body carries
 *     `query.bool.filter` containing `{ exists: { field: "meshDescriptorUi" } }`
 *     — a HARD query filter (NOT a post_filter / user-axis clause), so the
 *     countOnly badge, total, hits, and top-level facet aggs are all restricted;
 *   - with `meshOnly` falsy the body is byte-identical to the no-mesh case (the
 *     `filter` key is ABSENT from `query.bool`) — the off-is-inert guarantee.
 *
 * Reuses the body-capture harness from search-pub-department-filter.test.ts (it
 * mocks `searchClient` and pushes each request body). The mesh predicate is
 * GATED UPSTREAM (route/page only set `meshOnly` when the flag is on), so this
 * file asserts the builder's behavior given the `meshOnly` filter directly.
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
  EMPTY_MENTORING_BUCKETS: {
    all: [],
    byProgram: { md: [], mdphd: [], phd: [], postdoc: [], ecr: [] },
  },
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

/** The `query.bool` object the function sends (pre-`function_score`, so the
 *  recency tilt must be pinned off — see the beforeEach below). */
function queryBool(body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query as { bool?: Record<string, unknown> } | undefined;
  return query?.bool ?? {};
}

/** The mesh `exists` clause inside `query.bool.filter`, or undefined. */
function meshExistsClause(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const filter = queryBool(body).filter as Record<string, unknown>[] | undefined;
  return (filter ?? []).find(
    (c) =>
      "exists" in c &&
      (c.exists as Record<string, unknown>).field === "meshDescriptorUi",
  );
}

const originalRecency = process.env.SEARCH_PUB_RELEVANCE_RECENCY;
const originalFlag = process.env.SEARCH_PUB_MESH_ONLY_FILTER;

beforeEach(() => {
  capturedBodies.length = 0;
  vi.resetModules();
  // The recency tilt wraps body.query in a function_score; pin it off so this
  // file reasons about the raw `query.bool` (unaffected by the tilt).
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
});

afterEach(() => {
  if (originalRecency === undefined) delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  else process.env.SEARCH_PUB_RELEVANCE_RECENCY = originalRecency;
  if (originalFlag === undefined) delete process.env.SEARCH_PUB_MESH_ONLY_FILTER;
  else process.env.SEARCH_PUB_MESH_ONLY_FILTER = originalFlag;
});

type SP = (opts: unknown) => Promise<{ total: number }>;

describe("resolvePublicationMeshOnlyFilter — SEARCH_PUB_MESH_ONLY_FILTER", () => {
  it("returns true only when the env flag is exactly 'on'", async () => {
    const flags = await import("@/lib/api/search-flags");

    process.env.SEARCH_PUB_MESH_ONLY_FILTER = "on";
    expect(flags.resolvePublicationMeshOnlyFilter()).toBe(true);

    process.env.SEARCH_PUB_MESH_ONLY_FILTER = "off";
    expect(flags.resolvePublicationMeshOnlyFilter()).toBe(false);

    delete process.env.SEARCH_PUB_MESH_ONLY_FILTER;
    expect(flags.resolvePublicationMeshOnlyFilter()).toBe(false);

    // Any non-"on" value is off (default-off gate).
    process.env.SEARCH_PUB_MESH_ONLY_FILTER = "true";
    expect(flags.resolvePublicationMeshOnlyFilter()).toBe(false);
  });
});

describe("pub-tab MeSH-only filter — query builder (#396)", () => {
  it("meshOnly: true adds the exists clause to query.bool.filter (HARD filter)", async () => {
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    await searchPublications({
      q: "cancer",
      page: 0,
      filters: { meshOnly: true },
    });
    const body = capturedBodies[0];
    const clause = meshExistsClause(body);
    expect(clause).toBeDefined();
    expect(clause).toEqual({ exists: { field: "meshDescriptorUi" } });
    // The clause is the ONLY entry of query.bool.filter, and it lives on the
    // MAIN query (not post_filter / user-axis).
    expect((queryBool(body).filter as unknown[]).length).toBe(1);
    const pf = body.post_filter as
      | { bool?: { filter?: Record<string, unknown>[] } }
      | undefined;
    const pfClauses = pf?.bool?.filter ?? [];
    expect(
      pfClauses.some(
        (c) =>
          "exists" in c &&
          (c.exists as Record<string, unknown>)?.field === "meshDescriptorUi",
      ),
    ).toBe(false);
  });

  it("meshOnly: true also restricts the countOnly badge body (same query)", async () => {
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    await searchPublications({
      q: "cancer",
      page: 0,
      filters: { meshOnly: true },
      countOnly: true,
    } as unknown);
    // countOnly serializes `query` directly (size:0) — the clause must be there
    // so the tab badge equals a full mesh-only search.
    expect(meshExistsClause(capturedBodies[0])).toBeDefined();
  });

  it("meshOnly falsy: body is byte-identical (no query.bool.filter key)", async () => {
    const { searchPublications } = (await import("@/lib/api/search")) as {
      searchPublications: SP;
    };
    // Baseline: no meshOnly at all.
    await searchPublications({ q: "cancer", page: 0 });
    const baseline = JSON.stringify(capturedBodies[0]);
    expect(meshExistsClause(capturedBodies[0])).toBeUndefined();
    // The `filter` key must be ABSENT from query.bool (the spread-conditionally
    // byte-identical guarantee), not present-but-empty.
    expect("filter" in queryBool(capturedBodies[0])).toBe(false);

    // meshOnly: false / undefined produce the same body as the baseline.
    capturedBodies.length = 0;
    await searchPublications({ q: "cancer", page: 0, filters: { meshOnly: false } });
    expect(JSON.stringify(capturedBodies[0])).toBe(baseline);

    capturedBodies.length = 0;
    await searchPublications({ q: "cancer", page: 0, filters: { meshOnly: undefined } });
    expect(JSON.stringify(capturedBodies[0])).toBe(baseline);
  });
});
