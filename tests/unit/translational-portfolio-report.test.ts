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
  describePortfolioCriteria,
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
  it("falls back on bad values and defaults to 2020 through the current year", () => {
    const p = parsePortfolioParams(new URLSearchParams("stage=NA&stage=T9&by=nope&view=x&area=<x>&cwid=a;b&unit=inst:X"));
    const y = new Date().getUTCFullYear();
    expect(p).toMatchObject({ stages: [], by: "dept", view: "scholars", areas: [], gaps: false, allRows: false, cwid: null, units: [], from: 2020, to: y });
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
    grants: 7,
    trials: 2,
    byYear: [{ year: 2025, counts: c(4, 3, 2, 1, 0), grants: 7, trials: 2, trialCounts: c(0, 1, 1, 0, 0), grantCounts: c(1, 2, 0, 1, 3) }],
    trialStages: { all: c(0, 1, 1, 0, 0), baseline: c(0, 5, 10, 2, 3) },
    grantStages: { all: c(1, 2, 0, 1, 3), baseline: c(10, 20, 15, 5, 20) },
    baseline: c(4, 3, 2, 1, 0),
    baselineActivities: { grants: 70, trials: 20 },
    table: [
      { key: "a1", label: "Area one", href: "", note: "12 scholars", noteHref: null, gaps: ["T1", "T3-4"], counts: c(60, 1, 20, 1, 9), grants: 5, trials: 1, trialCounts: c(0, 0, 1, 0, 0), grantCounts: c(0, 3, 0, 0, 2) },
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
        grants: 1,
        trials: 0,
      })),
    },
    person: null,
      activities: { total: 10, pmids: [] },
    grantList: { total: 0, rows: [] },
    trialList: { total: 0, rows: [] },
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
    expect(head.slice(10)).toEqual([
      "Stage assigned (%)",
      "T0 share of staged (%)",
      "T1 share of staged (%)",
      "T2 share of staged (%)",
      "T3–4 share of staged (%)",
      "Grants",
      "Clinical trials",
      "Trials: T0",
      "Trials: T1",
      "Trials: T2",
      "Trials: T3–4",
      "Trials: No stage",
      "Grants: T0",
      "Grants: T1",
      "Grants: T2",
      "Grants: T3–4",
      "Grants: No stage",
    ]);
    // Area one: 82 staged of 91; 60/1/20/1 of the 82 staged (T2 takes the leftover point); then 5 grants, 1 trial (T2),
    // and the 5 grants by stage (3 in T1, 2 with none).
    expect((ws.getRow(3).values as unknown[]).slice(10)).toEqual([90, 73, 1, 25, 1, 5, 1, 0, 0, 1, 0, 0, 0, 3, 0, 0, 2]);
    // The all-of-WCM row carries the baseline grants and trials, and both series' stages.
    expect((ws.getRow(2).values as unknown[]).slice(15)).toEqual([70, 20, 0, 5, 10, 2, 3, 10, 20, 15, 5, 20]);
  });
  it("counts grants and trials by year and in total, once each in the total, each by stage", async () => {
    const ws = (await sheet(0)).getWorksheet("By year")!;
    expect((ws.getRow(1).values as unknown[]).slice(-12, -10)).toEqual(["Grants", "Clinical trials"]);
    expect((ws.getRow(1).values as unknown[]).slice(-5)).toEqual(["Grants: T0", "Grants: T1", "Grants: T2", "Grants: T3–4", "Grants: No stage"]);
    expect((ws.getRow(2).values as unknown[]).slice(-12)).toEqual([7, 2, 0, 1, 1, 0, 0, 1, 2, 0, 1, 3]);
    expect((ws.getRow(3).values as unknown[]).slice(-12)).toEqual([7, 2, 0, 1, 1, 0, 0, 1, 2, 0, 1, 3]);
  });
  it("states the grant stage rule and that the stage filter applies to grants", () => {
    const rows = new Map(describePortfolioCriteria(parsePortfolioParams(new URLSearchParams("act=grants")), choices, new Date(0)));
    expect(rows.get("Grant stage rule")).toMatch(/^A grant's stage comes from ReciterAI's reading of its abstract; grants with only a title have no stage\./);
    expect(rows.get("Record type")).toBe("Research articles, grants and clinical trials. Each has its own stages, and the stage filter applies to all three lists.");
    expect(rows.get("Stages shown on the page")).toBe("Grants");
    for (const v of rows.values()) expect(v).not.toMatch(/no stage yet|not yet assigned|—/i);
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
      { year: 2024, counts: c(3, 0, 0, 0, 0), grants: 0, trials: 0, trialCounts: c(0, 0, 0, 0, 0), grantCounts: c(0, 0, 0, 0, 0) },
      { year: 2025, counts: c(0, 0, 0, 0, 2), grants: 0, trials: 0, trialCounts: c(0, 0, 0, 0, 0), grantCounts: c(0, 0, 0, 0, 0) },
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
      "lib/edit/translational-portfolio-scholar.ts",
      "components/edit/reports/translational-portfolio-scholar-body.tsx",
      "components/edit/reports/translational-portfolio-scholar-client.tsx",
      "app/edit/scholar/[cwid]/translational-portfolio/page.tsx",
    ]) {
      // A trial's own phase is fine, named as such ("Trial phase"); a stage never is.
      const text = readFileSync(path.resolve(__dirname, "../..", f), "utf8").replace(/\btrial phases?\b/gi, "");
      expect(text, f).not.toMatch(/\bphases?\b/i);
    }
  });
});

