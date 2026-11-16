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

import {
  USAGE_WINDOW_DAYS,
  loadUsageSummary,
  shapeHourly,
  shapeUsageRows,
} from "@/lib/api/usage-summary";

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
      ["usage-summary", "v6", "2026-09-18", "2026-09-24"],
      ["usage-summary", "v6", "2026-07-01", "2026-09-24"],
    ]);
    const firstWindow = h.runUsageQuery.mock.calls.slice(0, 9).map((c) => c[0] as string);
    expect(firstWindow).toHaveLength(9);
    expect(firstWindow.some((sql) => sql.includes("metric = 'search_term_suggested'"))).toBe(true);
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

  it("totals typed and likely-suggested searches per range", async () => {
    // Different search_term* totals per window, as the rollup would hold them.
    const TOTALS: Record<string, Record<string, string>> = {
      "2026-09-18": { typed: "40", suggested: "10" },
      "2026-07-01": { typed: "900", suggested: "100" },
    };
    h.runUsageQuery.mockImplementation(async (sql: string) => {
      if (!sql.includes("metric IN (")) return [];
      const since = /dt >= '([\d-]+)'/.exec(sql)![1];
      return Object.entries(TOTALS[since]).map(([metric, searches]) => ({ metric, searches }));
    });

    const week = await loadUsageSummary({ since: "2026-09-18", until: "2026-09-24", days: 7 });
    const launch = await loadUsageSummary({ since: "2026-07-01", until: "2026-09-24", days: 86 });

    expect(week.searchVolume).toEqual({ typed: 40, suggested: 10 });
    expect(launch.searchVolume).toEqual({ typed: 900, suggested: 100 });
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
      searchTotals: [
        { metric: "typed", searches: "30" },
        { metric: "suggested", searches: "7" },
      ],
      referrers: [{ referrer: "(direct)", hits: "200" }],
      geo: [{ region: "North America", hits: "180" }],
      device: [{ device: "desktop", hits: "150" }],
      hourly: [],
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
    expect(summary.searchVolume).toEqual({ typed: 30, suggested: 7 });
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
      searchTotals: [],
      referrers: [],
      geo: [],
      device: [],
      hourly: [],
    });
    expect(summary.totalPageviews).toBe(0);
    expect(summary.pageviewsByDay).toEqual([{ day: "2026-07-03", views: 0 }]);
    expect(summary.topProfiles).toEqual([{ slug: "x", views: 0 }]);
    expect(summary.searchTerms).toEqual([]);
    expect(summary.searchVolume).toEqual({ typed: 0, suggested: 0 });
    expect(summary.hourly).toEqual({ buckets: [], firstDay: null, days: 0 });
  });
});

describe("shapeHourly", () => {
  it("returns an empty result before the hourly rollup began", () => {
    expect(shapeHourly([])).toEqual({ buckets: [], firstDay: null, days: 0 });
  });

  it("converts UTC hours to Eastern and fills every hour of a covered day", () => {
    const h = shapeHourly([
      // 2026-11-16 is EST (UTC-5): 15Z = 10 AM, 03Z = 10 PM the evening before.
      { dt: "2026-11-16", slot: "15|human", hits: "120" },
      { dt: "2026-11-16", slot: "15|bot", hits: "40" },
      { dt: "2026-11-16", slot: "15|error", hits: "2" },
      { dt: "2026-11-16", slot: "03|human", hits: "7" },
    ]);
    expect(h.days).toBe(1);
    expect(h.firstDay).toBe("2026-11-16");
    expect(h.buckets).toHaveLength(24);
    // Sorted by instant: 00Z is 7 PM Eastern on Nov 15.
    expect(h.buckets[0]).toMatchObject({ day: "2026-11-15", hour: 19 });
    expect(h.buckets.find((b) => b.day === "2026-11-16" && b.hour === 10)).toMatchObject({
      at: Date.parse("2026-11-16T15:00:00Z"),
      human: 120,
      bot: 40,
      error: 2,
    });
    expect(h.buckets.find((b) => b.day === "2026-11-15" && b.hour === 22)).toMatchObject({
      human: 7,
      bot: 0,
      error: 0,
    });
    // An hour with no row on a covered day is a real zero.
    expect(h.buckets.find((b) => b.day === "2026-11-16" && b.hour === 3)).toMatchObject({
      human: 0,
      bot: 0,
      error: 0,
    });
  });

  it("uses EDT (UTC-4) in summer", () => {
    const h = shapeHourly([{ dt: "2026-07-01", slot: "14|error", hits: "9" }]);
    expect(h.buckets.find((b) => b.error === 9)).toMatchObject({ day: "2026-07-01", hour: 10 });
  });

  it("keeps the two 1 AM hours of the fall-back day apart", () => {
    // 2026-11-01: 05Z = 1 AM EDT, 06Z = 1 AM EST.
    const h = shapeHourly([
      { dt: "2026-11-01", slot: "05|human", hits: "3" },
      { dt: "2026-11-01", slot: "06|human", hits: "4" },
    ]);
    const oneAm = h.buckets.filter((b) => b.day === "2026-11-01" && b.hour === 1);
    expect(oneAm.map((b) => b.human)).toEqual([3, 4]);
  });

  it("counts covered days, orders buckets across days, and skips malformed rows", () => {
    const h = shapeHourly([
      { dt: "2026-11-17", slot: "00|bot", hits: "5" },
      { dt: "2026-11-16", slot: "23|bot", hits: "6" },
      { dt: "bad", slot: "01|bot", hits: "1" },
      { dt: "2026-11-18", slot: "24|bot", hits: "1" },
      { dt: "2026-11-18", slot: "01|robot", hits: "1" },
      { dt: "2026-11-18", slot: "01", hits: "1" },
    ]);
    expect(h.days).toBe(2);
    expect(h.firstDay).toBe("2026-11-16");
    expect(h.buckets).toHaveLength(48);
    expect(h.buckets.every((b, i) => i === 0 || b.at - h.buckets[i - 1].at === 3_600_000)).toBe(
      true,
    );
    expect(h.buckets.reduce((a, b) => a + b.bot, 0)).toBe(11);
  });
});
