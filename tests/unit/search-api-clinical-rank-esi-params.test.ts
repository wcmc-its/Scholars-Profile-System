/**
 * #2300 / #2306 — route-level param round-trip for the `isClinical` /
 * `professorialRank` / `earlyStageInvestigator` People-search filters.
 *
 * `lib/api/search.ts` is mocked out (its own filter-clause/facet behavior is
 * covered by `search-people-clinical-rank-esi-filters.test.ts`); this file
 * only asserts `app/api/search/route.ts` parses the three URL params the
 * same way it parses `personType` / `activity` and hands them through to
 * `searchPeople`'s `filters` object unchanged — the exact param names a
 * bookmarked/shared URL must use.
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
  },
};

vi.mock("@/lib/api/search", () => ({
  searchPeople: vi.fn(async () => emptyPeopleResult),
  searchPublications: vi.fn(async () => ({ hits: [], total: 0, page: 0, pageSize: 20 })),
  getConceptScholarConcentration: vi.fn(async () => null),
}));

/** Run the route and return the `filters` object it handed `searchPeople`. */
async function filtersFor(query: string): Promise<Record<string, unknown> | undefined> {
  const { searchPeople } = await import("@/lib/api/search");
  const spy = vi.mocked(searchPeople);
  spy.mockClear();
  const { GET } = await import("@/app/api/search/route");
  await GET(new NextRequest(`http://localhost/api/search?${query}`));
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0][0] as { filters?: Record<string, unknown> }).filters;
}

describe("#2300/#2306 — /api/search param round-trip", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("isClinical=true round-trips to filters.isClinical === true", async () => {
    const filters = await filtersFor("q=doe&type=people&isClinical=true");
    expect(filters?.isClinical).toBe(true);
  });

  it("isClinical absent (or any non-'true' value) round-trips to undefined, mirroring includeIncomplete's convention", async () => {
    expect((await filtersFor("q=doe&type=people"))?.isClinical).toBeUndefined();
    expect((await filtersFor("q=doe&type=people&isClinical=false"))?.isClinical).toBeUndefined();
  });

  it("repeated professorialRank params OR within the group, same as personType", async () => {
    const filters = await filtersFor(
      "q=doe&type=people&professorialRank=Professor&professorialRank=Associate+Professor",
    );
    expect(filters?.professorialRank).toEqual(["Professor", "Associate Professor"]);
  });

  it("professorialRank absent round-trips to undefined, not an empty array", async () => {
    expect((await filtersFor("q=doe&type=people"))?.professorialRank).toBeUndefined();
  });

  it("earlyStageInvestigator=true round-trips to filters.earlyStageInvestigator === true — the param is NOT named 'esi'", async () => {
    const filters = await filtersFor("q=doe&type=people&earlyStageInvestigator=true");
    expect(filters?.earlyStageInvestigator).toBe(true);
    // A bare `esi` param must NOT be read (no-bare-ESI-in-URLs rule).
    const esiFilters = await filtersFor("q=doe&type=people&esi=true");
    expect(esiFilters?.earlyStageInvestigator).toBeUndefined();
  });
});
