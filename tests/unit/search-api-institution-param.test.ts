/**
 * Route-level param round-trip for the `institution` People-search filter
 * (direct copy of `Scholar.primaryOrgCode`), mirroring the #2300
 * `professorialRank` route test.
 *
 * `lib/api/search.ts` is mocked out (its own filter-clause/facet behavior is
 * covered by `search-people-institution-filter.test.ts`); this file only
 * asserts `app/api/search/route.ts` parses the repeated `institution` URL
 * param the same way it parses `professorialRank` / `personType`, hands it
 * through to `searchPeople`'s `filters` object unchanged — the exact param
 * name a bookmarked/shared URL must use — and records it in the `search_query`
 * log's `filters` object.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
    pi: { none: 0, any: 0, active: 0, multi: 0 },
    isClinical: { true: 0, false: 0 },
    professorialRank: [],
    earlyStageInvestigator: { true: 0, false: 0 },
    institutions: [],
  },
};

vi.mock("@/lib/api/search", () => ({
  searchPeople: vi.fn(async () => emptyPeopleResult),
  searchPublications: vi.fn(async () => ({ hits: [], total: 0, page: 0, pageSize: 20 })),
  getConceptScholarConcentration: vi.fn(async () => null),
}));

/** Run the route; return the `filters` object it handed `searchPeople`. */
async function filtersFor(query: string): Promise<Record<string, unknown> | undefined> {
  const { searchPeople } = await import("@/lib/api/search");
  const spy = vi.mocked(searchPeople);
  spy.mockClear();
  const { GET } = await import("@/app/api/search/route");
  await GET(new NextRequest(`http://localhost/api/search?${query}`));
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0][0] as { filters?: Record<string, unknown> }).filters;
}

describe("institution facet — /api/search param round-trip", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("repeated institution params OR within the group, same as professorialRank", async () => {
    const filters = await filtersFor("q=doe&type=people&institution=HSS&institution=MSKCC");
    expect(filters?.institution).toEqual(["HSS", "MSKCC"]);
  });

  it("institution absent round-trips to undefined, not an empty array", async () => {
    expect((await filtersFor("q=doe&type=people"))?.institution).toBeUndefined();
  });

  it("search_query log carries filters.institution (codes, not names)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await filtersFor("q=doe&type=people&institution=HSS&institution=MSKCC");
    const call = logSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "search_query";
      } catch {
        return false;
      }
    });
    logSpy.mockRestore();
    expect(call, "expected a search_query log line").toBeDefined();
    const parsed = JSON.parse(call![0] as string);
    expect(parsed.filters.institution).toEqual(["HSS", "MSKCC"]);
  });
});
