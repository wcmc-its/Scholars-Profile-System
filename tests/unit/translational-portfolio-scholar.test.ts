/**
 * Report 26 for one scholar (`lib/edit/translational-portfolio-scholar.ts`
 * and its `.xlsx` route): who may open it (report 26 on AND
 * `authorizeCvExport`, then the existence and hidden-class guards, one 404 for
 * every refusal so a CWID's existence never shows), the authorship rule in the
 * SQL (first or senior by default, middle-author papers with
 * `authorship=all`, never `position`), the role and area rules on the rows,
 * the squares / stacked bars threshold, the URL round-trip and the report's
 * `?cwid=` hand-off, and the workbook. The db is mocked; fixture CWIDs, names
 * and papers are invented.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  identity: vi.fn(),
  authz: vi.fn(),
  denial: vi.fn(),
  findScholar: vi.fn(),
  queryRaw: vi.fn(),
  topics: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      $queryRaw: h.queryRaw,
      scholar: { findUnique: h.findScholar },
      topic: { findMany: h.topics },
    },
    write: {},
  },
  prisma: {},
}));
vi.mock("@/lib/edit/request", () => ({ resolveEditIdentity: h.identity }));
vi.mock("@/lib/edit/overview-authz", () => ({ authorizeCvExport: h.authz }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: h.denial }));
vi.mock("@/lib/edit/translational-portfolio-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/translational-portfolio-report")>()),
  isTranslationalPortfolioReportEnabled: h.enabled,
}));

import { GET } from "@/app/api/edit/reports/translational-portfolio-scholar/route";
import {
  buildScholarPortfolioWorkbook,
  loadScholarPortfolio,
  papersByYear,
  parseScholarPortfolioParams,
  portfolioCwidRedirect,
  reportHrefFor,
  resolveScholarPortfolioAccess,
  scholarPapersSql,
  scholarPortfolioHref,
  scholarPortfolioQueryString,
  stageSpan,
  WAFFLE_MAX_PER_YEAR,
  yearChartKind,
  type ScholarPaper,
} from "@/lib/edit/translational-portfolio-scholar";
import { parsePortfolioParams } from "@/lib/edit/translational-portfolio-report";
import { emptyCounts } from "@/lib/translational-stage";

const VIEWER = { cwid: "view001", isSuperuser: false, isCommsSteward: false };
const SCHOLAR_ROW = {
  preferredName: "Example Person",
  postnominal: "MD, PhD",
  roleCategory: "full_time_faculty",
  deletedAt: null,
  status: "active",
  primaryTitle: "Professor of Examples",
  primaryDepartment: "Examples",
  slug: "example-person",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled.mockReturnValue(true);
  h.identity.mockResolvedValue({ session: VIEWER, realCwid: VIEWER.cwid, impersonatedCwid: null });
  h.authz.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
  h.findScholar.mockResolvedValue(SCHOLAR_ROW);
  h.queryRaw.mockResolvedValue([]);
  h.topics.mockResolvedValue([]);
});

/** A Prisma.Sql, or a tagged-template call's strings, as one line of SQL. */
const sqlText = (q: { sql: string } | readonly string[]) =>
  (Array.isArray(q) ? q.join("?") : (q as { sql: string }).sql).replace(/\s+/g, " ");

