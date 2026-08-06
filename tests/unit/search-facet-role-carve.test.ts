/**
 * #2267 — the #536 carve on the search facet hydrators (publications-tab author
 * facet, funding-tab investigator facet).
 *
 * These facets key on `wcmAuthorCwids` / the funding investigator agg, both of
 * which are built with NO role carve (lib/search-index-docs.ts:629-635), so the
 * aggregation hands the hydrator hidden identity classes and this hydration is
 * the only gate on the path. A facet chip renders name + headshot inside
 * PersonPopover, which mints a profile link — so an uncarved chip publishes a
 * hidden student by name.
 *
 * The carve is TWO halves and both are tested here, because either alone leaks:
 *   - `publicRoleWhere()` in the query — the population gate. A DENYLIST: it can
 *     only name the five values in HIDDEN_ROLE_CATEGORIES.
 *   - `isPubliclyDisplayed` on the raw column — the link gate. Prefix-matches
 *     `doctoral_student*` and fails CLOSED on anything unrecognized, which is
 *     what catches the out-of-band suffixes the denylist cannot enumerate.
 *
 * The fixtures below deliberately return a `doctoral_student_dds` row FROM the
 * mocked query — i.e. the exact row `publicRoleWhere()` admits — so the second
 * half is what has to reject it. Reverting either half turns a test red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scholarFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    scholar: { findMany: scholarFindMany },
    grant: { findMany: vi.fn().mockResolvedValue([]) },
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

const VISIBLE = "aaa9001";
const HIDDEN_BARE = "bbb9002"; // bare `doctoral_student` — the prod shape
const HIDDEN_SUFFIXED = "ccc9003"; // out-of-band suffix — denylist cannot name it

function authorBuckets() {
  return [
    { key: VISIBLE, doc_count: 12 },
    { key: HIDDEN_BARE, doc_count: 7 },
    { key: HIDDEN_SUFFIXED, doc_count: 3 },
  ];
}

/**
 * What the mocked Prisma returns. Note this INCLUDES both hidden rows: the test
 * is asserting the code's own filter, not the database's. `doctoral_student_dds`
 * is genuinely admitted by `publicRoleWhere()`, so returning it is faithful.
 */