describe("loadPortfolio's grants and trials", () => {
  it("counts each award once per department, scholar and active year, beside the publications", async () => {
    const reads = db.read as unknown as Record<string, unknown>;
    reads.suppression = { findMany: vi.fn(async () => []) };
    reads.areaSignalTopic = { findMany: vi.fn(async () => []) };
    reads.scholar = { findMany: vi.fn(async () => [{ cwid: "aaa1001", preferredName: "Example Person", primaryTitle: null, primaryDepartment: null, slug: null }]) };
    reads.$queryRaw = vi.fn(async (q: { sql?: string; values?: unknown[] }) => {
      const text = String(q.sql);
      if (text.includes("FROM `grant` g"))
        return [
          { id: "1", cwid: "aaa1001", title: "T", role: "PI", funder: "NCI", award_number: "1 R01 CA000001-01", external_id: "INFOED-1-aaa1001", intake_type: "Grant", start_date: new Date("2023-01-01T00:00:00Z"), end_date: new Date("2025-12-31T00:00:00Z"), area_text_key: null, dc: "x" },
          { id: "2", cwid: "bbb2002", title: "T", role: "Co-PI", funder: "NCI", award_number: "1 R01 CA000001-01", external_id: "INFOED-1-bbb2002", intake_type: "Grant", start_date: new Date("2023-01-01T00:00:00Z"), end_date: new Date("2025-12-31T00:00:00Z"), area_text_key: null, dc: "x" },
        ];
      if (text.includes("person_clinical_trial")) return [];
      // A grouping's name is a bound value: the Scholars list's query groups by cwid.
      if (text.includes("WITH x AS"))
        return (q.values ?? []).includes("cwid") ? [{ k: "cwid", g: "aaa1001", st: "T1", n: 4n }] : [{ k: "dept", g: "x", st: "T1", n: 4n }];
      return [];
    });
    // A window no other test uses: the grouped counts are cached by their SQL (`cachedRead`).
    const d = await loadPortfolio(parsePortfolioParams(new URLSearchParams("from=2023&to=2025")), {
      facets: { roleCategories: [], departments: [], centers: [], institutions: [] },
      labels: new Map(),
      areas: [],
    });
    expect(d.grants).toBe(1);
    expect(d.byYear.map((y) => y.grants)).toEqual([1, 1, 1]);
    expect(d.table.map((r) => [r.key, r.grants, r.trials])).toEqual([["x", 1, 0]]);
    expect(d.scholars.rows.map((s) => [s.cwid, s.grants])).toEqual([["aaa1001", 1]]);
  });
});

