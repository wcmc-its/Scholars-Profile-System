/** lib/edit/usage-traffic-xlsx — sheet names and row counts from mocked rows. */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import type { TrafficOverview } from "@/lib/analytics/traffic-view";
import { buildUsageTrafficWorkbook } from "@/lib/edit/usage-traffic-xlsx";

const OVERVIEW: TrafficOverview = {
  since: "2026-11-01",
  until: "2026-11-15",
  firstDt: "2026-11-03",
  kpi: { hits: 1000, pageviews: 400, visitorsAvg: 30, visitorDays: 13 },
  sourcesDaily: [
    { dt: "2026-11-03", category: "WCM", visits: 4 },
    { dt: "2026-11-10", category: "Search engines", visits: 6 },
  ],
  referrers: { total: 12, other: 2, siteOnly: 8 },
  aiDaily: [{ dt: "2026-11-10", referral: 1, fetch: 2, crawler: 30 }],
  vendors: [
    { vendor: "OpenAI", count: 20 },
    { vendor: "Anthropic", count: 12 },
  ],
};

const LISTS = {
  referringSites: [
    { ref: "www.google.com", category: "Search engines", visits: "6" },
    { ref: "news.weill.cornell.edu", category: "WCM", visits: "4" },
  ],
  referringPages: [
    { ref: "www.google.com/", category: "Search engines", visits: "6" },
    { ref: "news.weill.cornell.edu/news/x", category: "WCM", visits: "3" },
    { ref: "news.weill.cornell.edu/", category: "WCM", visits: "1" },
  ],
  topPages: [
    { page: "/", visits: "100" },
    { page: "/test-person-1", visits: "9" },
  ],
  landing: [
    { source: "WCM", referrer_host: "news.weill.cornell.edu", page: "/test-person-1", visits: "3" },
    { source: "crawler", referrer_host: "", page: "/search", visits: "30" },
  ],
};

async function load(grain: "week" | "month") {
  const wb = new ExcelJS.Workbook();
  const buf = await buildUsageTrafficWorkbook(OVERVIEW, LISTS, grain);
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe("buildUsageTrafficWorkbook", () => {
  it("has the seven sheets, named for the grain", async () => {
    expect((await load("week")).worksheets.map((w) => w.name)).toEqual([
      "Summary",
      "Sources by week",
      "Referring sites",
      "Referring pages",
      "Top pages",
      "Landing pages",
      "AI",
    ]);
    expect((await load("month")).worksheets[1].name).toBe("Sources by month");
  });

  it("writes a header plus every row on each list sheet", async () => {
    const wb = await load("week");
    expect(wb.getWorksheet("Referring sites")!.rowCount).toBe(3);
    expect(wb.getWorksheet("Referring pages")!.rowCount).toBe(4);
    expect(wb.getWorksheet("Top pages")!.rowCount).toBe(3);
    const landing = wb.getWorksheet("Landing pages")!;
    expect(landing.rowCount).toBe(3);
    expect(landing.getRow(3).values).toEqual([undefined, "AI crawlers", "", "/search", 30]);
  });

  it("buckets sources and AI from the first rollup day, by week", async () => {
    const wb = await load("week");
    const src = wb.getWorksheet("Sources by week")!;
    // Nov 3-8 (clipped to the first rollup day) and Nov 9-15.
    expect(src.rowCount).toBe(3);
    expect(src.getRow(2).getCell(1).value).toBe("Nov 3–8");
    const header = src.getRow(1).values as unknown[];
    const total = header.indexOf("Total");
    expect(src.getRow(2).getCell(total).value).toBe(4);
    expect(src.getRow(3).getCell(total).value).toBe(6);
    const ai = wb.getWorksheet("AI")!;
    // 2 periods + blank + vendor header + 2 vendors after the header row.
    expect(ai.rowCount).toBe(7);
    expect(ai.getRow(3).values).toEqual([
      undefined,
      "Nov 9–15",
      "2026-11-09",
      "2026-11-15",
      1,
      2,
      30,
    ]);
  });

  it("puts the KPIs on the summary sheet", async () => {
    const summary = (await load("week")).getWorksheet("Summary")!;
    const byLabel = new Map<string, unknown>();
    summary.eachRow((r) => byLabel.set(String(r.getCell(1).value), r.getCell(2).value));
    expect(byLabel.get("Hits")).toBe(1000);
    expect(byLabel.get("Visitors, average per day (estimate)")).toBe(30);
    expect(byLabel.get("Traffic detail starts")).toBe("2026-11-03");
  });
});