describe("who may open one scholar's portfolio", () => {
  it("lets in a viewer authorizeCvExport allows, asked about exactly this scholar, and names them as the profile does", async () => {
    const got = await resolveScholarPortfolioAccess("abc1234", "/x");
    expect(h.authz).toHaveBeenCalledWith(
      expect.objectContaining({
        session: VIEWER,
        realCwid: "view001",
        impersonatedCwid: null,
        entityId: "abc1234",
      }),
    );
    expect(got).toMatchObject({
      kind: "ok",
      scholar: {
        cwid: "abc1234",
        name: "Example Person, MD, PhD",
        title: "Professor of Examples",
        slug: "example-person",
      },
    });
  });

  it("refuses a viewer authorizeCvExport refuses, without reading the scholar, and logs it", async () => {
    h.authz.mockResolvedValue({ ok: false, reason: "not_authorized" });
    expect(await resolveScholarPortfolioAccess("abc1234", "/x")).toEqual({ kind: "denied" });
    expect(h.findScholar).not.toHaveBeenCalled();
    expect(h.denial).toHaveBeenCalledWith(
      expect.objectContaining({ targetCwid: "abc1234", reason: "not_authorized" }),
    );
  });

  it("answers an unknown CWID exactly as a refusal, so existence never shows", async () => {
    h.findScholar.mockResolvedValue(null);
    const unknown = await resolveScholarPortfolioAccess("zzz9999", "/x");
    h.findScholar.mockResolvedValue(SCHOLAR_ROW);
    h.authz.mockResolvedValue({ ok: false, reason: "not_authorized" });
    const refused = await resolveScholarPortfolioAccess("abc1234", "/x");
    expect(unknown).toEqual(refused);
    h.findScholar.mockResolvedValue({ ...SCHOLAR_ROW, deletedAt: new Date() });
    h.authz.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
    expect(await resolveScholarPortfolioAccess("abc1234", "/x")).toEqual(refused);
  });

  it("refuses a scholar who is not active (report 8 counts no one else), to everyone, as the same 404", async () => {
    const su = { ...VIEWER, isSuperuser: true };
    h.identity.mockResolvedValue({ session: su, realCwid: su.cwid, impersonatedCwid: null });
    for (const status of ["suppressed", "external"]) {
      h.findScholar.mockResolvedValue({ ...SCHOLAR_ROW, status });
      expect(await resolveScholarPortfolioAccess("abc1234", "/x")).toEqual({ kind: "denied" });
    }
  });

  it("hides a hidden identity class from everyone but a superuser", async () => {
    h.findScholar.mockResolvedValue({ ...SCHOLAR_ROW, roleCategory: "doctoral_student_phd" });
    expect((await resolveScholarPortfolioAccess("abc1234", "/x")).kind).toBe("denied");
    const su = { ...VIEWER, isSuperuser: true };
    h.identity.mockResolvedValue({ session: su, realCwid: su.cwid, impersonatedCwid: null });
    expect((await resolveScholarPortfolioAccess("abc1234", "/x")).kind).toBe("ok");
  });

  it("is closed while report 26 is off, and asks for a login with no session", async () => {
    h.enabled.mockReturnValue(false);
    expect(await resolveScholarPortfolioAccess("abc1234", "/x")).toEqual({ kind: "denied" });
    expect(h.identity).not.toHaveBeenCalled();
    h.enabled.mockReturnValue(true);
    h.identity.mockResolvedValue(null);
    expect(await resolveScholarPortfolioAccess("abc1234", "/x")).toEqual({ kind: "login" });
    expect(await resolveScholarPortfolioAccess("not a cwid!", "/x")).toEqual({ kind: "denied" });
  });
});

describe("the download route", () => {
  const get = (qs: string) =>
    GET(new Request(`http://localhost/api/edit/reports/translational-portfolio-scholar?${qs}`));

  it("re-checks the page's gate: 401 with no session, 404 when refused or unknown", async () => {
    h.identity.mockResolvedValue(null);
    expect((await get("cwid=abc1234")).status).toBe(401);
    h.identity.mockResolvedValue({
      session: VIEWER,
      realCwid: VIEWER.cwid,
      impersonatedCwid: null,
    });
    h.authz.mockResolvedValue({ ok: false, reason: "not_authorized" });
    expect((await get("cwid=abc1234")).status).toBe(404);
    expect(h.queryRaw).not.toHaveBeenCalled();
    h.authz.mockResolvedValue({ ok: true, viaUnitAdminUnit: null });
    h.findScholar.mockResolvedValue(null);
    expect((await get("cwid=zzz9999")).status).toBe(404);
  });

  it("sends this scholar's papers, grants and trials, and the criteria", async () => {
    h.queryRaw.mockImplementation(async (q: { sql: string }) =>
      sqlText(q).includes("publication_topic")
        ? []
        : [
            {
              pmid: "9001",
              title: "An example paper",
              journal: "J Examples",
              y: 2022,
              f: 1,
              l: 0,
              st: "T1",
            },
          ],
    );
    const res = await get("cwid=abc1234&from=2021&to=2023");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Publications", "Grants", "Clinical trials", "Criteria"]);
    const rows = wb
      .getWorksheet("Publications")!
      .getSheetValues()
      .slice(1)
      .map((r) => (r as unknown[]).slice(1));
    expect(rows).toEqual([
      ["PMID", "Title", "Journal", "Year", "Author role", "Translational stage"],
      ["9001", "An example paper", "J Examples", 2022, "First", "T1 · Early translation"],
    ]);
  });
});

