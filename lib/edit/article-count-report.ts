/**
 * Report 8 — "Article counts": distinct publications per year for the
 * scholars matching the facets (person type, department / division /
 * center / institution, article type, minimum Journal Impact Factor, author
 * position), by calendar or fiscal year. Person type and unit take the
 * Profiles roster's URL vocabulary (`/edit/scholars`): repeated `type` (raw
 * roleCategory) and repeated `unit` (`dept:` / `div:` / `center:` / `inst:`
 * + CODE, `parseUnitValue`), and the rail shows the same facets
 * (`loadDataQualityFacets`). One `COUNT(DISTINCT pmid)` query, grouped by year; the page
 * and the `.xlsx` route (`/api/edit/reports/article-count`) share it; the
 * workbook adds an Articles sheet (one row per counted article with its
 * matching scholars, `loadArticleList`) up to `ARTICLE_LIST_CAP`.
 *
 * Counting rule: an article counts once however many matching authors it
 * has; only ReCiter-confirmed authorships (`is_confirmed`) of active,
 * non-deleted scholars count, and the person type / units read the
 * scholar's CURRENT row and center memberships — which is why historical numbers drift (the caveat
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

import { loadDataQualityFacets, parseUnitValue, type DataQualityFacets } from "@/lib/api/data-quality";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { canViewUsage } from "@/lib/edit/usage-access";
import { mentoredPubCitation } from "@/lib/edit/mentored-publications-citation";
import { Prisma } from "@/lib/generated/prisma/client";
import { institutionDisplayName } from "@/lib/institutions";
import { formatRoleCategory } from "@/lib/role-display";

/** The rail's label (`loadDataQualityFacets`), so page and workbook agree. */
const roleCategoryLabel = (r: string | null) => formatRoleCategory(r) ?? "";

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
  /** Raw roleCategory values (`type`). */
  types: string[];
  /** Encoded unit values (`unit`: `dept:CODE` / `div:CODE` / `center:CODE` /
   *  `inst:CODE`), kept raw so they round-trip; `scopeSql` decodes them. */
  units: string[];
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
    types: sp.getAll("type").map((v) => v.trim()).filter(Boolean),
    units: sp.getAll("unit").map((v) => v.trim()).filter(Boolean),
    atypes: sp.getAll("atype").map((v) => v.trim()).filter(Boolean),
    jif: int("jif", 0, 0, JIF_MAX),
    pos: pick("pos", Object.keys(POSITION_LABEL) as AuthorPosition[], "any"),
    basis: pick("basis", Object.keys(BASIS_LABEL) as YearBasis[], "cy"),
    from,
    to: Math.max(from, int("to", thisYear, 1900, 2100)),
  };
}

