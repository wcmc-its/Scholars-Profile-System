/**
 * Report 8 (Article counts) — the one check per branch: param parsing and
 * clamping, the SQL the facets produce (FY expression, IN lists, the unit
 * OR clause with its center subquery, the JIF join, the position clause),
 * zero-filled years, the two workbook sheets and the gate.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/lib/generated/prisma/client";

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn(), facets: vi.fn(), grants: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      $queryRaw: h.queryRaw,
      scholar: { groupBy: h.groupBy },
      publication: { groupBy: h.groupBy },
      unitAdmin: { findFirst: h.findFirst },
      reportAccess: { findMany: h.grants },
    },
    write: {},
  },
}));

vi.mock("@/lib/api/data-quality", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/data-quality")>()),
  loadDataQualityFacets: h.facets,
}));

import { db } from "@/lib/db";
import {
  ARTICLE_COUNT_CAVEAT,
  ARTICLE_LIST_CAP,
  articleCountActiveFilters,
  articleCountQueryString,
  buildArticleCountWorkbook,
  canViewArticleCountReport,
  describeCriteria,
  loadArticleCountChoices,
  loadArticleCounts,
  loadArticleList,
  parseArticleCountParams,
  unitLabels,
} from "@/lib/edit/article-count-report";

const thisYear = new Date().getFullYear();
const today = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks();
  h.queryRaw.mockResolvedValue([]);
});

/** The `$queryRaw` tagged-template call, re-composed through `Prisma.sql` so
 *  the nested fragments flatten: the SQL with `?` placeholders + bound values. */
function lastSql(): { text: string; values: unknown[] } {
  const [strings, ...values] = h.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.sql.replace(/\s+/g, " "), values: sql.values };
}

describe("articleCountActiveFilters", () => {
  it("0 on defaults; one per selection, one per non-default scalar filter", () => {
    const d = parseArticleCountParams(new URLSearchParams());
    expect(articleCountActiveFilters(d)).toBe(0);
    expect(
      articleCountActiveFilters({ ...d, types: ["postdoc"], units: ["dept:A", "center:B"], atypes: ["Review"] }),
    ).toBe(4);
    expect(articleCountActiveFilters({ ...d, basis: "fy" })).toBe(1);
    expect(articleCountActiveFilters({ ...d, from: d.from - 1 })).toBe(1);
    expect(articleCountActiveFilters({ ...d, from: d.from - 1, to: d.to - 1 })).toBe(1);
    expect(articleCountActiveFilters({ ...d, jif: 5 })).toBe(1);
    expect(articleCountActiveFilters({ ...d, pos: "first" })).toBe(1);
  });
});

describe("parseArticleCountParams", () => {
  it("defaults: all facets open, no JIF floor, any position, calendar years ending this year", () => {
    expect(parseArticleCountParams(new URLSearchParams())).toEqual({
      types: [],
      units: [],
      atypes: [],
      jif: 0,
      pos: "any",
      basis: "cy",
      from: thisYear - 4,
      to: thisYear,
    });
  });

  it("reads repeated keys, clamps the JIF, rejects unknown enums, keeps to ≥ from", () => {
    const p = parseArticleCountParams(
      new URLSearchParams("type=postdoc&type=fellow&unit=dept:A&unit=inst:HSS&atype=Review&jif=999&pos=bogus&basis=fy&from=2020&to=2010"),
    );
    expect(p).toMatchObject({ types: ["postdoc", "fellow"], units: ["dept:A", "inst:HSS"], atypes: ["Review"], jif: 100, pos: "any", basis: "fy", from: 2020, to: 2020 });
    // Round-trips through the query string the page and the download share.
    expect(parseArticleCountParams(new URLSearchParams(articleCountQueryString(p)))).toEqual(p);
  });
});

const FACETS = {
  roleCategories: [{ value: "postdoc", label: "Postdoc", count: 3 }],
  departments: [
    { value: "dept:MED", label: "Medicine", count: 9, divisions: [{ value: "div:CARD", label: "Cardiology (Medicine)", count: 4 }] },
  ],
  centers: [{ value: "center:CC", label: "Cancer Center", count: 2 }],
  institutions: [{ value: "inst:HSS", label: "Hospital for Special Surgery", count: 1 }],
};

