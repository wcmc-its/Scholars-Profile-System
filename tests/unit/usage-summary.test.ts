import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cacheKeys: [] as string[][],
  runUsageQuery: vi.fn(),
}));

// Pass-through cache that records each entry's key parts.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => () => {
    h.cacheKeys.push(keyParts);
    return fn();
  },
}));
vi.mock("@/lib/analytics/athena-client", () => ({ runUsageQuery: h.runUsageQuery }));

import { USAGE_WINDOW_DAYS, loadUsageSummary, shapeUsageRows } from "@/lib/api/usage-summary";

describe("loadUsageSummary", () => {
  beforeEach(() => {
    h.cacheKeys.length = 0;
    h.runUsageQuery.mockReset();
    h.runUsageQuery.mockImplementation(async (sql: string) =>
      sql.includes("metric = 'pageviews'") ? [{ dt: "2026-07-02", views: "5" }] : [],
    );
  });

  it("queries the requested window and keys the cache per range", async () => {
    const week = { since: "2026-09-18", until: "2026-09-24", days: 7 };
    const launch = { since: "2026-07-01", until: "2026-09-24", days: 86 };

    const summary = await loadUsageSummary(week);
    await loadUsageSummary(launch);

    expect(h.cacheKeys).toEqual([
      ["usage-summary", "v4", "2026-09-18", "2026-09-24"],
      ["usage-summary", "v4", "2026-07-01", "2026-09-24"],
    ]);
    const firstWindow = h.runUsageQuery.mock.calls.slice(0, 9).map((c) => c[0] as string);
    expect(firstWindow).toHaveLength(9);
    expect(firstWindow.some((sql) => sql.includes("metric = 'search_term_suggested'"))).toBe(true);
    expect(firstWindow.some((sql) => sql.includes("metric = 'search_term_bot'"))).toBe(true);
    for (const sql of firstWindow) {
      expect(sql).toContain("dt >= '2026-09-18' AND dt <= '2026-09-24'");
    }
    expect(summary).toMatchObject({
      windowDays: 7,
      since: "2026-09-18",
      until: "2026-09-24",
      totalPageviews: 5,
    });
  });

  it("totals human (typed + suggested) and bot searches per range", async () => {
    // Different search_term* totals per window, as the rollup would hold them.
    const TOTALS: Record<string, Record<string, string>> = {
      "2026-09-18": { search_term: "40", search_term_suggested: "10", search_term_bot: "150" },
      "2026-07-01": { search_term: "900", search_term_suggested: "100", search_term_bot: "250" },
    };
    h.runUsageQuery.mockImplementation(async (sql: string) => {
      if (!sql.includes("metric IN (")) return [];
      const since = /dt >= '([\d-]+)'/.exec(sql)![1];
      return Object.entries(TOTALS[since]).map(([metric, searches]) => ({ metric, searches }));
    });

    const week = await loadUsageSummary({ since: "2026-09-18", until: "2026-09-24", days: 7 });
    const launch = await loadUsageSummary({ since: "2026-07-01", until: "2026-09-24", days: 86 });

    expect(week.searchVolume).toEqual({ human: 50, bot: 150 });
    expect(launch.searchVolume).toEqual({ human: 1000, bot: 250 });
  });

  it("rejects a malformed window before any query runs", async () => {
    await expect(
      loadUsageSummary({ since: "2026-09-18' OR 1=1", until: "2026-09-24", days: 7 }),
    ).rejects.toThrow(/invalid_date/);
    expect(h.runUsageQuery).not.toHaveBeenCalled();
  });

  it("propagates an Athena failure (the page fails soft on it)", async () => {
    h.runUsageQuery.mockRejectedValue(new Error("athena_query_failed: boom"));
    await expect(
      loadUsageSummary({ since: "2026-09-18", until: "2026-09-24", days: 7 }),
    ).rejects.toThrow(/athena_query_failed/);
  });
});

describe("shapeUsageRows", () => {
  it("maps each metric, coerces string counts, and totals pageviews", () => {
    const summary = shapeUsageRows({
      pageviewsByDay: [
        { dt: "2026-07-02", views: "120" },
        { dt: "2026-07-03", views: "80" },
      ],
      topProfiles: [{ slug: "carl-f-nathan", views: "45" }],
      searchTerms: [{ term: "cancer", searches: "30" }],
      suggestedSearchTerms: [{ term: "immunotherapy", searches: "7" }],
      botSearchTerms: [{ term: "zzz", searches: "90" }],
      searchTotals: [
        { metric: "search_term", searches: "30" },
        { metric: "search_term_suggested", searches: "7" },
        { metric: "search_term_bot", searches: "90" },
      ],
      referrers: [{ referrer: "(direct)", hits: "200" }],
      geo: [{ region: "North America", hits: "180" }],
      device: [{ device: "desktop", hits: "150" }],
    });

    expect(summary.windowDays).toBe(USAGE_WINDOW_DAYS);
    expect(summary.totalPageviews).toBe(200); // 120 + 80, strings coerced
    expect(summary.pageviewsByDay).toEqual([
      { day: "2026-07-02", views: 120 },
      { day: "2026-07-03", views: 80 },
    ]);
    expect(summary.topProfiles).toEqual([{ slug: "carl-f-nathan", views: 45 }]);
    expect(summary.searchTerms).toEqual([{ term: "cancer", searches: 30 }]);
    expect(summary.suggestedSearchTerms).toEqual([{ term: "immunotherapy", searches: 7 }]);
    expect(summary.botSearchTerms).toEqual([{ term: "zzz", searches: 90 }]);
    expect(summary.searchVolume).toEqual({ human: 37, bot: 90 });
    expect(summary.referrers).toEqual([{ label: "(direct)", hits: 200 }]);
    expect(summary.geo).toEqual([{ label: "North America", hits: 180 }]);
    expect(summary.device).toEqual([{ label: "desktop", hits: 150 }]);
  });

  it("treats non-numeric / missing cells as 0 and handles empty sets", () => {
    const summary = shapeUsageRows({
      pageviewsByDay: [{ dt: "2026-07-03", views: "" }],
      topProfiles: [{ slug: "x" }],
      searchTerms: [],
      suggestedSearchTerms: [],
      botSearchTerms: [],
      searchTotals: [],
      referrers: [],
      geo: [],
      device: [],
    });
    expect(summary.totalPageviews).toBe(0);
    expect(summary.pageviewsByDay).toEqual([{ day: "2026-07-03", views: 0 }]);
    expect(summary.topProfiles).toEqual([{ slug: "x", views: 0 }]);
    expect(summary.searchTerms).toEqual([]);
    expect(summary.searchVolume).toEqual({ human: 0, bot: 0 });
  });
});