export function articleCountQueryString(p: ArticleCountParams): string {
  const q = new URLSearchParams();
  for (const t of p.types) q.append("type", t);
  for (const u of p.units) q.append("unit", u);
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

/** The rail's facets: person type and the four unit groups are the Profiles
 *  roster's own (`loadDataQualityFacets`, static active-scholar counts);
 *  article type is what `publication` actually holds. */
export async function loadArticleCountChoices(): Promise<{
  facets: DataQualityFacets;
  atypes: string[];
}> {
  const [facets, atypes] = await Promise.all([
    loadDataQualityFacets(db.read),
    db.read.publication.groupBy({ by: ["publicationType"] }),
  ]);
  return {
    facets,
    atypes: atypes
      .map((r) => r.publicationType)
      .filter((x): x is string => !!x)
      .sort(),
  };
}

/** `unit` value → display label (department / division / center name,
 *  institution display name), for the Criteria sheet. */
export function unitLabels(facets: DataQualityFacets): Map<string, string> {
  const opts = [
    ...facets.departments.flatMap((d) => [d, ...d.divisions]),
    ...facets.centers,
    ...facets.institutions,
  ];
  return new Map(opts.map((o) => [o.value, o.label]));
}

export type ArticleCountRow = { year: number; count: number };

/** The FROM/WHERE both queries share: confirmed authorships of active
 *  scholars, the facets, the position clause, the year window. `j` is a LEFT
 *  JOIN so the article sheet can show a JIF without a floor; the floor, when
 *  set, is a WHERE on it (which drops JIF-less journals, as documented). */
function scopeSql(p: ArticleCountParams): { yearExpr: Prisma.Sql; fromWhere: Prisma.Sql } {
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
  // Units OR together, as on the Profiles roster (`buildWhere` in
  // `lib/api/data-quality.ts`): dept / div / ED primary org are scholar
  // columns; a center is its date-active members (pending / expired
  // excluded). Units given but none decode → match nothing, never everyone.
  let unitExpr = Prisma.empty;
  if (p.units.length > 0) {
    const decoded = p.units.map(parseUnitValue);
    const codes = (kind: string) => decoded.flatMap((u) => (u?.kind === kind ? [u.code] : []));
    const ors: Prisma.Sql[] = [];
    const add = (col: Prisma.Sql, xs: string[]) => {
      if (xs.length > 0) ors.push(Prisma.sql`${col} IN (${Prisma.join(xs)})`);
    };
    add(Prisma.sql`s.dept_code`, codes("department"));
    add(Prisma.sql`s.div_code`, codes("division"));
    add(Prisma.sql`s.primary_org_code`, codes("institution"));
    const centers = codes("center");
    if (centers.length > 0) {
      // UTC "today", as the Profiles loader computes it — not the DB session's CURDATE().
      const today = new Date().toISOString().slice(0, 10);
      ors.push(Prisma.sql`s.cwid IN (SELECT cm.cwid FROM center_membership cm
         WHERE cm.center_code IN (${Prisma.join(centers)})
           AND (cm.start_date IS NULL OR cm.start_date <= ${today})
           AND (cm.end_date IS NULL OR cm.end_date >= ${today}))`);
    }
    unitExpr = ors.length > 0 ? Prisma.sql`AND (${Prisma.join(ors, " OR ")})` : Prisma.sql`AND 1 = 0`;
  }
  const fromWhere = Prisma.sql`
      FROM publication_author pa
      JOIN scholar s ON s.cwid = pa.cwid
      JOIN publication p ON p.pmid = pa.pmid
      LEFT JOIN journal_impact_factor j ON j.journal_abbrev = p.journal_abbrev
     WHERE pa.is_confirmed = 1
       AND s.deleted_at IS NULL AND s.status = 'active'
       ${inList(Prisma.sql`s.role_category`, p.types)}
       ${unitExpr}
       ${inList(Prisma.sql`p.publication_type`, p.atypes)}
       ${p.jif > 0 ? Prisma.sql`AND j.impact_score_1 >= ${p.jif}` : Prisma.empty}
       ${posExpr}
       AND ${yearExpr} BETWEEN ${p.from} AND ${p.to}`;
  return { yearExpr, fromWhere };
}

/** One row per year in `from..to` (zeros filled), plus the total. */
export async function loadArticleCounts(
  p: ArticleCountParams,
): Promise<{ rows: ArticleCountRow[]; total: number }> {
  const { yearExpr, fromWhere } = scopeSql(p);
  const raw = await db.read.$queryRaw<{ y: number | null; n: bigint | number }[]>`
    SELECT ${yearExpr} AS y, COUNT(DISTINCT pa.pmid) AS n
    ${fromWhere}
     GROUP BY y
     ORDER BY y`;

  const byYear = new Map(raw.map((r) => [Number(r.y), Number(r.n)]));
  const rows: ArticleCountRow[] = [];
  for (let y = p.from; y <= p.to; y++) rows.push({ year: y, count: byYear.get(y) ?? 0 });
  return { rows, total: rows.reduce((s, r) => s + r.count, 0) };
}

/** The workbook's Articles sheet is built only up to this many articles;
 *  above it the sheet says so instead (the `DATA_QUALITY_EXPORT_CAP` precedent). */
export const ARTICLE_LIST_CAP = 5000;

export type ArticleRow = {
  pmid: string;
  citation: string;
  journal: string | null;
  year: number;
  articleType: string | null;
  jif: number | null;
  dateAdded: string | null;
  doi: string | null;
  /** The matching scholars, one entry each:
   *  `Name (CWID), person type, department, institution, position`. */
  scholars: string[];
};

type RawArticleRow = {
  pmid: string;
  y: number | null;
  title: string;
  journal: string | null;
  year: number | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  full_authors_string: string | null;
  authors_string: string | null;
  publication_type: string | null;
  date_added_to_entrez: Date | null;
  doi: string | null;
  jif: number | string | null;
  preferred_name: string;
  cwid: string;
  role_category: string | null;
  primary_department: string | null;
  primary_org_code: string | null;
  is_first: number | boolean;
  is_last: number | boolean;
};

/** One row per counted article, with its matching scholars — the same scope
 *  as {@link loadArticleCounts}, one row per matching authorship folded in
 *  memory. Only called when the total is within {@link ARTICLE_LIST_CAP}. */
export async function loadArticleList(p: ArticleCountParams): Promise<ArticleRow[]> {
  const { yearExpr, fromWhere } = scopeSql(p);
  const raw = await db.read.$queryRaw<RawArticleRow[]>`
    SELECT p.pmid, ${yearExpr} AS y, p.title, p.journal, p.year, p.volume, p.issue, p.pages,
           p.full_authors_string, p.authors_string, p.publication_type, p.date_added_to_entrez, p.doi,
           j.impact_score_1 AS jif,
           s.preferred_name, s.cwid, s.role_category, s.primary_department, s.primary_org_code,
           pa.is_first, pa.is_last
    ${fromWhere}
     ORDER BY y, p.pmid, pa.position`;

  const byPmid = new Map<string, ArticleRow>();
  for (const r of raw) {
    let row = byPmid.get(r.pmid);
    if (!row) {
      // `full_authors_string` is comma-separated `Lastname Initials` tokens;
      // `authors_string` is the truncated fallback with `((...))` WCM markup.
      const authors = (r.full_authors_string ?? r.authors_string ?? "")
        .replace(/\(\(|\)\)/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((lastName, i) => ({ rank: i + 1, lastName, firstName: null, personIdentifier: null }));
      row = {
        pmid: r.pmid,
        citation: mentoredPubCitation({ ...r, authors }),
        journal: r.journal,
        year: Number(r.y),
        articleType: r.publication_type,
        jif: r.jif === null ? null : Number(r.jif),
        dateAdded: r.date_added_to_entrez ? r.date_added_to_entrez.toISOString().slice(0, 10) : null,
        doi: r.doi,
        scholars: [],
      };
      byPmid.set(r.pmid, row);
    }
    const position = r.is_first ? "first author" : r.is_last ? "last author" : "middle author";
    row.scholars.push(
      [
        `${r.preferred_name} (${r.cwid})`,
        roleCategoryLabel(r.role_category),
        r.primary_department,
        r.primary_org_code ? institutionDisplayName(r.primary_org_code) : null,
        position,
      ]
        .filter(Boolean)
        .join(", "),
    );
  }
  return [...byPmid.values()];
}

/** The filters as `[label, value]` pairs — the Criteria sheet, verbatim.
 *  `labels` names each `unit` value ({@link unitLabels}); an unknown one
 *  prints raw. */
export function describeCriteria(
  p: ArticleCountParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
): [string, string][] {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "All");
  return [
    ["Report", "8. Article counts"],
    ["Generated", generatedAt.toISOString()],
    ["Person type", list(p.types.map(roleCategoryLabel))],
    [
      "Department / division / center / institution",
      p.units.length > 1
        ? `Any of: ${list(p.units.map((u) => labels.get(u) ?? u))}`
        : list(p.units.map((u) => labels.get(u) ?? u)),
    ],
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
      "Each article is counted once, however many matching authors it has. Only ReCiter-confirmed authorships of active scholars count; person type, department, division, institution and center membership are the scholar's current values.",
    ],
    ["Note", ARTICLE_COUNT_CAVEAT],
  ];
}

