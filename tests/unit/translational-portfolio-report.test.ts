/**
 * Report 26 (Translational portfolio): the pure parts — shares are among
 * staged publications and add up to 100%, gaps leave No stage out and need a
 * sized area, the Scholars list's
 * minimum and order, the URL round-trip, the flag gate, the workbook's
 * scholar cap, and no "phase" in the copy. The SQL is report 8's scope
 * (`scopeSql`), so its stage split is report 8's by construction.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {} }, prisma: {} }));

import { db } from "@/lib/db";
import {
  buildPortfolioWorkbook,
  loadPortfolio,
  countsTotal,
  emptyCounts,
  gapStages,
  isTranslationalPortfolioReportEnabled,
  MIN_AREA_SIZE,
  MIN_SCHOLAR_ACTIVITIES,
  parsePortfolioParams,
  portfolioQueryString,
  rankScholars,
  sortTableRows,
  STAGE_BUCKETS,
  stageAssignedShare,
  stagedShares,
  type PortfolioChoices,
  type PortfolioData,
  type StageCounts,
} from "@/lib/edit/translational-portfolio-report";
import { roundedShares } from "@/lib/translational-stage";

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

describe("stagedShares", () => {
  it("adds up to exactly 100 over the four stages, leaving No stage out", () => {
    for (const x of [c(1, 1, 1, 0, 0), c(41, 22, 19, 18, 12), c(7, 0, 0, 0, 2), c(333, 333, 333, 1, 0), c(1, 2, 3, 4, 500)]) {
      const s = stagedShares(x);
      expect(Object.keys(s)).toEqual(["T0", "T1", "T2", "T3-4"]);
      expect(s.T0 + s.T1 + s.T2 + s["T3-4"]).toBe(100);
    }
  });
  it("does not move when only unstaged records are added", () => {
    expect(stagedShares(c(50, 25, 15, 10, 0))).toEqual(stagedShares(c(50, 25, 15, 10, 900)));
  });
  it("is all zero when nothing has a stage (no 100% of nothing)", () => {
    expect(stagedShares(c(0, 0, 0, 0, 12))).toEqual({ T0: 0, T1: 0, T2: 0, "T3-4": 0 });
    expect(stagedShares(emptyCounts())).toEqual({ T0: 0, T1: 0, T2: 0, "T3-4": 0 });
  });
  it("gives the leftover point to the largest remainder", () => {
    expect(stagedShares(c(1, 1, 1, 0, 9))).toEqual({ T0: 34, T1: 33, T2: 33, "T3-4": 0 });
  });
});

describe("stageAssignedShare", () => {
  it("is the share of records with a stage, and 0 for none", () => {
    expect(stageAssignedShare(c(30, 20, 20, 10, 20))).toBe(80);
    expect(stageAssignedShare(emptyCounts())).toBe(0);
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
  it("sizes an area by its staged publications, not all of them", () => {
    // 45 staged + 100 unstaged: 145 publications, but too few with a stage to judge.
    expect(gapStages(c(30, 10, 5, 0, 100))).toEqual([]);
  });
  it("leaves No stage out of the denominator", () => {
    // T3-4 is 3 of 100 staged = 3%: not a gap, however many records have no stage.
    expect(gapStages(c(40, 30, 27, 3, 0))).toEqual([]);
    expect(gapStages(c(40, 30, 27, 3, 10))).toEqual([]);
    expect(gapStages(c(40, 30, 28, 2, 10))).toEqual(["T3-4"]);
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
      "unit=dept:N1280&from=2016&to=2025&area=cancer_genomics&area=sys_bio&gaps=1&rows=all&stage=T2&stage=T1&cwid=abc1234&by=area&view=activities&page=3",
    );
    const p = parsePortfolioParams(sp);
    expect(p).toMatchObject({
      units: ["dept:N1280"],
      from: 2016,
      to: 2025,
      areas: ["cancer_genomics", "sys_bio"],
      gaps: true,
      allRows: true,
      stages: ["T1", "T2"],
      cwid: "abc1234",
      by: "area",
      view: "activities",
      page: 3,
    });
    expect(parsePortfolioParams(new URLSearchParams(portfolioQueryString(p)))).toEqual(p);
  });
  it("keeps primary institutions apart from the unit, and folds report 8's unit=inst: into them", () => {
    const p = parsePortfolioParams(new URLSearchParams("unit=dept:N1&inst=HSS&inst=WCMC-Q&unit=inst:CU GHS&inst=<x>"));
    expect(p.units).toEqual(["dept:N1"]);
    expect(p.insts).toEqual(["HSS", "WCMC-Q", "CU GHS"]);
    expect(parsePortfolioParams(new URLSearchParams(portfolioQueryString(p)))).toEqual(p);
  });
  it("falls back on bad values and defaults to 2020 through the last complete year", () => {
    const p = parsePortfolioParams(new URLSearchParams("stage=NA&stage=T9&by=nope&view=x&area=<x>&cwid=a;b&unit=inst:X"));
    const y = new Date().getUTCFullYear();
    expect(p).toMatchObject({ stages: [], by: "dept", view: "scholars", areas: [], gaps: false, allRows: false, cwid: null, units: [], from: 2020, to: y - 1 });
  });
  it("defaults to the Scholars list and leaves the default out of the URL", () => {
    const p = parsePortfolioParams(new URLSearchParams("from=2020&to=2024"));
    expect(p.view).toBe("scholars");
    expect(portfolioQueryString(p)).toBe("from=2020&to=2024");
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
    table: [
      { key: "a1", label: "Area one", href: "", note: "12 scholars", noteHref: null, gaps: ["T1", "T3-4"], counts: c(60, 1, 20, 1, 9) },
    ],
    areaCoverage: { sized: 0, spanning: 0 },
    areaOrder: [],
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
  it("names each row's gaps in their own column", async () => {
    const ws = (await sheet(0)).getWorksheet("Departments")!;
    expect(ws.getRow(1).getCell(3).value).toBe("Gaps");
    expect(ws.getRow(3).getCell(1).value).toBe("Area one");
    expect(ws.getRow(3).getCell(3).value).toBe("T1, T3–4");
  });
  it("adds up: the year rows' buckets sum to the publication column", async () => {
    const ws = (await sheet(0)).getWorksheet("By year")!;
    const row = ws.getRow(2).values as unknown[];
    expect(row[2]).toBe(10);
    // Columns 3-7 are the five bucket counts; the share columns follow them.
    expect((row.slice(3, 8) as number[]).reduce((s, n) => s + n, 0)).toBe(10);
  });
  it("puts Stage assigned and the staged shares beside the counts", async () => {
    const ws = (await sheet(0)).getWorksheet("Departments")!;
    const head = ws.getRow(1).values as unknown[];
    expect(head.slice(10)).toEqual(["Stage assigned (%)", "T0 share of staged (%)", "T1 share of staged (%)", "T2 share of staged (%)", "T3–4 share of staged (%)"]);
    // Area one: 82 staged of 91; 60/1/20/1 of the 82 staged (T2 takes the leftover point).
    expect((ws.getRow(3).values as unknown[]).slice(10)).toEqual([90, 73, 1, 25, 1]);
  });
});

describe("loadPortfolio's area scholar counts", () => {
  it("count the people the Scholars list shows: first or senior author, at least the minimum, picked stages", async () => {
    const texts: string[] = [];
    // A grouping's name is a bound value, not SQL text: route by the values.
    (db.read as unknown as Record<string, unknown>).$queryRaw = vi.fn(async (q: { sql?: string; values?: unknown[] } | string[]) => {
      const text = Array.isArray(q) ? q.join("?") : String(q.sql);
      const values = Array.isArray(q) ? [] : (q.values ?? []);
      texts.push(text);
      if (values.includes("areaPeople")) return [{ k: "areaPeople", g: "a1", st: null, n: 4n }];
      if (values.includes("area")) return [{ k: "area", g: "a1", st: "T0", n: 60n }];
      return [];
    });
    const choices: PortfolioChoices = {
      facets: { roleCategories: [], departments: [], centers: [], institutions: [] },
      labels: new Map(),
      areas: [{ id: "a1", label: "Area one" }],
    };
    const d = await loadPortfolio(parsePortfolioParams(new URLSearchParams("from=2024&to=2025&by=area&stage=T2")), choices);
    const people = texts.find((t) => t.includes("HAVING"))!;
    expect(people).toMatch(/is_first = 1 OR pa\.is_last = 1/);
    expect(people).toMatch(/HAVING COUNT\(DISTINCT x\.pmid\) >= \?/);
    expect(d.table.find((r) => r.key === "a1")?.note).toBe("4 scholars");
  });
});

describe("loadPortfolio", () => {
  it("counts every grouping in ONE query and routes its rows by grouping", async () => {
    const texts: string[] = [];
    (db.read as unknown as Record<string, unknown>).$queryRaw = vi.fn(async (q: { sql?: string } | string[]) => {
      const text = Array.isArray(q) ? q.join("?") : String(q.sql);
      texts.push(text);
      if (!text.includes("UNION ALL")) return [{ pmid: "9" }];
      return [
        { k: "all", g: "all", st: "T0", n: 3n },
        { k: "all", g: "all", st: null, n: 2n },
        { k: "year", g: 2024, st: "T0", n: 3n },
        { k: "year", g: 2025, st: "low-or-other", n: 2 },
        { k: "area", g: "a1", st: "T0", n: 3n },
        { k: "dept", g: "dept:x", st: "T1", n: 1n },
        { k: "dept", g: null, st: "T1", n: 7n },
      ];
    });
    const choices: PortfolioChoices = {
      facets: { roleCategories: [], departments: [], centers: [], institutions: [] },
      labels: new Map(),
      areas: [],
    };
    // The Publications list, so the page asks for its pmids (the Scholars list is the default).
    const p = parsePortfolioParams(new URLSearchParams("from=2024&to=2025&view=activities"));
    const d = await loadPortfolio(p, choices);
    expect(texts.filter((t) => t.includes("UNION ALL"))).toHaveLength(1);
    expect(d.all).toEqual(c(3, 0, 0, 0, 2));
    expect(d.byYear).toEqual([
      { year: 2024, counts: c(3, 0, 0, 0, 0) },
      { year: 2025, counts: c(0, 0, 0, 0, 2) },
    ]);
    expect(d.table.map((r) => [r.key, r.counts])).toEqual([["dept:x", c(0, 1, 0, 0, 0)]]);
    expect(d.activities.pmids).toEqual(["9"]);
    expect(d.areaOrder).toEqual(["a1"]);
  });
});

describe("loadPortfolio's institution filter", () => {
  it("narrows every count to the institution's scholars, but not the all-of-WCM baseline", async () => {
    const seen: { inst: boolean; unit: boolean }[] = [];
    (db.read as unknown as Record<string, unknown>).$queryRaw = vi.fn(async (q: { sql?: string; values?: unknown[] }) => {
      const text = String(q.sql);
      seen.push({ inst: /s\.primary_org_code IN/.test(text) && (q.values ?? []).includes("HSS"), unit: (q.values ?? []).includes("N1") });
      return [];
    });
    const choices: PortfolioChoices = { facets: { roleCategories: [], departments: [], centers: [], institutions: [] }, labels: new Map(), areas: [] };
    await loadPortfolio(parsePortfolioParams(new URLSearchParams("unit=dept:N1&inst=HSS&from=2024&to=2025")), choices);
    // Every unit-scoped query carries the institution; the one without the unit (the baseline) does not.
    expect(seen.length).toBeGreaterThan(1);
    for (const q of seen) expect(q.inst).toBe(q.unit);
    expect(seen.filter((q) => !q.unit)).toHaveLength(1);
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
