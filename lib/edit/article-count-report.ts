/**
 * Report 8 — "Article counts": distinct publications per year for the
 * scholars matching the facets (person type, primary department, article
 * type, minimum Journal Impact Factor, author position), by calendar or
 * fiscal year. One `COUNT(DISTINCT pmid)` query, grouped by year; the page
 * and the `.xlsx` route (`/api/edit/reports/article-count`) share it.
 *
 * Counting rule: an article counts once however many matching authors it
 * has; only ReCiter-confirmed authorships (`is_confirmed`) of active,
 * non-deleted scholars count, and the person type / department read the
 * scholar's CURRENT row — which is why historical numbers drift (the caveat
 * `CAVEAT` the page and the workbook both carry).
 *
 * Fiscal year is July–June, named by the ending calendar year (FY2025 =
 * 2024-07-01..2025-06-30). `Publication` stores no publication month, so the
 * FY basis reads `date_added_to_entrez` (the PubMed add date, what report 7
 * already reports); the calendar basis reads `year`. Both are stated on the
 * Criteria sheet.
 *
 * Gate: every unit administrator — a superuser, a comms steward, or the
 * holder of any `UnitAdmin` grant (`canViewUsage`, the Usage dashboard's
 * audience). Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { canViewUsage } from "@/lib/edit/usage-access";
import { Prisma } from "@/lib/generated/prisma/client";
import { roleCategoryLabel } from "@/lib/match-display";

export const ARTICLE_COUNT_CAVEAT =
  "Historical numbers may change slightly over time as publication records are updated and people's person types change.";

export const JIF_MAX = 100;

export const POSITION_LABEL = {
  any: "Any position",
  first: "First author",
  last: "Last author",
  either: "First or last author",
} as const;
export type AuthorPosition = keyof typeof POSITION_LABEL;

export const BASIS_LABEL = {
  cy: "Calendar year",
  fy: "Fiscal year (July–June)",
} as const;
export type YearBasis = keyof typeof BASIS_LABEL;

export type ArticleCountParams = {
  types: string[];
  depts: string[];
  atypes: string[];
  jif: number;
  pos: AuthorPosition;
  basis: YearBasis;
  from: number;
  to: number;
};

/** Every param is optional and falls back to its default — a page has
 *  nothing useful to say with a 400, and a stray value is just ignored. */