describe("the authorship rule", () => {
  const P = parseScholarPortfolioParams(new URLSearchParams("from=2020&to=2025"));

  it("counts first- or senior-author papers by default, and adds middle-author ones with authorship=all", () => {
    const dflt = sqlText(scholarPapersSql("abc1234", P));
    expect(dflt).toContain("AND (pa.is_first = 1 OR pa.is_last = 1)");
    const all = sqlText(
      scholarPapersSql(
        "abc1234",
        parseScholarPortfolioParams(new URLSearchParams("from=2020&to=2025&authorship=all")),
      ),
    );
    expect(all).not.toMatch(/is_first = 1|is_last = 1/);
    // Both are this scholar's confirmed authorships in the window.
    for (const s of [dflt, all]) {
      expect(s).toContain("pa.is_confirmed = 1");
      expect(s).toContain("AND pa.cwid = ?");
      expect(s).toContain("AND p.year BETWEEN ? AND ?");
    }
  });

  it("never reads the role from position (0 there means rank unknown)", () => {
    for (const qs of ["", "authorship=all"]) {
      expect(
        sqlText(scholarPapersSql("abc1234", parseScholarPortfolioParams(new URLSearchParams(qs)))),
      ).not.toMatch(/position/i);
    }
  });

  it("names the role from the flags: first, else senior, else middle", async () => {
    h.queryRaw.mockImplementation(async (q: { sql: string }) =>
      sqlText(q).includes("publication_topic")
        ? []
        : [
            { pmid: "1", title: "a", journal: null, y: 2024, f: 1, l: 1, st: null },
            { pmid: "2", title: "b", journal: null, y: 2024, f: 0, l: 1, st: "T0" },
            { pmid: "3", title: "c", journal: null, y: 2023, f: false, l: false, st: "NA" },
          ],
    );
    const d = await loadScholarPortfolio("abc1234", { ...P, middle: true });
    expect(d.papers.map((x) => [x.pmid, x.role, x.stage])).toEqual([
      ["1", "First", null],
      ["2", "Senior", "T0"],
      ["3", "Middle", null],
    ]);
  });
});

describe("research areas", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    pmid: String(i + 1),
    title: "t",
    journal: null,
    y: 2024,
    f: 1,
    l: 0,
    st: i < 3 ? "T0" : "T2",
  }));
  // area_a: papers 1-3; area_b: papers 3-5; area_c: paper 5 only.
  const topics = [
    ...["1", "2", "3"].map((pmid) => ({ pmid, g: "area_a" })),
    ...["3", "4", "5"].map((pmid) => ({ pmid, g: "area_b" })),
    { pmid: "5", g: "area_c" },
  ];
  beforeEach(() => {
    h.queryRaw.mockImplementation(async (q: { sql: string }) =>
      sqlText(q).includes("publication_topic") ? topics : rows,
    );
    h.topics.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({
        id,
        label: `Area ${id}`,
        description: id === "area_a" ? "About area a." : null,
      })),
    );
  });

  it("lists the areas with at least 3 papers, at the report's score floor, with their stage counts", async () => {
    const d = await loadScholarPortfolio(
      "abc1234",
      parseScholarPortfolioParams(new URLSearchParams()),
    );
    expect(d.areas.map((a) => [a.id, a.n, a.counts.T0, a.counts.T2, a.description])).toEqual([
      ["area_a", 3, 3, 0, "About area a."],
      ["area_b", 3, 1, 2, null],
    ]);
    expect(d.areaChoices.map((a) => a.id)).toEqual(["area_a", "area_b"]);
    const topicSql = h.queryRaw.mock.calls
      .map((c) => sqlText(c[0]))
      .find((s) => s.includes("publication_topic"))!;
    expect(topicSql).toContain("pt.score >= ?");
  });

  it("narrows the papers to a checked area, keeps the rail's other areas, and keeps a checked small one", async () => {
    const d = await loadScholarPortfolio(
      "abc1234",
      parseScholarPortfolioParams(new URLSearchParams("area=area_c")),
    );
    expect(d.papers.map((x) => x.pmid)).toEqual(["5"]);
    expect(d.areaChoices.map((a) => [a.id, a.n])).toEqual([
      ["area_a", 3],
      ["area_b", 3],
      ["area_c", 1],
    ]);
  });

  it("with an area checked, lists only the checked areas, each counting every one of its papers", async () => {
    // area_a: papers 1-4; area_b: papers 2-5, so 3 papers in both.
    const overlap = [
      ...["1", "2", "3", "4"].map((pmid) => ({ pmid, g: "area_a" })),
      ...["2", "3", "4", "5"].map((pmid) => ({ pmid, g: "area_b" })),
    ];
    h.queryRaw.mockImplementation(async (q: { sql: string }) =>
      sqlText(q).includes("publication_topic") ? overlap : rows,
    );
    const d = await loadScholarPortfolio(
      "abc1234",
      parseScholarPortfolioParams(new URLSearchParams("area=area_a")),
    );
    // area_b's 3 here would be the overlap, which no link opens: not listed.
    expect(d.papers.map((x) => x.pmid)).toEqual(["1", "2", "3", "4"]);
    expect(d.areas.map((a) => [a.id, a.n])).toEqual([["area_a", 4]]);
    const both = await loadScholarPortfolio(
      "abc1234",
      parseScholarPortfolioParams(new URLSearchParams("area=area_a&area=area_b")),
    );
    expect(both.areas.map((a) => [a.id, a.n])).toEqual([
      ["area_a", 4],
      ["area_b", 4],
    ]);
  });

  it("describes an area's stage range", () => {
    expect(stageSpan({ ...emptyCounts(), T0: 2, "T3-4": 1 })).toBe("Runs T0 to T3–4");
    expect(stageSpan({ ...emptyCounts(), T2: 4 })).toBe("T2 only");
    expect(stageSpan({ ...emptyCounts(), none: 4 })).toBe("No papers with a stage");
  });
});

