/**
 * Route-level `institution` param round-trip for the Publications and Funding
 * branches of /api/search, cloned from `search-api-institution-param.test.ts`
 * (the People branch). The search functions are mocked; this only asserts the
 * route hands the repeated `institution` param through to each tab's
 * `filters` object unchanged and records it in the `search_query` log.
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

vi.mock("@/lib/api/search", () => ({
  searchPeople: vi.fn(async () => ({ hits: [], total: 0, page: 0, pageSize: 20 })),
  searchPublications: vi.fn(async () => ({
    hits: [],
    total: 0,
    page: 0,
    pageSize: 20,
    queryShape: "text",
    facets: {},
  })),
  getConceptScholarConcentration: vi.fn(async () => null),
}));

vi.mock("@/lib/api/search-funding", () => ({
  searchFunding: vi.fn(async () => ({ hits: [], total: 0, page: 0, pageSize: 20, facets: {} })),
}));

async function runRoute(query: string) {
  const { GET } = await import("@/app/api/search/route");
  await GET(new NextRequest(`http://localhost/api/search?${query}`));
}

function searchQueryLog(logSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = logSpy.mock.calls.find((c) => {
    try {
      return JSON.parse(c[0] as string).event === "search_query";
    } catch {
      return false;
    }
  });
  expect(call, "expected a search_query log line").toBeDefined();
  return JSON.parse(call![0] as string);
}

describe("institution facet — /api/search param round-trip (publications + funding)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("publications: repeated institution params reach searchPublications.filters and the log", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runRoute("q=cancer&type=publications&institution=HSS&institution=MSKCC");
    const { searchPublications } = await import("@/lib/api/search");
    const spy = vi.mocked(searchPublications);
    expect(spy).toHaveBeenCalled();
    const filters = (spy.mock.calls[0][0] as { filters?: Record<string, unknown> }).filters;
    expect(filters?.institution).toEqual(["HSS", "MSKCC"]);
    const parsed = searchQueryLog(logSpy);
    logSpy.mockRestore();
    expect((parsed.filters as Record<string, unknown>).institution).toEqual(["HSS", "MSKCC"]);
  });

  it("funding: repeated institution params reach searchFunding.filters (absent → undefined)", async () => {
    await runRoute("q=cancer&type=funding&institution=HSS&institution=MSKCC");
    const { searchFunding } = await import("@/lib/api/search-funding");
    const spy = vi.mocked(searchFunding);
    expect(spy).toHaveBeenCalledTimes(1);
    const filters = (spy.mock.calls[0][0] as { filters?: Record<string, unknown> }).filters;
    expect(filters?.institution).toEqual(["HSS", "MSKCC"]);

    spy.mockClear();
    await runRoute("q=cancer&type=funding");
    const none = (spy.mock.calls[0][0] as { filters?: Record<string, unknown> }).filters;
    expect(none?.institution).toBeUndefined();
  });
});