export function parseArticleCountParams(sp: URLSearchParams): ArticleCountParams {
  const thisYear = new Date().getFullYear();
  const int = (k: string, dflt: number, lo: number, hi: number) => {
    const n = Number.parseInt(sp.get(k) ?? "", 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const pick = <T extends string>(k: string, allowed: readonly T[], dflt: T): T =>
    allowed.find((v) => v === sp.get(k)) ?? dflt;
  const from = int("from", thisYear - 4, 1900, 2100);
  return {
    types: sp.getAll("types").filter(Boolean),
    depts: sp.getAll("dept").filter(Boolean),
    atypes: sp.getAll("atype").filter(Boolean),
    jif: int("jif", 0, 0, JIF_MAX),
    pos: pick("pos", Object.keys(POSITION_LABEL) as AuthorPosition[], "any"),
    basis: pick("basis", Object.keys(BASIS_LABEL) as YearBasis[], "cy"),
    from,
    to: Math.max(from, int("to", thisYear, 1900, 2100)),
  };
}

export function articleCountQueryString(p: ArticleCountParams): string {
  const q = new URLSearchParams();
  for (const t of p.types) q.append("types", t);
  for (const d of p.depts) q.append("dept", d);
  for (const a of p.atypes) q.append("atype", a);
  q.set("jif", String(p.jif));
  q.set("pos", p.pos);
  q.set("basis", p.basis);
  q.set("from", String(p.from));
  q.set("to", String(p.to));
  return q.toString();
}

export async function canViewArticleCountReport(session: EditSession): Promise<boolean> {
  return session.isCommsSteward || canViewUsage(session, db.read);
}

/** The facet vocabularies, from what the data actually holds. */
export async function loadArticleCountChoices(): Promise<{
  types: string[];
  depts: string[];
  atypes: string[];
}> {
  const [roles, depts, atypes] = await Promise.all([
    db.read.scholar.groupBy({ by: ["roleCategory"], where: { deletedAt: null, status: "active" } }),
    db.read.scholar.groupBy({ by: ["primaryDepartment"], where: { deletedAt: null, status: "active" } }),
    db.read.publication.groupBy({ by: ["publicationType"] }),
  ]);
  const strings = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort();
  return {
    types: strings(roles.map((r) => r.roleCategory)),
    depts: strings(depts.map((r) => r.primaryDepartment)),
    atypes: strings(atypes.map((r) => r.publicationType)),
  };
}

export type ArticleCountRow = { year: number; count: number };

/** One row per year in `from..to` (zeros filled), plus the total. */
export async function loadArticleCounts(
  p: ArticleCountParams,
): Promise<{ rows: ArticleCountRow[]; total: number }> {
  const yearExpr =
    p.basis === "fy"
      ? Prisma.sql`YEAR(DATE_ADD(p.date_added_to_entrez, INTERVAL 6 MONTH))`
      : Prisma.sql`p.year`;
  const posExpr = {
    any: Prisma.empty,
    first: Prisma.sql`AND pa.is_first = 1`,
    last: Prisma.sql`AND pa.is_last = 1`,
    either: Prisma.sql`AND (pa.is_first = 1 OR pa.is_last = 1)`,
  }[p.pos];
  const inList = (col: Prisma.Sql, xs: string[]) =>
    xs.length > 0 ? Prisma.sql`AND ${col} IN (${Prisma.join(xs)})` : Prisma.empty;

  const raw = await db.read.$queryRaw<{ y: number | null; n: bigint | number }[]>`
    SELECT ${yearExpr} AS y, COUNT(DISTINCT pa.pmid) AS n
      FROM publication_author pa
      JOIN scholar s ON s.cwid = pa.cwid
      JOIN publication p ON p.pmid = pa.pmid
      ${
        p.jif > 0
          ? Prisma.sql`JOIN journal_impact_factor j ON j.journal_abbrev = p.journal_abbrev AND j.impact_score_1 >= ${p.jif}`
          : Prisma.empty
      }
     WHERE pa.is_confirmed = 1
       AND s.deleted_at IS NULL AND s.status = 'active'
       ${inList(Prisma.sql`s.role_category`, p.types)}
       ${inList(Prisma.sql`s.primary_department`, p.depts)}
       ${inList(Prisma.sql`p.publication_type`, p.atypes)}
       ${posExpr}
       AND ${yearExpr} BETWEEN ${p.from} AND ${p.to}
     GROUP BY y
     ORDER BY y`;

  const byYear = new Map(raw.map((r) => [Number(r.y), Number(r.n)]));
  const rows: ArticleCountRow[] = [];
  for (let y = p.from; y <= p.to; y++) rows.push({ year: y, count: byYear.get(y) ?? 0 });
  return { rows, total: rows.reduce((s, r) => s + r.count, 0) };
}

/** The filters as `[label, value]` pairs — the Criteria sheet, verbatim. */
export function describeCriteria(p: ArticleCountParams, generatedAt: Date): [string, string][] {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "All");
  return [
    ["Report", "8. Article counts"],
    ["Generated", generatedAt.toISOString()],
    ["Person type", list(p.types.map(roleCategoryLabel))],
    ["Primary department", list(p.depts)],
    ["Article type", list(p.atypes)],
    [
      "Minimum Journal Impact Factor",
      p.jif > 0 ? `${p.jif} or higher (articles in journals with no JIF on file are excluded)` : "None",
    ],
    ["Author position", POSITION_LABEL[p.pos]],
    [
      "Year basis",
      p.basis === "fy"
        ? "Fiscal year, July 1 – June 30, named by the ending calendar year, by the date the article was added to PubMed"
        : "Calendar year of publication",
    ],
    ["Years", `${p.from}–${p.to}`],
    [
      "Counting rule",
      "Each article is counted once, however many matching authors it has. Only ReCiter-confirmed authorships of active scholars count; person type and department are the scholar's current values.",
    ],
    ["Note", ARTICLE_COUNT_CAVEAT],
  ];
}

export async function buildArticleCountWorkbook(
  p: ArticleCountParams,
  rows: ArticleCountRow[],
  total: number,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const bold = (ws: ExcelJS.Worksheet, r: number) => (ws.getRow(r).font = { bold: true });

  const counts = wb.addWorksheet("Counts");
  counts.addRow([BASIS_LABEL[p.basis], "Articles"]);
  bold(counts, 1);
  for (const r of rows) counts.addRow([r.year, r.count]);
  counts.addRow(["Total", total]);
  bold(counts, counts.rowCount);
  counts.getColumn(1).width = 26;
  counts.getColumn(2).width = 12;

  const criteria = wb.addWorksheet("Criteria");
  criteria.addRow(["Criterion", "Value"]);
  bold(criteria, 1);
  for (const [k, v] of describeCriteria(p, generatedAt)) criteria.addRow([k, v]);
  criteria.getColumn(1).width = 32;
  criteria.getColumn(2).width = 100;
  criteria.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