describe("loadArticleCountChoices / unitLabels", () => {
  it("reuses the Profiles facets on db.read, adds sorted article types, and labels every unit value", async () => {
    h.facets.mockResolvedValue(FACETS);
    h.groupBy.mockResolvedValue([{ publicationType: "Review" }, { publicationType: null }, { publicationType: "Journal Article" }]);
    const choices = await loadArticleCountChoices();
    expect(h.facets).toHaveBeenCalledWith(db.read);
    expect(choices).toEqual({ facets: FACETS, atypes: ["Journal Article", "Review"] });
    expect([...unitLabels(FACETS)]).toEqual([
      ["dept:MED", "Medicine"],
      ["div:CARD", "Cardiology (Medicine)"],
      ["center:CC", "Cancer Center"],
      ["inst:HSS", "Hospital for Special Surgery"],
    ]);
  });
});

describe("loadArticleCounts", () => {
  it("calendar basis groups on p.year with no JIF join and no facet clauses", async () => {
    await loadArticleCounts(parseArticleCountParams(new URLSearchParams("from=2024&to=2025")));
    const { text } = lastSql();
    expect(text).toContain("SELECT p.year AS y, COUNT(DISTINCT pa.pmid)");
    // The JIF table is always LEFT-joined (the Articles sheet shows it); no floor → no WHERE on it.
    expect(text).toContain("LEFT JOIN journal_impact_factor j ON j.journal_abbrev = p.journal_abbrev");
    expect(text).not.toContain("impact_score_1 >=");
    expect(text).not.toContain("IN (");
    expect(text).not.toContain("is_first");
  });

  it("fiscal basis shifts the PubMed add date by six months; facets, JIF and position each add their clause", async () => {
    await loadArticleCounts(
      parseArticleCountParams(
        new URLSearchParams(
          "basis=fy&type=full_time_faculty&unit=inst:HSS&unit=dept:MED&unit=center:CC&unit=div:CARD&unit=inst:MSKCC&unit=bogus&atype=Review&jif=10&pos=either&from=2025&to=2025",
        ),
      ),
    );
    const { text, values } = lastSql();
    expect(text).toContain("YEAR(DATE_ADD(p.date_added_to_entrez, INTERVAL 6 MONTH)) AS y");
    expect(text).toContain("AND j.impact_score_1 >= ?");
    expect(text).toContain("AND s.role_category IN (?)");
    // Units OR together (the Profiles roster's rule); a center is its date-active
    // members; the institution binds the ED CODE; an undecodable value is dropped.
    expect(text).toContain(
      "AND (s.dept_code IN (?) OR s.div_code IN (?) OR s.primary_org_code IN (?,?) OR s.cwid IN (SELECT cm.cwid FROM center_membership cm WHERE cm.center_code IN (?) AND (cm.start_date IS NULL OR cm.start_date <= ?) AND (cm.end_date IS NULL OR cm.end_date >= ?)))",
    );
    expect(text).toContain("AND p.publication_type IN (?)");
    expect(text).toContain("AND (pa.is_first = 1 OR pa.is_last = 1)");
    expect(values).toEqual(["full_time_faculty", "MED", "CARD", "HSS", "MSKCC", "CC", today, today, "Review", 10, 2025, 2025]);
  });

  it("units given but none decode match nothing, never everyone", async () => {
    await loadArticleCounts(parseArticleCountParams(new URLSearchParams("unit=bogus&unit=dept:&from=2025&to=2025")));
    const { text } = lastSql();
    expect(text).toContain("AND 1 = 0");
    expect(text).not.toContain("IN (");
  });

  it("fills every year in the range, zero where the query returned nothing, and totals (BigInt-safe)", async () => {
    h.queryRaw.mockResolvedValue([{ y: 2024, n: 5n }, { y: 2026, n: 2 }]);
    const { rows, total } = await loadArticleCounts(parseArticleCountParams(new URLSearchParams("from=2024&to=2026")));
    expect(rows).toEqual([
      { year: 2024, count: 5 },
      { year: 2025, count: 0 },
      { year: 2026, count: 2 },
    ]);
    expect(total).toBe(7);
  });
});

