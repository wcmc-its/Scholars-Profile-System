/**
 * Unit tests for ANALYTICS-02 (server side): search_query structured log.
 *
 * RED phase — tests target console.log output that does not yet exist in
 * app/api/search/route.ts. Tests MUST FAIL until Task 2 inserts the structured
 * log calls.
 *
 * Log shape: { event: "search_query", q, type, resultCount, filters, ts: ISO8601 }
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Mock @/lib/db (used transitively by search module for topic pre-filter).
vi.mock("@/lib/db", () => ({
  prisma: {
    publicationTopic: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Mock the search functions in @/lib/api/search.
vi.mock("@/lib/api/search", () => ({
  searchPeople: vi.fn(async () => ({
    hits: [],
    total: 42,
    page: 0,
    pageSize: 20,
    facets: {
      deptDivs: [],
      personTypes: [],
      activity: { hasGrants: 0, recentPub: 0 },
    },
  })),
  searchPublications: vi.fn(async () => ({
    hits: [],
    total: 17,
    page: 0,
    pageSize: 20,
  })),
}));

describe("ANALYTICS-02 (server) — search_query structured log (people branch)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("emits a search_query log line on GET /api/search?type=people", async () => {
    const { GET } = await import("@/app/api/search/route");

    const req = new NextRequest(
      new URL("http://localhost/api/search?q=cancer&deptDiv=N1280&type=people"),
    );
    await GET(req);

    expect(consoleSpy).toHaveBeenCalled();

    const searchQueryCall = consoleSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.event === "search_query";
      } catch {
        return false;
      }
    });

    expect(
      searchQueryCall,
      "Expected a console.log call with JSON containing event: search_query",
    ).toBeDefined();

    const parsed = JSON.parse(searchQueryCall![0] as string);
    expect(parsed.event).toBe("search_query");
    expect(parsed.q).toBe("cancer");
    expect(parsed.type).toBe("people");
    // "resultCount" field must be present and equal to the mock total
    expect(parsed["resultCount"]).toBe(42);
    expect(parsed.filters).toBeDefined();
    expect(parsed.filters.deptDiv).toEqual(["N1280"]);
    expect(parsed.ts).toBeDefined();
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes personType and hasActiveGrants in filters when provided", async () => {
    const { GET } = await import("@/app/api/search/route");

    const req = new NextRequest(
      new URL(
        "http://localhost/api/search?q=cancer&type=people&personType=full_time_faculty&activity=has_grants",
      ),
    );
    await GET(req);

    const call = consoleSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "search_query";
      } catch {
        return false;
      }
    });

    const parsed = JSON.parse(call![0] as string);
    expect(parsed.type).toBe("people");
    expect(parsed.resultCount).toBe(42);
    expect(parsed.filters).toBeDefined();
  });

  it("log line is valid JSON", async () => {
    const { GET } = await import("@/app/api/search/route");
    const req = new NextRequest(
      new URL("http://localhost/api/search?q=oncology&type=people"),
    );
    await GET(req);

    const call = consoleSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "search_query";
      } catch {
        return false;
      }
    });

    expect(() => JSON.parse(call![0] as string)).not.toThrow();
  });
});

describe("ANALYTICS-02 (server) — search_query structured log (publications branch)", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("emits a search_query log line on GET /api/search?type=publications", async () => {
    const { GET } = await import("@/app/api/search/route");

    const req = new NextRequest(
      new URL(
        "http://localhost/api/search?q=cancer&type=publications&yearMin=2020",
      ),
    );
    await GET(req);

    const searchQueryCall = consoleSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.event === "search_query";
      } catch {
        return false;
      }
    });

    expect(
      searchQueryCall,
      "Expected a console.log call with JSON containing event: search_query",
    ).toBeDefined();

    const parsed = JSON.parse(searchQueryCall![0] as string);
    expect(parsed.event).toBe("search_query");
    expect(parsed.q).toBe("cancer");
    expect(parsed.type).toBe("publications");
    expect(parsed.resultCount).toBe(17);
    expect(parsed.filters).toBeDefined();
    expect(parsed.filters.yearMin).toBe(2020);
    expect(parsed.filters.yearMax).toBeUndefined();
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes yearMax in filters when provided", async () => {
    const { GET } = await import("@/app/api/search/route");

    const req = new NextRequest(
      new URL(
        "http://localhost/api/search?q=cancer&type=publications&yearMin=2018&yearMax=2023",
      ),
    );
    await GET(req);

    const call = consoleSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "search_query";
      } catch {
        return false;
      }
    });

    const parsed = JSON.parse(call![0] as string);
    expect(parsed.filters.yearMin).toBe(2018);
    expect(parsed.filters.yearMax).toBe(2023);
  });
});