describe("loadPortfolio's trial stages", () => {
  const trialRow = (pn: string, phase: string, dc: string) => ({
    protocol_number: pn, nct_number: `NCT-${pn}`, title: "T", phase, status: "OPEN TO ACCRUAL", status_date: null, ctgov_status: null,
    start_date: "2023-01", start_date_type: "ACTUAL", primary_completion_date: null, primary_completion_date_type: null,
    first_ota_date: null, area_text_key: null, cwid: "aaa1001", role: "Principal Investigator", dc,
  });
  const choices = { facets: { roleCategories: [], departments: [], centers: [], institutions: [] }, labels: new Map(), areas: [] } as PortfolioChoices;
  const mock = (pubRows: { k: string; g: string; st: string; n: bigint }[]) => {
    const reads = db.read as unknown as Record<string, unknown>;
    reads.suppression = { findMany: vi.fn(async () => []) };
    reads.areaSignalTopic = { findMany: vi.fn(async () => []) };
    reads.scholar = { findMany: vi.fn(async () => []) };
    const calls: { sql: string; values: unknown[] }[] = [];
    reads.$queryRaw = vi.fn(async (q: { sql?: string; values?: unknown[] }) => {
      const text = String(q.sql);
      calls.push({ sql: text, values: q.values ?? [] });
      if (text.includes("person_clinical_trial"))
        return [trialRow("1", "PHASE1", "a"), trialRow("2", "PHASE3", "b"), trialRow("3", "PHASE3", "b"), trialRow("4", "NA", "a")];
      if (text.includes("WITH x AS")) return pubRows;
      return [];
    });
    return calls;
  };

  it("counts each row's trials by stage, sorts by them under act=trials, and keeps the publications as they were", async () => {
    mock([
      { k: "dept", g: "a", st: "T0", n: 50n },
      { k: "dept", g: "b", st: "T0", n: 5n },
    ]);
    // A window no other test uses: grouped counts are cached by their SQL.
    const d = await loadPortfolio(parsePortfolioParams(new URLSearchParams("from=2022&to=2026&act=trials&stage=T2&view=trials")), choices);
    expect(d.trialStages.all).toEqual(c(0, 1, 2, 0, 1));
    // Sorted by share of staged trials in the pick (T2): b (2 of 2) before a (0 of 1).
    expect(d.table.map((r) => [r.key, r.trialCounts, countsTotal(r.counts)])).toEqual([
      ["b", c(0, 0, 2, 0, 0), 5],
      ["a", c(0, 1, 0, 0, 1), 50],
    ]);
    // The Trials list follows the stage pick; the tile total does not.
    expect(d.trialList.total).toBe(2);
    expect(d.trials).toBe(4);
    expect(d.byYear.find((y) => y.year === 2024)?.trialCounts).toEqual(c(0, 1, 2, 0, 1));
  });

  it("loads all of WCM's trials for the baseline row on a unit view under act=trials only", async () => {
    const calls = mock([]);
    await loadPortfolio(parsePortfolioParams(new URLSearchParams("unit=dept:a&from=2021&to=2026")), choices);
    expect(calls.filter((q) => q.sql.includes("person_clinical_trial"))).toHaveLength(1);
    calls.length = 0;
    const d = await loadPortfolio(parsePortfolioParams(new URLSearchParams("unit=dept:a&from=2021&to=2026&act=trials")), choices);
    expect(calls.filter((q) => q.sql.includes("person_clinical_trial"))).toHaveLength(2);
    expect(d.trialStages.baseline).toEqual(c(0, 1, 2, 0, 1));
  });

  it("round-trips act in the query string", () => {
    const p = parsePortfolioParams(new URLSearchParams("act=trials"));
    expect(p.act).toBe("trials");
    expect(portfolioQueryString(p)).toContain("act=trials");
    expect(portfolioQueryString(parsePortfolioParams(new URLSearchParams("act=bogus")))).not.toContain("act=");
  });
});