describe("loadArticleList", () => {
  const raw = (over: Partial<Record<string, unknown>>) => ({
    pmid: "100",
    y: 2024,
    title: "A title.",
    journal: "J Test",
    year: 2024,
    volume: "12",
    issue: "3",
    pages: "1-9",
    full_authors_string: "Smith JA, Jones B",
    authors_string: null,
    publication_type: "Academic Article",
    date_added_to_entrez: new Date("2024-03-05T00:00:00Z"),
    doi: "10.1/x",
    jif: "12.5",
    preferred_name: "Jane Smith",
    cwid: "jas2001",
    role_category: "full_time_faculty",
    primary_department: "Medicine",
    primary_org_code: "WCMC",
    is_first: 1,
    is_last: 0,
    ...over,
  });

  it("selects the same scope as the count (one row per matching authorship) and folds authorships per article", async () => {
    h.queryRaw.mockResolvedValue([
      raw({}),
      raw({ preferred_name: "Bob Jones", cwid: "bxj2002", role_category: "postdoc", primary_department: null, primary_org_code: "HSS", is_first: 0, is_last: 1 }),
      raw({ preferred_name: "Cy Null", cwid: "cyn2003", role_category: "postdoc", primary_department: "Surgery", primary_org_code: null, is_first: 0, is_last: 0 }),
      raw({ pmid: "SCOPUS:200", y: 2025, year: 2025, full_authors_string: null, authors_string: "((Doe J)), Roe R", jif: null, date_added_to_entrez: null, is_first: 0, is_last: 0 }),
    ]);
    const list = await loadArticleList(parseArticleCountParams(new URLSearchParams("basis=fy&jif=5&from=2024&to=2025")));
    const { text } = lastSql();
    expect(text).toContain("SELECT p.pmid, YEAR(DATE_ADD(p.date_added_to_entrez, INTERVAL 6 MONTH)) AS y, p.title");
    expect(text).toContain("s.primary_department, s.primary_org_code, pa.is_first");
    expect(text).toContain("AND j.impact_score_1 >= ?");
    expect(text).toContain("ORDER BY y, p.pmid, pa.position");
    expect(list).toEqual([
      {
        pmid: "100",
        citation: "Smith JA, Jones B. A title. J Test. 2024;12(3):1-9.",
        journal: "J Test",
        year: 2024,
        articleType: "Academic Article",
        jif: 12.5,
        dateAdded: "2024-03-05",
        doi: "10.1/x",
        // Institution sits after department: the home code is named, a
        // non-WCM code is expanded, a null one is skipped like a null department.
        scholars: [
          "Jane Smith (jas2001), Full-time faculty, Medicine, Weill Cornell Medicine, first author",
          "Bob Jones (bxj2002), Postdoc, Hospital for Special Surgery, last author",
          "Cy Null (cyn2003), Postdoc, Surgery, middle author",
        ],
      },
      {
        pmid: "SCOPUS:200",
        // The truncated `authors_string` fallback loses its ((WCM)) markup.
        citation: "Doe J, Roe R. A title. J Test. 2025;12(3):1-9.",
        journal: "J Test",
        year: 2025,
        articleType: "Academic Article",
        jif: null,
        dateAdded: null,
        doi: "10.1/x",
        scholars: ["Jane Smith (jas2001), Full-time faculty, Medicine, Weill Cornell Medicine, middle author"],
      },
    ]);
  });
});

