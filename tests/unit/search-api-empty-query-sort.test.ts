/**
 * #2228 — route-level coverage for the #1106/#1107 empty-query People default.
 *
 * `app/(public)/search/page.tsx` defaults the people tab to last-name A–Z when
 * `q` is empty; `app/api/search/route.ts` did not, so `/api/search?q=&type=people`
 * fell through to "relevance" — a `match_all` where every hit scores 1 — and
 * served index order under a label promising a ranking. Measured on prod:
 * total=8722, one distinct relevanceScore (1.0) across all 20 hits.
 *
 * Asserting the shared `EMPTY_QUERY_PEOPLE_SORT` constant alone would NOT protect
 * this: the defect was a missing branch at the call site, not a wrong value. These
 * tests drive the real route and read the `sort` that reaches `searchPeople`.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { EMPTY_QUERY_PEOPLE_SORT } from "@/lib/api/search-flags";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: { groupBy: vi.fn().mockResolvedValue([]) },
    topic: { findMany: vi.fn().mockResolvedValue([]) },
    subtopic: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    meshDescriptor: { findMany: vi.fn().mockResolvedValue([]) },
    etlRun: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

// The shape classifier is irrelevant to the sort default and otherwise reaches
// Prisma + OpenSearch for real (degrading noisily to empty sets).
vi.mock("@/lib/api/people-classifier-sets", () => ({
  getPeopleClassifierSets: vi.fn(async () => ({
    surnames: new Set<string>(),
    cwids: new Set<string>(),
    departments: new Set<string>(),
    divisions: new Map<string, string[]>(),
  })),
}));

const emptyPeopleResult = {
  hits: [],
  total: 0,
  page: 0,
  pageSize: 20,
  facets: {
    deptDivs: [],
    personTypes: [],
    activity: { hasGrants: 0, recentPub: 0 },
  },
};

vi.mock("@/lib/api/search", () => ({
  searchPeople: vi.fn(async () => emptyPeopleResult),
  searchPublications: vi.fn(async () => ({ hits: [], total: 0, page: 0, pageSize: 20 })),
  getConceptScholarConcentration: vi.fn(async () => null),
}));

/** Run the route and return the `sort` it handed `searchPeople`. */
async function sortFor(query: string): Promise<string | undefined> {
  const { searchPeople } = await import("@/lib/api/search");
  const spy = vi.mocked(searchPeople);
  spy.mockClear();
  const { GET } = await import("@/app/api/search/route");
  await GET(new NextRequest(`http://localhost/api/search?${query}`));
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0][0] as { sort?: string }).sort;
}

describe("#2228 — /api/search people sort agrees with the SSR page", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("empty query with no ?sort= defaults to last-name A–Z, not relevance", async () => {
    expect(await sortFor("q=&type=people")).toBe(EMPTY_QUERY_PEOPLE_SORT);
    // …and the constant is the page's value, so the two surfaces can't drift apart.
    expect(EMPTY_QUERY_PEOPLE_SORT).toBe("lastname");
  });

  it("an absent q param behaves the same as q= (both are the empty query)", async () => {
    expect(await sortFor("type=people")).toBe(EMPTY_QUERY_PEOPLE_SORT);
  });

  it("a NON-empty query still defaults to relevance — this is not a ranking change", async () => {
    expect(await sortFor("q=cancer&type=people")).toBe("relevance");
    expect(await sortFor("q=doe&type=people")).toBe("relevance");
  });

  it("an explicit ?sort= still wins on both the empty and non-empty query", async () => {
    expect(await sortFor("q=&type=people&sort=relevance")).toBe("relevance");
    expect(await sortFor("q=&type=people&sort=recentPub")).toBe("recentPub");
    expect(await sortFor("q=cancer&type=people&sort=lastname")).toBe("lastname");
  });
});