describe("loadPortfolio's grant stages", () => {
  // One row per project (distinct core project numbers); `st` / `conf` are the grant text's raw stage.
  const grantRow = (n: number, dc: string, st: string | null, conf: string | null = "high") => ({
    id: String(n), cwid: "aaa1001", title: `Award ${n}`, role: "PI", funder: "NCI", award_number: `1 R01 CA00000${n}-01`,
    external_id: `INFOED-${n}-aaa1001`, intake_type: "Grant", start_date: new Date("2023-01-01T00:00:00Z"),
    end_date: new Date("2025-12-31T00:00:00Z"), area_text_key: `k${n}`, stage: st, stage_confidence: conf, dc,
  });
  const choices = { facets: { roleCategories: [], departments: [], centers: [], institutions: [] }, labels: new Map(), areas: [] } as PortfolioChoices;
  const mock = (pubRows: { k: string; g: string; st: string; n: bigint }[]) => {
    const reads = db.read as unknown as Record<string, unknown>;
    reads.suppression = { findMany: vi.fn(async () => []) };
    reads.areaSignalTopic = { findMany: vi.fn(async () => []) };
    reads.scholar = { findMany: vi.fn(async () => []) };
    const calls: { sql: string; values: unknown[] }[] = [];
    reads.$queryRaw = vi.fn(async (q: { sql?: string; values?: unknown[] }) => {
      const text = String(q.sql);
      calls.push({ sql: text, values: q.values ?? [] });
      if (text.includes("FROM `grant` g"))
        return [
          grantRow(1, "a", "T0"),
          grantRow(2, "b", "T2"),
          grantRow(3, "b", "T2", null),
          grantRow(4, "a", "T1", "low"),
          grantRow(5, "a", "NA"),
          grantRow(6, "a", null, null),
        ];
      if (text.includes("WITH x AS")) return pubRows;
      return [];
    });
    return calls;
  };

  it("reads each grant text's stage beside the grant", async () => {
    const calls = mock([]);
    await loadPortfolio(parsePortfolioParams(new URLSearchParams("from=2027&to=2028")), choices);
    const sql = calls.find((q) => q.sql.includes("FROM `grant` g"))!.sql;
    expect(sql).toMatch(/LEFT JOIN area_signal_text ast ON ast\.text_key = g\.area_text_key/);
    expect(sql).toMatch(/ast\.translational_stage AS stage, ast\.translational_stage_confidence AS stage_confidence/);
  });

  it("counts grants by stage under act=grants, sorts the table by them, and filters the grants list by the pick", async () => {
    mock([
      { k: "dept", g: "a", st: "T0", n: 50n },
      { k: "dept", g: "b", st: "T0", n: 5n },
    ]);
    // A window no other test uses: grouped counts are cached by their SQL.
    const d = await loadPortfolio(parsePortfolioParams(new URLSearchParams("from=2019&to=2026&act=grants&stage=T2&view=grants")), choices);
    // T0, T2, T2 (no confidence is shown), then low confidence, NA and title-only: no stage.
    expect(d.grantStages.all).toEqual(c(1, 0, 2, 0, 3));
    expect(d.grants).toBe(6);
    // Sorted by share of staged grants in the pick (T2): b (2 of 2) before a (0 of 1).
    expect(d.table.map((r) => [r.key, r.grantCounts, r.grants, countsTotal(r.counts)])).toEqual([
      ["b", c(0, 0, 2, 0, 0), 2, 5],
      ["a", c(1, 0, 0, 0, 3), 4, 50],
    ]);
    // The Grants list follows the stage pick; the tile total does not.
    expect(d.grantList.total).toBe(2);
    expect(d.grantList.rows.map((g) => [g.title, g.stage])).toEqual([
      ["Award 2", "T2"],
      ["Award 3", "T2"],
    ]);
    expect(d.byYear.find((y) => y.year === 2024)?.grantCounts).toEqual(c(1, 0, 2, 0, 3));
    expect(d.byYear.find((y) => y.year === 2024)?.grants).toBe(6);
    expect(d.byYear.find((y) => y.year === 2020)?.grantCounts).toEqual(c(0, 0, 0, 0, 0));
  });

  it("loads all of WCM's grants for the baseline row on a unit view under act=grants only", async () => {
    const calls = mock([]);
    await loadPortfolio(parsePortfolioParams(new URLSearchParams("unit=dept:a&from=2018&to=2026")), choices);
    expect(calls.filter((q) => q.sql.includes("FROM `grant` g"))).toHaveLength(1);
    calls.length = 0;
    const d = await loadPortfolio(parsePortfolioParams(new URLSearchParams("unit=dept:a&from=2018&to=2026&act=grants")), choices);
    expect(calls.filter((q) => q.sql.includes("FROM `grant` g"))).toHaveLength(2);
    expect(d.grantStages.baseline).toEqual(c(1, 0, 2, 0, 3));
  });

  it("round-trips act=grants in the query string", () => {
    const p = parsePortfolioParams(new URLSearchParams("act=grants"));
    expect(p.act).toBe("grants");
    expect(portfolioQueryString(p)).toBe(`from=${p.from}&to=${p.to}&act=grants`);
  });
});