describe("buildArticleCountWorkbook", () => {
  it("writes a Counts sheet (years + total) and a Criteria sheet carrying every filter and the caveat", async () => {
    const p = parseArticleCountParams(
      new URLSearchParams("basis=fy&jif=5&pos=first&from=2024&to=2025&type=postdoc&unit=dept:MED&unit=center:CC&unit=inst:GONE"),
    );
    const article = {
      pmid: "100",
      citation: "Smith JA. A title. J Test. 2024.",
      journal: "J Test",
      year: 2024,
      articleType: "Review",
      jif: 12.5,
      dateAdded: "2024-03-05",
      doi: "10.1/x",
      scholars: ["Jane Smith (jas2001), Postdoc, Medicine, first author"],
    };
    const buf = await buildArticleCountWorkbook(p, [{ year: 2024, count: 3 }, { year: 2025, count: 4 }], 7, new Date("2026-09-21T00:00:00Z"), [article], unitLabels(FACETS));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Counts", "Criteria", "Articles"]);
    const articles = wb.getWorksheet("Articles")!;
    expect(articles.getRow(1).values).toEqual([
      undefined, "PMID / ID", "Citation", "Journal", "Fiscal year", "Article type", "Journal impact factor", "Date added to PubMed", "DOI", "Matching scholars",
    ]);
    expect(articles.getRow(2).values).toEqual([
      undefined, "100", article.citation, "J Test", "FY2024", "Review", 12.5, "2024-03-05", "10.1/x", article.scholars[0],
    ]);
    const counts = wb.getWorksheet("Counts")!;
    expect(counts.getRow(1).values).toEqual([undefined, "Fiscal year (July–June)", "Articles"]);
    expect(counts.getRow(4).values).toEqual([undefined, "Total", 7]);
    const criteria = wb.getWorksheet("Criteria")!;
    const cells = new Map<string, string>();
    criteria.eachRow((row) => cells.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(cells.get("Person type")).toBe("Postdoc");
    // Named from the facets; a value the facets don't know prints raw.
    expect(cells.get("Department / division / center / institution")).toBe("Any of: Medicine; Cancer Center; inst:GONE");
    expect(cells.get("Minimum Journal Impact Factor")).toContain("5 or higher");
    expect(cells.get("Author position")).toBe("First author");
    expect(cells.get("Year basis")).toContain("July 1 – June 30");
    expect(cells.get("Years")).toBe("2024–2025");
    expect(cells.get("Note")).toBe(ARTICLE_COUNT_CAVEAT);
    expect(cells.get("Articles sheet")).toBe("Lists each of the 7 counted articles with its matching scholars.");
    expect(describeCriteria(p, new Date()).length).toBe(criteria.rowCount - 2);
  });

  it("over the cap: the Articles sheet is one explanatory line and Criteria says it was omitted", async () => {
    const p = parseArticleCountParams(new URLSearchParams("from=2024&to=2024"));
    const total = ARTICLE_LIST_CAP + 1;
    const buf = await buildArticleCountWorkbook(p, [{ year: 2024, count: total }], total, new Date(), null);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const articles = wb.getWorksheet("Articles")!;
    expect(articles.rowCount).toBe(1);
    expect(String(articles.getRow(1).getCell(1).value)).toContain("5,001 articles exceeds the 5,000-row limit");
    const criteria = wb.getWorksheet("Criteria")!;
    const last = criteria.getRow(criteria.rowCount);
    expect(String(last.getCell(1).value)).toBe("Articles sheet");
    expect(String(last.getCell(2).value)).toContain("Omitted: 5,001 articles exceeds the 5,000-row limit");
  });
});

describe("canViewArticleCountReport", () => {
  const base = { cwid: "abc1234", isSuperuser: false, isCommsSteward: false };
  it("superuser and comms steward pass without a grant read; any UnitAdmin row passes; else an article-count grant; none → false", async () => {
    h.grants.mockResolvedValue([]);
    expect(await canViewArticleCountReport({ ...base, isSuperuser: true })).toBe(true);
    expect(await canViewArticleCountReport({ ...base, isCommsSteward: true })).toBe(true);
    expect(h.findFirst).not.toHaveBeenCalled();
    h.findFirst.mockResolvedValueOnce({ cwid: "abc1234" });
    expect(await canViewArticleCountReport(base)).toBe(true);
    h.findFirst.mockResolvedValueOnce(null);
    expect(await canViewArticleCountReport(base)).toBe(false);
    expect(h.grants).toHaveBeenLastCalledWith({
      where: { reportKey: "article-count", cwid: "abc1234" },
      select: { scopeKey: true },
    });
    h.findFirst.mockResolvedValueOnce(null);
    h.grants.mockResolvedValueOnce([{ scopeKey: "*" }]);
    expect(await canViewArticleCountReport(base)).toBe(true);
  });
});
