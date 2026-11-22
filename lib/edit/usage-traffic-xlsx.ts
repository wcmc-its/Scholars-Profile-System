/**
 * The Usage dashboard's "Download Excel": one workbook for the selected range
 * with the traffic overview (Summary, Sources by week/month, AI) and every
 * row of the lists (Referring sites, Referring pages, Top pages, Landing
 * pages). Site-wide aggregates only: hosts and paths, no people, no IPs, so no
 * SCHOLAR_EXPORT_CAP applies.
 */
import ExcelJS from "exceljs";

import { REFERRER_CATEGORY_DISPLAY_ORDER } from "@/lib/analytics/referrer-category";
import {
  type Grain,
  type Row,
  type TrafficOverview,
  bucketAi,
  bucketSources,
  num,
  trafficPeriods,
  trafficStart,
} from "@/lib/analytics/traffic-view";
import type { TrafficExportRows } from "@/lib/api/usage-traffic";
import { boldRow, workbookBuffer } from "@/lib/edit/report-xlsx";

export const AI_CLASS_LABEL: Record<string, string> = {
  fetch: "AI fetching for a person",
  crawler: "AI crawlers",
};

function sheet(
  wb: ExcelJS.Workbook,
  name: string,
  header: string[],
  widths: number[],
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  ws.addRow(header);
  boldRow(ws, 1);
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return ws;
}

export async function buildUsageTrafficWorkbook(
  overview: TrafficOverview,
  lists: TrafficExportRows,
  grain: Grain,
  /** The unit name(s) a unit-scoped viewer's page sheets are limited to. */
  scopeLabel?: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const start = trafficStart(overview);
  const periods = trafficPeriods(start, overview.until, grain);
  const { kpi, referrers } = overview;

  const summary = sheet(wb, "Summary", ["Measure", "Value"], [44, 90]);
  const summaryRows: Array<[string, string | number]> = [
    ["Range", `${overview.since} to ${overview.until}`],
    ["Traffic detail starts", overview.firstDt ?? "No traffic detail yet"],
    ["Hits", kpi.hits],
    ["Pageviews", kpi.pageviews],
    ["Visitors, average per day (estimate)", kpi.visitorsAvg],
    [
      "Engaged visits, average per day (estimate)",
      kpi.engagedAvg ?? "Not recorded for this range yet",
    ],
    ["External referrals", referrers.total],
    ["Referrals past each day's top 5,000 referrers (not categorized)", referrers.other],
    ["Referrals naming only the site, not the page", referrers.siteOnly],
    ["About hits", "Every request: pages, images, scripts, bots, blocked ones."],
    [
      "About pageviews",
      "A page served (status 200, GET) to a browser that doesn't call itself a bot. Includes in-app navigations.",
    ],
    [
      "About visitors",
      "Distinct network address plus browser per day, averaged over the days in range. Campus NAT undercounts people; a proxy botnet counts every address as a new visitor.",
    ],
    [
      "About engaged visits",
      "Visitors who clicked a search result or opened a profile preview, averaged over the days in range that record it. Scrapers almost never do, so this is a lower bound.",
    ],
    ["Note", "Counts still include automated traffic the edge firewall let through."],
  ];
  if (scopeLabel) {
    summaryRows.push([
      "Top pages and Landing pages sheets",
      `Profile pages of ${scopeLabel} only. Every other sheet is site-wide.`,
    ]);
  }
  for (const r of summaryRows) summary.addRow(r);
  summary.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const grainName = grain === "week" ? "week" : "month";
  const sources = bucketSources(overview.sourcesDaily, periods);
  const cats = REFERRER_CATEGORY_DISPLAY_ORDER;
  const src = sheet(
    wb,
    `Sources by ${grainName}`,
    ["Period", "Start", "End", ...cats, "Total"],
    [18, 12, 12, ...cats.map(() => 14), 12],
  );
  periods.forEach((p, i) => {
    const vals = cats.map((c) => sources[c][i]);
    src.addRow([p.label, p.start, p.end, ...vals, vals.reduce((a, b) => a + b, 0)]);
  });

  const sites = sheet(wb, "Referring sites", ["Site", "Source", "Visits"], [50, 18, 12]);
  for (const r of lists.referringSites)
    sites.addRow([r.ref ?? "", r.category ?? "", num(r.visits)]);

  const pages = sheet(wb, "Referring pages", ["Referrer", "Source", "Visits"], [90, 18, 12]);
  for (const r of lists.referringPages)
    pages.addRow([r.ref ?? "", r.category ?? "", num(r.visits)]);

  const top = sheet(wb, "Top pages", ["Page", "Pageviews"], [80, 12]);
  for (const r of lists.topPages) top.addRow([r.page ?? "", num(r.visits)]);

  const landing = sheet(
    wb,
    "Landing pages",
    ["Arrived from", "Referrer site", "Page", "Visits"],
    [26, 40, 70, 12],
  );
  for (const r of lists.landing as Row[]) {
    const source = AI_CLASS_LABEL[r.source ?? ""] ?? r.source ?? "";
    landing.addRow([source, r.referrer_host ?? "", r.page ?? "", num(r.visits)]);
  }

  const ai = bucketAi(overview.aiDaily, periods);
  const aiWs = sheet(
    wb,
    "AI",
    [
      "Period",
      "Start",
      "End",
      "People sent by AI assistants",
      "AI fetching for a person",
      "AI crawlers",
    ],
    [18, 12, 12, 28, 26, 14],
  );
  periods.forEach((p, i) =>
    aiWs.addRow([p.label, p.start, p.end, ai.referral[i], ai.fetch[i], ai.crawler[i]]),
  );
  aiWs.addRow([]);
  const vendorHeader = aiWs.addRow(["Company", "Declared AI agent requests"]);
  vendorHeader.font = { bold: true };
  for (const v of overview.vendors) aiWs.addRow([v.vendor, v.count]);

  return workbookBuffer(wb);
}