describe("the year chart", () => {
  const papers = (n: number, year = 2024): ScholarPaper[] =>
    Array.from({ length: n }, (_, i) => ({
      pmid: `${year}${i}`,
      title: "t",
      journal: null,
      year,
      role: "First",
      stage: null,
      areas: [],
    }));

  it(`draws squares up to ${WAFFLE_MAX_PER_YEAR} papers in the busiest year, stacked bars past it`, () => {
    expect(yearChartKind(papersByYear(papers(WAFFLE_MAX_PER_YEAR), 2023, 2025))).toBe("squares");
    expect(yearChartKind(papersByYear(papers(WAFFLE_MAX_PER_YEAR + 1), 2023, 2025))).toBe("bars");
    expect(yearChartKind(papersByYear([], 2023, 2025))).toBe("squares");
  });

  it("has every year of the window, zeros included", () => {
    expect(papersByYear(papers(2, 2024), 2023, 2025).map((r) => [r.year, r.counts.none])).toEqual([
      [2023, 0],
      [2024, 2],
      [2025, 0],
    ]);
  });
});

describe("the URL", () => {
  it("round-trips every selection, with the report's state apart in r", () => {
    const qs = `from=2021&to=2024&area=area_a&authorship=all&stage=none&page=3&r=${encodeURIComponent("unit=dept%3AN1&from=2020&to=2026&inst=INST1&by=area")}`;
    const p = parseScholarPortfolioParams(new URLSearchParams(qs));
    expect(p).toMatchObject({ from: 2021, to: 2024, areas: ["area_a"], middle: true, stage: "none", page: 3 });
    expect(scholarPortfolioQueryString(p)).toBe(qs);
    expect(parseScholarPortfolioParams(new URLSearchParams("stage=T5&authorship=yes"))).toMatchObject({ stage: null, middle: false });
  });

  it("never lets the page's own filters into the link back, so they never reach the report or the next scholar", () => {
    const opened = new URLSearchParams(scholarPortfolioHref("abc1234", parsePortfolioParams(new URLSearchParams("unit=dept:N1&from=2021&to=2024")))!.split("?")[1]);
    // Tick an area, include middle authors, filter the list: the page's own state.
    opened.append("area", "area_b");
    opened.set("authorship", "all");
    opened.set("stage", "T0");
    const p = parseScholarPortfolioParams(opened);
    expect(p.areas).toEqual(["area_b"]);
    expect(reportHrefFor("/r", p)).toBe("/r?unit=dept%3AN1&from=2021&to=2024");
    // A link from before `r` reads only the report's keys, never the list's stage or page.
    expect(parseScholarPortfolioParams(new URLSearchParams("unit=dept:N1&from=2021&to=2024&stage=T0&page=3")).back).toBe(
      "unit=dept%3AN1&from=2021&to=2024",
    );
    // `r` is re-serialized by the report's parser: only report filters, never a scholar.
    expect(parseScholarPortfolioParams(new URLSearchParams("r=cwid%3Dxyz9%26from%3D2021%26junk%3D1")).back).not.toMatch(/cwid|junk/);
  });

  it("sends report 26's ?cwid= to the scholar's page, seeded from the report and keeping its whole state for the way back", () => {
    const href = portfolioCwidRedirect(
      new URLSearchParams("cwid=abc1234&unit=dept:N1&from=2021&to=2024&area=area_a&inst=INST1&stage=T2&view=activities&page=4"),
    )!;
    const [path, qs] = href.split("?");
    expect(path).toBe("/edit/scholar/abc1234/translational-portfolio");
    const sp = new URLSearchParams(qs);
    expect([...sp.keys()]).toEqual(["from", "to", "area", "r"]);
    expect(sp.get("r")).toBe("unit=dept%3AN1&from=2021&to=2024&area=area_a&inst=INST1&stage=T2&view=activities&page=4");
    expect(portfolioCwidRedirect(new URLSearchParams("unit=dept:N1"))).toBeNull();
    // Report 8's `unit=inst:CODE` form carries the institution too.
    expect(new URLSearchParams(portfolioCwidRedirect(new URLSearchParams("cwid=abc1234&unit=inst:INST2&unit=dept:N1"))!.split("?")[1]).get("r")).toMatch(
      /^unit=dept%3AN1&from=\d+&to=\d+&inst=INST2$/,
    );
  });
});

