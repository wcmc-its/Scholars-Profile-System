import { describe, expect, it } from "vitest";

import { USAGE_WINDOW_DAYS, shapeUsageRows } from "@/lib/api/usage-summary";

describe("shapeUsageRows", () => {
  it("maps each metric, coerces string counts, and totals pageviews", () => {
    const summary = shapeUsageRows({
      pageviewsByDay: [
        { dt: "2026-07-02", views: "120" },
        { dt: "2026-07-03", views: "80" },
      ],
      topProfiles: [{ cwid: "abc123", views: "45" }],
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
    expect(summary.topProfiles).toEqual([{ cwid: "abc123", views: 45 }]);
    expect(summary.searchTerms).toEqual([{ term: "cancer", searches: 30 }]);
    expect(summary.referrers).toEqual([{ label: "(direct)", hits: 200 }]);
    expect(summary.geo).toEqual([{ label: "North America", hits: 180 }]);
    expect(summary.device).toEqual([{ label: "desktop", hits: 150 }]);
  });

  it("treats non-numeric / missing cells as 0 and handles empty sets", () => {
    const summary = shapeUsageRows({
      pageviewsByDay: [{ dt: "2026-07-03", views: "" }],
      topProfiles: [{ cwid: "x" }],
      searchTerms: [],
      referrers: [],
      geo: [],
      device: [],
    });
    expect(summary.totalPageviews).toBe(0);
    expect(summary.pageviewsByDay).toEqual([{ day: "2026-07-03", views: 0 }]);
    expect(summary.topProfiles).toEqual([{ cwid: "x", views: 0 }]);
    expect(summary.searchTerms).toEqual([]);
  });
});