function scholarRows() {
  return [
    { cwid: VISIBLE, preferredName: "Vera Visible", slug: "vera-visible", roleCategory: "full_time_faculty" },
    { cwid: HIDDEN_BARE, preferredName: "Hidden One", slug: "hidden-one", roleCategory: "doctoral_student" },
    { cwid: HIDDEN_SUFFIXED, preferredName: "Hidden Two", slug: "hidden-two", roleCategory: "doctoral_student_dds" },
  ];
}

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  FUNDING_INDEX: "scholars-funding",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10"],
  PUBLICATION_FIELD_BOOSTS: ["title^4"],
  FUNDING_FIELD_BOOSTS: ["title^4"],
  PUBLICATIONS_RESTRUCTURED_MSM: "2<-34%",
  searchClient: () => ({
    async search() {
      return {
        body: {
          hits: { total: { value: 3 }, hits: [] },
          aggregations: {
            publicationTypes: { keys: { buckets: [] } },
            journals: { keys: { buckets: [] } },
            wcmRoleFirst: { doc_count: 0 },
            wcmRoleSenior: { doc_count: 0 },
            wcmRoleMiddle: { doc_count: 0 },
            wcmAuthors: { keys: { buckets: authorBuckets() }, total: { value: 3 } },
            investigators: { keys: { buckets: authorBuckets() }, total: { value: 3 } },
            funders: { keys: { buckets: [] } },
            mechanisms: { keys: { buckets: [] } },
            departments: { keys: { buckets: [] } },
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

type FacetBucket = { cwid: string; displayName: string; slug: string; count: number };

const originalRecency = process.env.SEARCH_PUB_RELEVANCE_RECENCY;

beforeEach(() => {
  scholarFindMany.mockReset();
  scholarFindMany.mockResolvedValue(scholarRows());
  process.env.SEARCH_PUB_RELEVANCE_RECENCY = "off";
  vi.resetModules();
});

afterEach(() => {
  if (originalRecency === undefined) delete process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  else process.env.SEARCH_PUB_RELEVANCE_RECENCY = originalRecency;
});

/** The `where` handed to the facet-hydration findMany (the one selecting slug). */
function facetWhere(): Record<string, unknown> {
  const call = scholarFindMany.mock.calls.find((c) => {
    const arg = c[0] as { select?: Record<string, unknown> } | undefined;
    return arg?.select?.slug === true;
  });
  const arg = call?.[0] as { where?: Record<string, unknown> } | undefined;
  return arg?.where ?? {};
}

function assertRoleCarve(where: Record<string, unknown>) {
  const or = where.OR as Array<{ roleCategory: null | { notIn: string[] } }> | undefined;
  expect(or, "facet hydration must spread publicRoleWhere()").toBeDefined();
  // NULL admitted explicitly — `NULL NOT IN (...)` is NULL, not TRUE, so a bare
  // notIn would silently drop every un-backfilled scholar from the facet.
  expect(or).toContainEqual({ roleCategory: null });
  const notIn = or!.find((o) => o.roleCategory !== null)!.roleCategory as { notIn: string[] };
  expect(notIn.notIn).toContain("doctoral_student");
  expect(notIn.notIn).toContain("affiliate_alumni");
}

describe("#2267 — publications-tab author facet", () => {
  async function run(filters?: Record<string, unknown>) {
    const mod = (await import("@/lib/api/search")) as {
      searchPublications: (opts: unknown) => Promise<{
        facets: { wcmAuthors?: FacetBucket[] };
      }>;
    };
    return mod.searchPublications({ q: "cancer", page: 1, filters });
  }

  it("carves hidden roles at the QUERY layer, alongside deletedAt + status", async () => {
    await run();
    const where = facetWhere();
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe("active");
    assertRoleCarve(where);
  });

  it("selects roleCategory — without it no fail-closed guard is even possible", async () => {
    await run();
    const call = scholarFindMany.mock.calls.find((c) => {
      const arg = c[0] as { select?: Record<string, unknown> } | undefined;
      return arg?.select?.slug === true;
    });
    const arg = call?.[0] as { select?: Record<string, unknown> } | undefined;
    expect(arg?.select?.roleCategory).toBe(true);
  });

  it("drops a hidden author from the facet buckets even when the query returns it", async () => {
    const result = await run();
    const cwids = (result.facets.wcmAuthors ?? []).map((b) => b.cwid);
    expect(cwids).toContain(VISIBLE);
    expect(cwids).not.toContain(HIDDEN_BARE);
    // The one the denylist cannot name — this is the fail-closed half.
    expect(cwids).not.toContain(HIDDEN_SUFFIXED);
  });

  it("drops a hidden author from the PINNED selection path too (?wcmAuthor=<cwid>)", async () => {
    // The per-CWID vector: pinned selections hydrate regardless of top-500
    // bucket membership, so this path is a deterministic lookup, not a
    // ranking-dependent one. It must not become an identity oracle.
    const result = await run({ wcmAuthor: [HIDDEN_SUFFIXED] });
    const cwids = (result.facets.wcmAuthors ?? []).map((b) => b.cwid);
    expect(cwids).not.toContain(HIDDEN_SUFFIXED);
  });
});

describe("#2267 — funding-tab investigator facet", () => {
  async function run() {
    const mod = (await import("@/lib/api/search-funding")) as {
      searchFunding: (opts: unknown) => Promise<{
        facets: { investigators?: FacetBucket[] };
      }>;
    };
    return mod.searchFunding({ q: "cancer", page: 1 });
  }

  it("carves hidden roles at the query layer and drops them from the buckets", async () => {
    const result = await run();
    assertRoleCarve(facetWhere());
    const cwids = (result.facets.investigators ?? []).map((b) => b.cwid);
    expect(cwids).toContain(VISIBLE);
    expect(cwids).not.toContain(HIDDEN_BARE);
    expect(cwids).not.toContain(HIDDEN_SUFFIXED);
  });
});