describe("the workbook", () => {
  it("applies the list's stage filter and states the criteria", async () => {
    const p = parseScholarPortfolioParams(new URLSearchParams("from=2020&to=2025&stage=none"));
    const mk = (pmid: string, stage: ScholarPaper["stage"]): ScholarPaper => ({
      pmid,
      title: "t",
      journal: null,
      year: 2024,
      role: "Middle",
      stage,
      areas: [],
    });
    const buf = await buildScholarPortfolioWorkbook(
      p,
      {
        cwid: "abc1234",
        name: "Example Person",
        preferredName: "Example Person",
        title: null,
        department: null,
        slug: null,
      },
      { papers: [mk("1", "T0"), mk("2", null)], areaChoices: [], areas: [], grants: [], trials: [] },
      new Date("2026-11-27T00:00:00Z"),
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Publications")!.rowCount).toBe(2);
    const criteria = Object.fromEntries(
      wb
        .getWorksheet("Criteria")!
        .getSheetValues()
        .slice(1)
        .map((r) => (r as unknown[]).slice(1, 3)),
    );
    expect(criteria.Scholar).toBe("Example Person (abc1234)");
    expect(criteria.Authorship).toBe("First- or senior-author publications only.");
    expect(criteria["Translational stage"]).toBe("No stage only");
  });
});

describe("the grants sheet", () => {
  it("gives each award its stage, or No stage, and states the grant stage rule", async () => {
    const grant = (key: string, stage: "T2" | null) => ({
      key,
      title: `Award ${key}`,
      funder: "NCI",
      awardNumber: null,
      start: "2021-01-01",
      end: "2023-12-31",
      years: [2021],
      people: [{ cwid: "abc1234", role: "PI" }],
      deptCodes: [],
      areas: [],
      stage,
    });
    const buf = await buildScholarPortfolioWorkbook(
      parseScholarPortfolioParams(new URLSearchParams("from=2020&to=2025")),
      { cwid: "abc1234", name: "Example Person", preferredName: "Example Person", title: null, department: null, slug: null },
      { papers: [], areaChoices: [], areas: [], grants: [grant("a", "T2"), grant("b", null)], trials: [] },
      new Date("2026-11-28T00:00:00Z"),
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const rows = wb.getWorksheet("Grants")!.getSheetValues().slice(1).map((r) => (r as unknown[]).slice(1));
    expect(rows[0].at(-1)).toBe("Translational stage");
    expect(rows.slice(1).map((r) => r.at(-1))).toEqual(["T2 · Clinical trials and efficacy", "No stage"]);
    const criteria = Object.fromEntries(
      wb.getWorksheet("Criteria")!.getSheetValues().slice(1).map((r) => (r as unknown[]).slice(1, 3)),
    );
    expect(criteria["Grant stage rule"]).toMatch(/^A grant's stage comes from ReciterAI's reading of its abstract/);
  });
});
