/** lib/analytics/traffic-view — row shaping, periods, buckets, formatting. */
import { describe, expect, it } from "vitest";

import {
  bucketAi,
  bucketSources,
  compactCount,
  shapePageList,
  shapeReferrerList,
  shapeTrafficOverview,
  sharePct,
  trafficPeriods,
  trafficStart,
} from "@/lib/analytics/traffic-view";

const EMPTY = {
  kpi: [],
  sourcesDaily: [],
  referrerTotals: [],
  aiDaily: [],
  vendors: [],
  firstDt: [],
};

describe("shapeTrafficOverview", () => {
  it("shapes KPIs with average daily visitors", () => {
    const o = shapeTrafficOverview(
      {
        ...EMPTY,
        kpi: [
          { kind: "hits", cnt: "1000", days: "4" },
          { kind: "pageviews", cnt: "400", days: "4" },
          { kind: "visitors", cnt: "90", days: "4" },
        ],
        firstDt: [{ first_dt: "2026-11-12" }],
        referrerTotals: [{ total: "50", other: "5", site_only: "30" }],
      },
      { since: "2026-11-01", until: "2026-11-15" },
    );
    expect(o.kpi).toEqual({
      hits: 1000,
      pageviews: 400,
      visitorsAvg: 23,
      visitorDays: 4,
      engagedAvg: null,
      engagedDays: 0,
    });
    expect(o.firstDt).toBe("2026-11-12");
    expect(o.referrers).toEqual({ total: 50, other: 5, siteOnly: 30 });
  });

  it("averages engaged visitors over the days that have the row, like visitors", () => {
    const o = shapeTrafficOverview(
      {
        ...EMPTY,
        kpi: [
          { kind: "visitors", cnt: "90", days: "4" },
          // Only the last two days were rolled up with engaged visitors.
          { kind: "engaged_visitors", cnt: "25", days: "2" },
        ],
      },
      { since: "2026-11-01", until: "2026-11-15" },
    );
    expect(o.kpi.visitorsAvg).toBe(23);
    expect(o.kpi.engagedAvg).toBe(13);
    expect(o.kpi.engagedDays).toBe(2);
  });

  it("drops malformed rows and pivots AI series per day", () => {
    const o = shapeTrafficOverview(
      {
        ...EMPTY,
        sourcesDaily: [
          { dt: "2026-11-12", category: "WCM", visits: "7" },
          { dt: "bad", category: "WCM", visits: "1" },
          { dt: "2026-11-12", category: "Nope", visits: "1" },
        ],
        aiDaily: [
          { dt: "2026-11-13", series: "crawler", cnt: "9" },
          { dt: "2026-11-12", series: "fetch", cnt: "2" },
          { dt: "2026-11-12", series: "referral", cnt: "1" },
          { dt: "2026-11-12", series: "other", cnt: "100" },
        ],
        vendors: [
          { vendor: "OpenAI", cnt: "8" },
          { vendor: "", cnt: "1" },
        ],
      },
      { since: "2026-11-01", until: "2026-11-15" },
    );
    expect(o.sourcesDaily).toEqual([{ dt: "2026-11-12", category: "WCM", visits: 7 }]);
    expect(o.aiDaily).toEqual([
      { dt: "2026-11-12", referral: 1, fetch: 2, crawler: 0 },
      { dt: "2026-11-13", referral: 0, fetch: 0, crawler: 9 },
    ]);
    expect(o.vendors).toEqual([{ vendor: "OpenAI", count: 8 }]);
    expect(o.firstDt).toBeNull();
    expect(o.kpi.visitorsAvg).toBe(0);
  });
});

describe("trafficPeriods", () => {
  it("splits into Monday weeks clipped to the range, with full-range labels", () => {
    // 2026-11-09 is a Monday.
    expect(trafficPeriods("2026-10-28", "2026-11-15", "week")).toEqual([
      { key: "2026-10-26", start: "2026-10-28", end: "2026-11-01", label: "Oct 28–Nov 1" },
      { key: "2026-11-02", start: "2026-11-02", end: "2026-11-08", label: "Nov 2–8" },
      { key: "2026-11-09", start: "2026-11-09", end: "2026-11-15", label: "Nov 9–15" },
    ]);
  });

  it("names full months and spells out partial ones", () => {
    expect(trafficPeriods("2026-09-01", "2026-11-15", "month").map((p) => p.label)).toEqual([
      "September",
      "October",
      "November 1–15",
    ]);
    expect(trafficPeriods("2026-09-20", "2026-09-20", "month")[0].label).toBe("September 20");
  });

  it("adds the year when a range crosses years", () => {
    expect(trafficPeriods("2026-12-01", "2027-01-31", "month").map((p) => p.label)).toEqual([
      "December 2026",
      "January 2027",
    ]);
  });

  it("returns nothing for a malformed or backwards range", () => {
    expect(trafficPeriods("x", "2026-11-15", "week")).toEqual([]);
    expect(trafficPeriods("2026-11-15", "2026-11-01", "week")).toEqual([]);
  });
});

it("bucketSources and bucketAi sum days into periods", () => {
  const periods = trafficPeriods("2026-11-02", "2026-11-15", "week");
  const s = bucketSources(
    [
      { dt: "2026-11-03", category: "WCM", visits: 2 },
      { dt: "2026-11-04", category: "WCM", visits: 3 },
      { dt: "2026-11-10", category: "Fake", visits: 1 },
      { dt: "2026-12-01", category: "WCM", visits: 99 },
    ],
    periods,
  );
  expect(s.WCM).toEqual([5, 0]);
  expect(s.Fake).toEqual([0, 1]);
  expect(s["Search engines"]).toEqual([0, 0]);
  const ai = bucketAi([{ dt: "2026-11-12", referral: 1, fetch: 2, crawler: 3 }], periods);
  expect(ai).toEqual({ referral: [0, 1], fetch: [0, 2], crawler: [0, 3] });
});

it("trafficStart clamps the range start to the first rollup day", () => {
  expect(trafficStart({ since: "2026-10-01", firstDt: "2026-11-12" })).toBe("2026-11-12");
  expect(trafficStart({ since: "2026-11-13", firstDt: "2026-11-12" })).toBe("2026-11-13");
  expect(trafficStart({ since: "2026-11-13", firstDt: null })).toBe("2026-11-13");
});

it("compactCount and sharePct", () => {
  expect(compactCount(11_300_000)).toBe("11.3M");
  expect(compactCount(4_450_000)).toBe("4.45M");
  expect(compactCount(27_400)).toBe("27k");
  expect(compactCount(8512)).toBe("8,512");
  expect(sharePct(1, 8)).toBe("12.5%");
  expect(sharePct(1, 0)).toBe("0%");
});

it("shapes list pages with the window total", () => {
  expect(
    shapeReferrerList([
      { ref: "www.google.com", category: "Search engines", visits: "10", total: "42" },
      { ref: "x.example", category: "bogus", visits: "1", total: "42" },
    ]),
  ).toEqual({
    rows: [
      { label: "www.google.com", category: "Search engines", visits: 10 },
      { label: "x.example", category: "Other", visits: 1 },
    ],
    total: 42,
  });
  expect(shapePageList([{ page: "/", visits: "5", total: "3" }])).toEqual({
    rows: [{ label: "/", visits: 5 }],
    total: 3,
  });
  expect(shapePageList([])).toEqual({ rows: [], total: 0 });
});