describe("research articles only (#3610)", () => {
  it("the report, its Publications list and the scholar page all scope to Academic Article", async () => {
    const { activityListScope, PORTFOLIO_ARTICLE_TYPES } = await import("@/lib/edit/translational-portfolio-report");
    const { scholarScope } = await import("@/lib/edit/translational-portfolio-scholar");
    expect(PORTFOLIO_ARTICLE_TYPES).toEqual(["Academic Article"]);
    const p = parsePortfolioParams(new URLSearchParams(""));
    expect(activityListScope(p, ["1"]).params.atypes).toEqual(["Academic Article"]);
    expect(scholarScope({ from: 2020, to: 2026, middle: false }).atypes).toEqual(["Academic Article"]);
  });
});

describe("person type (type)", () => {
  it("parses repeated type through parsePersonFilter and round-trips it; none is everyone", () => {
    const p = parsePortfolioParams(new URLSearchParams("unit=dept:N1&type=full_time_faculty&type=postdoc&type=full_time_faculty&type=<x>"));
    expect(p.types).toEqual(["full_time_faculty", "postdoc"]);
    expect(parsePortfolioParams(new URLSearchParams(portfolioQueryString(p)))).toEqual(p);
    expect(parsePortfolioParams(new URLSearchParams("from=2020&to=2024")).types).toEqual([]);
  });

  it("narrows every who-filtered query to the types, the all-of-WCM baseline, grants and trials included", async () => {
    const reads = db.read as unknown as Record<string, unknown>;
    reads.suppression = { findMany: vi.fn(async () => []) };
    reads.areaSignalTopic = { findMany: vi.fn(async () => []) };
    reads.scholar = { findMany: vi.fn(async () => []) };
    const calls: { sql: string; values: unknown[] }[] = [];
    reads.$queryRaw = vi.fn(async (q: { sql?: string; values?: unknown[] }) => {
      calls.push({ sql: String(q.sql), values: q.values ?? [] });
      return [];
    });
    const choices: PortfolioChoices = { facets: { roleCategories: [], departments: [], centers: [], institutions: [] }, labels: new Map(), areas: [] };
    // A window no other test uses: the grouped counts are cached by their SQL (`cachedRead`).
    await loadPortfolio(parsePortfolioParams(new URLSearchParams("unit=dept:N1&type=postdoc&from=2012&to=2013")), choices, { forExport: true });
    const typed = (q: { sql: string; values: unknown[] }) => /s\.role_category IN/.test(q.sql) && q.values.includes("postdoc");
    const grants = calls.filter((q) => q.sql.includes("FROM `grant` g"));
    const trials = calls.filter((q) => q.sql.includes("person_clinical_trial"));
    const pubs = calls.filter((q) => q.sql.includes("publication_author"));
    // The scope and the baseline, each for publications, grants and trials.
    expect(grants).toHaveLength(2);
    expect(trials).toHaveLength(2);
    expect(pubs.length).toBeGreaterThanOrEqual(2);
    for (const q of [...grants, ...trials, ...pubs]) expect(typed(q)).toBe(true);
    // The baseline drops the unit, never the type.
    expect([...grants, ...trials, ...pubs].filter((q) => !q.values.includes("N1")).length).toBeGreaterThanOrEqual(3);
  });

  it("states the types in the download's criteria", () => {
    const choices: PortfolioChoices = { facets: { roleCategories: [], departments: [], centers: [], institutions: [] }, labels: new Map(), areas: [] };
    const rows = new Map(describePortfolioCriteria(parsePortfolioParams(new URLSearchParams("type=full_time_faculty")), choices, new Date(0)));
    expect(rows.get("Person type")).toMatch(/faculty/i);
    expect(new Map(describePortfolioCriteria(parsePortfolioParams(new URLSearchParams("")), choices, new Date(0))).get("Person type")).toBe("All");
  });
});
