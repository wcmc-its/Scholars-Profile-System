/**
 * Report 26 (Translational portfolio): the pure parts — every breakdown adds
 * up to 100% with No stage, gaps need a sized area, the Scholars list's
 * minimum and order, the URL round-trip, the flag gate, the workbook's
 * scholar cap, and no "phase" in the copy. The SQL is report 8's scope
 * (`scopeSql`), so its stage split is report 8's by construction.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {} }, prisma: {} }));

import {
  buildPortfolioWorkbook,
  countsTotal,
  emptyCounts,
  gapStages,
  isTranslationalPortfolioReportEnabled,
  MIN_AREA_SIZE,
  MIN_SCHOLAR_ACTIVITIES,
  parsePortfolioParams,
  portfolioQueryString,
  rankScholars,
  roundedShares,
  sortTableRows,
  STAGE_BUCKETS,
  type PortfolioChoices,
  type PortfolioData,
  type StageCounts,
} from "@/lib/edit/translational-portfolio-report";

const c = (T0: number, T1: number, T2: number, T34: number, none: number): StageCounts => ({
  T0,
  T1,
  T2,
  "T3-4": T34,
  none,
});

describe("roundedShares", () => {
  it("always adds up to exactly 100, No stage included", () => {
    for (const x of [c(1, 1, 1, 0, 0), c(41, 22, 19, 18, 12), c(7, 0, 0, 0, 2), c(333, 333, 333, 1, 0), c(1, 2, 3, 4, 5)]) {
      const s = roundedShares(x);
      expect(STAGE_BUCKETS.reduce((t, k) => t + s[k], 0)).toBe(100);
    }
  });
  it("is all zero for an empty set (no 100% of nothing)", () => {
    expect(roundedShares(emptyCounts())).toEqual(emptyCounts());
  });
  it("gives the leftover point to the largest remainder", () => {
    expect(roundedShares(c(1, 1, 1, 0, 0))).toEqual(c(34, 33, 33, 0, 0));
  });
});

describe("gapStages", () => {
  it("calls out a stage under 3% in a sized area", () => {
    expect(gapStages(c(60, 25, 13, 2, 0))).toEqual(["T3-4"]);
  });
  it("calls out nothing in an area under the minimum size", () => {
    const small = c(30, 10, 5, 0, 0);
    expect(countsTotal(small)).toBeLessThan(MIN_AREA_SIZE);
    expect(gapStages(small)).toEqual([]);
  });
  it("counts No stage in the denominator", () => {
    // T3-4 is 3/100 = 3%: not a gap. With 10 more no-stage records it is 2.7%.
    expect(gapStages(c(40, 30, 27, 3, 0))).toEqual([]);
    expect(gapStages(c(40, 30, 27, 3, 10))).toEqual(["T3-4"]);
  });
});

describe("rankScholars", () => {
  const by = new Map<string, StageCounts>([
    ["a", c(10, 0, 0, 0, 5)],
    ["b", c(0, 2, 0, 0, 9)],
    ["c", c(1, 1, 4, 0, 0)],
    ["d", c(0, 0, 2, 2, 0)],
  ]);
  it("drops anyone under the minimum and sorts by count", () => {
    const r = rankScholars(by, []);
    expect(r.map((x) => x.cwid)).toEqual(["a", "c", "d"]);
    expect(r.every((x) => x.n >= MIN_SCHOLAR_ACTIVITIES && Number.isInteger(x.n))).toBe(true);
  });
  it("counts only the picked stages, and never No stage", () => {
    expect(rankScholars(by, ["T2"]).map((x) => [x.cwid, x.n])).toEqual([["c", 4]]);
    expect(rankScholars(by, ["T1"])).toEqual([]);
  });
});

describe("sortTableRows", () => {
  const rows = [
    { key: "big", counts: c(500, 300, 100, 100, 0) },
    { key: "thin", counts: c(98, 1, 1, 0, 0) },
    { key: "tiny", counts: c(0, 0, 0, 0, 5) },
    { key: "even", counts: c(50, 50, 50, 50, 0) },
  ];
  it("defaults to volume", () => {
    expect(sortTableRows(rows, "dept", []).map((r) => r.key)).toEqual(["big", "even", "thin", "tiny"]);
  });
  it("sorts by share in the picked stages", () => {
    expect(sortTableRows(rows, "dept", ["T3-4"]).map((r) => r.key)).toEqual(["even", "big", "thin", "tiny"]);
  });
  it("on research areas puts sized areas first, thinnest stage first", () => {
    expect(sortTableRows(rows, "area", []).map((r) => r.key)).toEqual(["thin", "big", "even", "tiny"]);
  });
});

describe("params", () => {
  it("round-trips every selection through the URL", () => {
    const sp = new URLSearchParams(
      "unit=dept:N1280&from=2016&to=2025&area=cancer_genomics&stage=T2&stage=T1&cwid=abc1234&by=area&view=scholars&page=3",
    );
    const p = parsePortfolioParams(sp);
    expect(p).toMatchObject({ units: ["dept:N1280"], from: 2016, to: 2025, area: "cancer_genomics", stages: ["T1", "T2"], cwid: "abc1234", by: "area", view: "scholars", page: 3 });
    expect(parsePortfolioParams(new URLSearchParams(portfolioQueryString(p)))).toEqual(p);
  });
  it("falls back on bad values and defaults to 2020 through the last complete year", () => {
    const p = parsePortfolioParams(new URLSearchParams("stage=NA&stage=T9&by=nope&view=x&area=<x>&cwid=a;b&unit=inst:X"));
    const y = new Date().getUTCFullYear();
    expect(p).toMatchObject({ stages: [], by: "dept", view: "activities", area: null, cwid: null, units: [], from: 2020, to: y - 1 });
  });
});

describe("isTranslationalPortfolioReportEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("needs its own flag AND the stage facet", () => {
    vi.stubEnv("REPORT_TRANSLATIONAL_PORTFOLIO", "on");
    vi.stubEnv("SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET", "off");
    expect(isTranslationalPortfolioReportEnabled()).toBe(false);
    vi.stubEnv("SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET", "on");
    expect(isTranslationalPortfolioReportEnabled()).toBe(true);
    vi.stubEnv("REPORT_TRANSLATIONAL_PORTFOLIO", "true");
    expect(isTranslationalPortfolioReportEnabled()).toBe(false);
  });
});

describe("buildPortfolioWorkbook", () => {
  const choices: PortfolioChoices = {
    facets: { roleCategories: [], departments: [], centers: [], institutions: [] },
    labels: new Map(),
    areas: [],
  };
  const data = (scholars: number): PortfolioData => ({
    all: c(4, 3, 2, 1, 0),
    byYear: [{ year: 2025, counts: c(4, 3, 2, 1, 0) }],
    baseline: c(4, 3, 2, 1, 0),
    table: [],
    areaCoverage: { sized: 0, spanning: 0 },
    scholars: {
      total: scholars,
      rows: Array.from({ length: Math.min(scholars, 50) }, (_, i) => ({
        cwid: `x${i}`,
        name: `Name ${i}`,
        title: null,
        department: null,
        slug: null,
        n: 3,
        counts: c(3, 0, 0, 0, 0),
        works: [],
      })),
    },
    person: null,
    lookup: [],
    activities: { total: 10, pmids: [] },
  });
  const sheet = async (n: number) => {
    const wb = new ExcelJS.Workbook();
    const buf = await buildPortfolioWorkbook(parsePortfolioParams(new URLSearchParams()), choices, data(n), new Date());
    await wb.xlsx.load(new Uint8Array(buf).buffer);
    return wb;
  };
  it("lists the scholars at or under the cap", async () => {
    expect((await sheet(50)).getWorksheet("Scholars")!.rowCount).toBe(51);
  });
  it("lists no one above the cap (never truncated)", async () => {
    const ws = (await sheet(51)).getWorksheet("Scholars")!;
    expect(ws.rowCount).toBe(1);
    expect(String(ws.getCell("A1").value)).toMatch(/^Omitted: 51 scholars/);
  });
  it("adds up: the year rows' buckets sum to the publication column", async () => {
    const ws = (await sheet(0)).getWorksheet("By year")!;
    const row = ws.getRow(2).values as unknown[];
    expect(row[2]).toBe(10);
    expect((row.slice(3) as number[]).reduce((s, n) => s + n, 0)).toBe(10);
  });
});

describe("copy", () => {
  it('never calls a translational stage a "phase"', () => {
    for (const f of [
      "lib/edit/translational-portfolio-report.ts",
      "components/edit/reports/translational-portfolio-body.tsx",
    ]) {
      const text = readFileSync(path.resolve(__dirname, "../..", f), "utf8");
      expect(text, f).not.toMatch(/\bphases?\b/i);
    }
  });
});
