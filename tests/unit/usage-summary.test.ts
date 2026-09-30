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
      ["usage-summary", "v2", "2026-09-18", "2026-09-24"],
      ["usage-summary", "v2", "2026-07-01", "2026-09-24"],
    ]);
    const firstSix = h.runUsageQuery.mock.calls.slice(0, 6).map((c) => c[0] as string);
    expect(firstSix).toHaveLength(6);
    for (const sql of firstSix) {
      expect(sql).toContain("dt >= '2026-09-18' AND dt <= '2026-09-24'");
    }
    expect(summary).toMatchObject({
      windowDays: 7,
      since: "2026-09-18",
      until: "2026-09-24",
      totalPageviews: 5,
    });
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
    expect(summary.referrers).toEqual([{ label: "(direct)", hits: 200 }]);
    expect(summary.geo).toEqual([{ label: "North America", hits: 180 }]);
    expect(summary.device).toEqual([{ label: "desktop", hits: 150 }]);
  });

  it("treats non-numeric / missing cells as 0 and handles empty sets", () => {
    const summary = shapeUsageRows({
      pageviewsByDay: [{ dt: "2026-07-03", views: "" }],
      topProfiles: [{ slug: "x" }],
      searchTerms: [],
      referrers: [],
      geo: [],
      device: [],
    });
    expect(summary.totalPageviews).toBe(0);
    expect(summary.pageviewsByDay).toEqual([{ day: "2026-07-03", views: 0 }]);
    expect(summary.topProfiles).toEqual([{ slug: "x", views: 0 }]);
    expect(summary.searchTerms).toEqual([]);
  });
});