export async function buildArticleCountWorkbook(
  p: ArticleCountParams,
  rows: ArticleCountRow[],
  total: number,
  generatedAt: Date,
  /** The counted articles when `total <= ARTICLE_LIST_CAP`, else null — the
   *  sheet then says so. */
  articles: ArticleRow[] | null,
  /** `unit` value → label for the Criteria sheet ({@link unitLabels}). */
  labels: ReadonlyMap<string, string> = new Map(),
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
  for (const [k, v] of describeCriteria(p, generatedAt, labels)) criteria.addRow([k, v]);
  criteria.addRow([
    "Articles sheet",
    articles
      ? `Lists each of the ${total.toLocaleString()} counted articles with its matching scholars.`
      : `Omitted: ${total.toLocaleString()} articles exceeds the ${ARTICLE_LIST_CAP.toLocaleString()}-row limit. Narrow the filters to list them.`,
  ]);
  criteria.getColumn(1).width = 32;
  criteria.getColumn(2).width = 100;
  criteria.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const list = wb.addWorksheet("Articles");
  if (!articles) {
    list.addRow([
      `${total.toLocaleString()} articles exceeds the ${ARTICLE_LIST_CAP.toLocaleString()}-row limit for this sheet. Narrow the filters to list them.`,
    ]);
    list.getColumn(1).width = 100;
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const yearHeader = p.basis === "fy" ? "Fiscal year" : "Year";
  list.addRow([
    "PMID / ID",
    "Citation",
    "Journal",
    yearHeader,
    "Article type",
    "Journal impact factor",
    "Date added to PubMed",
    "DOI",
    "Matching scholars",
  ]);
  bold(list, 1);
  list.views = [{ state: "frozen", ySplit: 1 }];
  for (const a of articles) {
    list.addRow([
      a.pmid,
      a.citation,
      a.journal,
      p.basis === "fy" ? `FY${a.year}` : a.year,
      a.articleType,
      a.jif,
      a.dateAdded,
      a.doi,
      a.scholars.join("; "),
    ]);
  }
  for (const [i, w] of [14, 90, 30, 12, 18, 12, 14, 28, 60].entries()) list.getColumn(i + 1).width = w;
  list.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  list.getColumn(9).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
