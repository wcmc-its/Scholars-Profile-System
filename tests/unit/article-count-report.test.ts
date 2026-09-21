/**
 * Report 8 (Article counts) — the one check per branch: param parsing and
 * clamping, the SQL the facets produce (FY expression, IN lists, the JIF
 * join, the position clause), zero-filled years, the two workbook sheets
 * and the gate.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/lib/generated/prisma/client";

const h = vi.hoisted(() => ({ queryRaw: vi.fn(), groupBy: vi.fn(), findFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      $queryRaw: h.queryRaw,
      scholar: { groupBy: h.groupBy },
      publication: { groupBy: h.groupBy },
      unitAdmin: { findFirst: h.findFirst },
    },
    write: {},
  },
}));

import {
  ARTICLE_COUNT_CAVEAT,
  articleCountQueryString,
  buildArticleCountWorkbook,
  canViewArticleCountReport,
  describeCriteria,
  loadArticleCounts,
  parseArticleCountParams,
} from "@/lib/edit/article-count-report";

const thisYear = new Date().getFullYear();

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

describe("parseArticleCountParams", () => {
  it("defaults: all facets open, no JIF floor, any position, calendar years ending this year", () => {
    expect(parseArticleCountParams(new URLSearchParams())).toEqual({
      types: [],
      depts: [],
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
      new URLSearchParams("types=postdoc&types=fellow&dept=A&atype=Review&jif=999&pos=bogus&basis=fy&from=2020&to=2010"),
    );
    expect(p).toMatchObject({ types: ["postdoc", "fellow"], depts: ["A"], atypes: ["Review"], jif: 100, pos: "any", basis: "fy", from: 2020, to: 2020 });
    // Round-trips through the query string the page and the download share.
    expect(parseArticleCountParams(new URLSearchParams(articleCountQueryString(p)))).toEqual(p);
  });
});

describe("loadArticleCounts", () => {
  it("calendar basis groups on p.year with no JIF join and no facet clauses", async () => {
    await loadArticleCounts(parseArticleCountParams(new URLSearchParams("from=2024&to=2025")));
    const { text } = lastSql();
    expect(text).toContain("SELECT p.year AS y, COUNT(DISTINCT pa.pmid)");
    expect(text).not.toContain("journal_impact_factor");
    expect(text).not.toContain("IN (");
    expect(text).not.toContain("is_first");
  });

  it("fiscal basis shifts the PubMed add date by six months; facets, JIF and position each add their clause", async () => {
    await loadArticleCounts(
      parseArticleCountParams(
        new URLSearchParams("basis=fy&types=full_time_faculty&dept=Medicine&atype=Review&jif=10&pos=either&from=2025&to=2025"),
      ),
    );
    const { text, values } = lastSql();
    expect(text).toContain("YEAR(DATE_ADD(p.date_added_to_entrez, INTERVAL 6 MONTH)) AS y");
    expect(text).toContain("JOIN journal_impact_factor j ON j.journal_abbrev = p.journal_abbrev AND j.impact_score_1 >= ?");
    expect(text).toContain("AND s.role_category IN (?)");
    expect(text).toContain("AND s.primary_department IN (?)");
    expect(text).toContain("AND p.publication_type IN (?)");
    expect(text).toContain("AND (pa.is_first = 1 OR pa.is_last = 1)");
    expect(values).toEqual([10, "full_time_faculty", "Medicine", "Review", 2025, 2025]);
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

describe("buildArticleCountWorkbook", () => {
  it("writes a Counts sheet (years + total) and a Criteria sheet carrying every filter and the caveat", async () => {
    const p = parseArticleCountParams(new URLSearchParams("basis=fy&jif=5&pos=first&from=2024&to=2025&types=postdoc"));
    const buf = await buildArticleCountWorkbook(p, [{ year: 2024, count: 3 }, { year: 2025, count: 4 }], 7, new Date("2026-09-21T00:00:00Z"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Counts", "Criteria"]);
    const counts = wb.getWorksheet("Counts")!;
    expect(counts.getRow(1).values).toEqual([undefined, "Fiscal year (July–June)", "Articles"]);
    expect(counts.getRow(4).values).toEqual([undefined, "Total", 7]);
    const criteria = wb.getWorksheet("Criteria")!;
    const cells = new Map<string, string>();
    criteria.eachRow((row) => cells.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(cells.get("Person type")).toBe("Postdoc");
    expect(cells.get("Primary department")).toBe("All");
    expect(cells.get("Minimum Journal Impact Factor")).toContain("5 or higher");
    expect(cells.get("Author position")).toBe("First author");
    expect(cells.get("Year basis")).toContain("July 1 – June 30");
    expect(cells.get("Years")).toBe("2024–2025");
    expect(cells.get("Note")).toBe(ARTICLE_COUNT_CAVEAT);
    expect(describeCriteria(p, new Date()).length).toBe(criteria.rowCount - 1);
  });
});

describe("canViewArticleCountReport", () => {
  const base = { cwid: "abc1234", isSuperuser: false, isCommsSteward: false };
  it("superuser and comms steward pass without a grant read; any UnitAdmin row passes; none → false", async () => {
    expect(await canViewArticleCountReport({ ...base, isSuperuser: true })).toBe(true);
    expect(await canViewArticleCountReport({ ...base, isCommsSteward: true })).toBe(true);
    expect(h.findFirst).not.toHaveBeenCalled();
    h.findFirst.mockResolvedValueOnce({ cwid: "abc1234" });
    expect(await canViewArticleCountReport(base)).toBe(true);
    h.findFirst.mockResolvedValueOnce(null);
    expect(await canViewArticleCountReport(base)).toBe(false);
  });
});
