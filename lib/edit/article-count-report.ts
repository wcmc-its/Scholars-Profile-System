/**
 * Report 8 — "Article counts": distinct publications per year for the
 * scholars matching the facets (person type, department / division /
 * center / institution, a pasted CWID list, article type, minimum Journal
 * Impact Factor, author position), by calendar year, fiscal year, or the
 * date the article was added to PubMed. Person type and unit take the
 * Profiles roster's URL vocabulary (`/edit/profiles`): repeated `type` (raw
 * roleCategory) and repeated `unit` (`dept:` / `div:` / `center:` / `inst:`
 * + CODE; `parsePersonFilter` / `personFilterSql` in `lib/edit/person-filter.ts`,
 * the rule the Profiles roster shares), and the rail shows the same facets
 * (`loadDataQualityFacets`). One `COUNT(DISTINCT pmid)` query, grouped by year; the page
 * and the `.xlsx` route (`/api/edit/reports/article-count`) share it; the
 * workbook adds an Articles sheet (one row per counted article with its
 * matching scholars, `loadArticleList`) up to `ARTICLE_LIST_CAP`, and the
 * page's Articles tab lists the same rows under the same cap.
 *
 * URL (every param optional; an unknown value falls back to its default,
 * never a 400):
 *   - `type`, `unit` — the shared who-filter; `list=<id>` a stored CWID list
 *     (`lib/edit/cwid-list.ts`), ANDed with the rest.
 *   - `basis` (`cy` | `fy`) + `from` / `to` (years), OR the date-added window
 *     `added_from` / `added_to` (ISO dates, inclusive) — `basis=added`, or
 *     either date with no `basis`, selects it; the modes never combine.
 *   - `atype` (repeated), `jif` (minimum, one decimal), `pos`.
 *   - `f=1` marks a submitted form: a BARE URL (no filter param at all) is
 *     the only one that gets the viewer's own units as the default `unit`
 *     (`resolveArticleCountParams`), so clearing every filter never brings
 *     the default back. View params (`tab`, `year`) are not filters.
 *
 * Counting rule: an article counts once however many matching authors it
 * has; only ReCiter-confirmed authorships (`is_confirmed`) of active,
 * non-deleted scholars count, and the person type / units read the
 * scholar's CURRENT row and center / division memberships — which is why historical numbers drift (the caveat
 * `CAVEAT` the page and the workbook both carry).
 *
 * Fiscal year is July–June, named by the ending calendar year (FY2025 =
 * 2024-07-01..2025-06-30). `Publication` stores no publication month, so the
 * FY basis reads `date_added_to_entrez` (the PubMed add date, what report 7
 * already reports); the calendar basis reads `year`; the date-added window
 * reads `date_added_to_entrez` and groups by the year added. All are stated
 * on the Criteria sheet.
 *
 * Report 9 shares `parseArticleCountParams` / `scopeSql` (its own journal
 * clause on top). The date-added window and the CWID list are opt-in
 * (`ARTICLE_COUNT_PARSE`), so report 9's URLs mean what they always did.
 *
 * Gate: every unit administrator — a superuser, a comms steward, or the
 * holder of any `UnitAdmin` grant (`canViewUsage`, the Usage dashboard's
 * audience) — plus anyone with an `article-count` `report_access` row.
 * Server-only (`@/lib/db`).
 */
import ExcelJS from "exceljs";

import { loadDataQualityFacets, type DataQualityFacets } from "@/lib/api/data-quality";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { citationIdentifier, formatVolIssuePages } from "@/lib/citation";
import { loadCwidList, type CwidListData } from "@/lib/edit/cwid-list";
import { loadManageableUnits } from "@/lib/edit/manageable-units";
import { ARTICLE_COUNT_REPORT, loadReportScopesForCwid } from "@/lib/edit/report-access";
import { canViewUsage } from "@/lib/edit/usage-access";
import { mentoredPubCitation } from "@/lib/edit/mentored-publications-citation";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  parsePersonFilter,
  personFilterCriteria,
  personFilterSql,
  unitLabels,
  utcToday,
} from "@/lib/edit/person-filter";
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

/** The date-added window's rail label and its `basis` value. */
export const ADDED_LABEL = "Date added to PubMed";
export const ADDED_BASIS = "added";

/** The date-added window's quick picks (days back from today, UTC). */
export const ADDED_QUICK_PICKS = [30, 60, 90] as const;

export type ArticleCountParams = {
  /** Raw roleCategory values (`type`). */
  types: string[];
  /** Encoded unit values (`unit`: `dept:CODE` / `div:CODE` / `center:CODE` /
   *  `inst:CODE`), kept raw so they round-trip; `scopeSql` decodes them. */
  units: string[];
  atypes: string[];
  /** Minimum Journal Impact Factor, 0..`JIF_MAX`, one decimal; 0 = none. */
  jif: number;
  pos: AuthorPosition;
  basis: YearBasis;
  /** The year window — in date-added mode, the years the window spans. */
  from: number;
  to: number;
  /** The date-added window (`added_from` / `added_to`, ISO, inclusive): when
   *  set it REPLACES `basis` / `from` / `to` as the window. Report 8 only. */
  added: { from: string; to: string } | null;
  /** A stored CWID list's id (`list`). Report 8 only. */
  list: string | null;
  /** The list once resolved (`resolveArticleCountParams`); null until then.
   *  An unresolved or unknown list matches nobody, never everyone. */
  listData: CwidListData | null;
};

/** Which of report 8's own params a caller reads. Off by default so report 9
 *  (which shares the parser) is unchanged. */
export type ArticleCountParseOptions = { dateAdded?: boolean; cwidList?: boolean };

/** Report 8's page and download: every param. */
export const ARTICLE_COUNT_PARSE: ArticleCountParseOptions = { dateAdded: true, cwidList: true };

/** A valid `YYYY-MM-DD`, or null. */
function isoDate(v: string | null): string | null {
  const t = v?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : null;
}

/** `iso` shifted by `days` (UTC). */
export function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every param is optional and falls back to its default — a page has
 *  nothing useful to say with a 400, and a stray value is just ignored. */
export function parseArticleCountParams(
  sp: URLSearchParams,
  opts: ArticleCountParseOptions = {},
): ArticleCountParams {
  const thisYear = new Date().getFullYear();
  const int = (k: string, dflt: number, lo: number, hi: number) => {
    const n = Number.parseInt(sp.get(k) ?? "", 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const pick = <T extends string>(k: string, allowed: readonly T[], dflt: T): T =>
    allowed.find((v) => v === sp.get(k)) ?? dflt;
  const jifRaw = Number.parseFloat(sp.get("jif") ?? "");
  const jif = Number.isFinite(jifRaw) ? Math.min(JIF_MAX, Math.max(0, Math.round(jifRaw * 10) / 10)) : 0;
  const person = parsePersonFilter(sp);
  let from = int("from", thisYear - 4, 1900, 2100);
  let to = Math.max(from, int("to", thisYear, 1900, 2100));
  let basis = pick("basis", Object.keys(BASIS_LABEL) as YearBasis[], "cy");

  // The date-added window: `basis=added`, or a date with no `basis` at all (a
  // hand-made link). An explicit `basis=cy|fy` wins over stale dates, so
  // switching the rail back to years never needs the dates cleared first.
  let added: ArticleCountParams["added"] = null;
  if (opts.dateAdded) {
    const af = isoDate(sp.get("added_from"));
    const at = isoDate(sp.get("added_to"));
    const b = sp.get("basis");
    if (b === ADDED_BASIS || (b === null && (af || at))) {
      const end = at ?? utcToday();
      const start = af ?? shiftIsoDate(end, -ADDED_QUICK_PICKS[0]);
      added = start <= end ? { from: start, to: end } : { from: end, to: start };
      from = Number(added.from.slice(0, 4));
      to = Number(added.to.slice(0, 4));
      basis = "cy";
    }
  }
  return {
    types: person.types,
    units: person.unitValues,
    atypes: sp.getAll("atype").map((v) => v.trim()).filter(Boolean),
    jif,
    pos: pick("pos", Object.keys(POSITION_LABEL) as AuthorPosition[], "any"),
    basis,
    from,
    to,
    added,
    list: opts.cwidList ? person.listId : null,
    listData: null,
  };
}

/** Every URL param that is a FILTER (anything else — `tab`, `year` — is a
 *  view). A URL with none of them is bare and takes the unit default. */
export const ARTICLE_COUNT_FILTER_KEYS = [
  "type",
  "unit",
  "list",
  "atype",
  "jif",
  "pos",
  "basis",
  "from",
  "to",
  "added_from",
  "added_to",
  "f",
] as const;

/** The submitted-form marker (`f=1`): the rail's hidden input and every link
 *  the page builds carry it. */
export const ARTICLE_COUNT_SUBMITTED = "f";

export function isBareArticleCountQuery(sp: URLSearchParams): boolean {
  return !ARTICLE_COUNT_FILTER_KEYS.some((k) => sp.has(k));
}

type SessionLike = Pick<EditSession, "cwid" | "isSuperuser" | "isCommsSteward">;

/** The viewer's own units as `unit` values — the bare-URL default. From
 *  `loadManageableUnits` (direct `unit_admin` grants): department → `dept:`,
 *  division → `div:`, center → `center:`, institution → `inst:`. Cores are
 *  skipped (a core's publications come from core usage, not people).
 *  Superusers and comms stewards see the whole institution: no default. */
export async function articleCountDefaultUnits(session: SessionLike): Promise<string[]> {
  if (session.isSuperuser || session.isCommsSteward) return [];
  const mine = await loadManageableUnits(session.cwid, db.read);
  return [
    ...mine.departments.map((u) => `dept:${u.code}`),
    ...mine.divisions.map((u) => `div:${u.code}`),
    ...mine.centers.map((u) => `center:${u.code}`),
    ...mine.institutions.map((u) => `inst:${u.code}`),
  ];
}

/** What the page and the download both do after parsing: a bare URL gets the
 *  viewer's units (`articleCountDefaultUnits`), and a `list` is resolved to
 *  its CWIDs (`loadCwidList`). `defaulted` says the units came from the
 *  default, not the URL. */
export async function resolveArticleCountParams(
  p: ArticleCountParams,
  sp: URLSearchParams,
  session: SessionLike,
): Promise<{ params: ArticleCountParams; defaulted: boolean }> {
  const [defaults, listData] = await Promise.all([
    isBareArticleCountQuery(sp) ? articleCountDefaultUnits(session) : Promise.resolve([]),
    p.list ? loadCwidList(p.list) : Promise.resolve(null),
  ]);
  const defaulted = defaults.length > 0;
  return { params: { ...p, units: defaulted ? defaults : p.units, listData }, defaulted };
}

/** The phone sheet trigger's "Filters (n)": one per who-filter selection and
 *  article type, one for a CWID list, plus one each for a non-default window
 *  (basis / years / a date-added window), minimum JIF and author position. */
export function articleCountActiveFilters(p: ArticleCountParams): number {
  const d = parseArticleCountParams(new URLSearchParams());
  const span = p.added
    ? 1
    : (p.basis !== d.basis ? 1 : 0) + (p.from !== d.from || p.to !== d.to ? 1 : 0);
  return (
    p.types.length +
    p.units.length +
    p.atypes.length +
    (p.list ? 1 : 0) +
    span +
    (p.jif !== d.jif ? 1 : 0) +
    (p.pos !== d.pos ? 1 : 0)
  );
}

/** The canonical query string — what the download link, the chips and the
 *  tabs build on. Report 9 builds on it too, so it adds nothing for a param
 *  report 9 never sets (no `f`, no window change unless `added`, no `list`). */
export function articleCountQueryString(p: ArticleCountParams): string {
  const q = new URLSearchParams();
  for (const t of p.types) q.append("type", t);
  for (const u of p.units) q.append("unit", u);
  if (p.list) q.set("list", p.list);
  for (const a of p.atypes) q.append("atype", a);
  q.set("jif", String(p.jif));
  q.set("pos", p.pos);
  if (p.added) {
    q.set("basis", ADDED_BASIS);
    q.set("added_from", p.added.from);
    q.set("added_to", p.added.to);
  } else {
    q.set("basis", p.basis);
    q.set("from", String(p.from));
    q.set("to", String(p.to));
  }
  return q.toString();
}

/** "2022–2026", "FY2022–FY2026", or "Jun 26 – Sep 24, 2026" (date added). */
export function articleCountWindowLabel(p: ArticleCountParams): string {
  if (p.added) return formatDateRange(p.added.from, p.added.to);
  const y = (n: number) => (p.basis === "fy" ? `FY${n}` : String(n));
  return p.from === p.to ? y(p.from) : `${y(p.from)}–${y(p.to)}`;
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const LONG_DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Jun 26 – Sep 24, 2026" / "Dec 1, 2025 – Jan 5, 2026" / "Sep 24, 2026". */
export function formatDateRange(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00Z`);
  const b = new Date(`${to}T00:00:00Z`);
  if (from === to) return MONTH_DAY_YEAR.format(b);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${sameYear ? MONTH_DAY.format(a) : MONTH_DAY_YEAR.format(a)} – ${MONTH_DAY_YEAR.format(b)}`;
}

/** "September 24, 2026". */
export function formatLongDate(iso: string): string {
  return LONG_DATE.format(new Date(`${iso}T00:00:00Z`));
}

/** Any unit administrator (+ comms steward), or a person granted the report
 *  by row (`report_access`, for staff who administer no unit). */
export async function canViewArticleCountReport(session: EditSession): Promise<boolean> {
  if (session.isCommsSteward || (await canViewUsage(session, db.read))) return true;
  return (await loadReportScopesForCwid(session.cwid, ARTICLE_COUNT_REPORT)).size > 0;
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

/** Moved to `lib/edit/person-filter.ts` (ORCID coverage labels its captions with it too). */
export { unitLabels };

export type ArticleCountRow = { year: number; count: number };

/** The year each counted article falls in: the calendar year of publication,
 *  the fiscal year of its PubMed add date, or (date-added window) the
 *  calendar year of its PubMed add date. */
export function articleYearExpr(p: ArticleCountParams): Prisma.Sql {
  if (p.added) return Prisma.sql`YEAR(p.date_added_to_entrez)`;
  return p.basis === "fy"
    ? Prisma.sql`YEAR(DATE_ADD(p.date_added_to_entrez, INTERVAL 6 MONTH))`
    : Prisma.sql`p.year`;
}

/** The FROM/WHERE both queries share: confirmed authorships of active
 *  scholars, the facets, the position clause, the window. `j` is a LEFT
 *  JOIN so the article sheet can show a JIF without a floor; the floor, when
 *  set, is a WHERE on it (which drops JIF-less journals, as documented). */
export function scopeSql(
  p: ArticleCountParams,
  /** An extra `AND …` clause (report 9's journal filter; a year pick). */
  extra: Prisma.Sql = Prisma.empty,
): { yearExpr: Prisma.Sql; fromWhere: Prisma.Sql } {
  const yearExpr = articleYearExpr(p);
  const posExpr = {
    any: Prisma.empty,
    first: Prisma.sql`AND pa.is_first = 1`,
    last: Prisma.sql`AND pa.is_last = 1`,
    either: Prisma.sql`AND (pa.is_first = 1 OR pa.is_last = 1)`,
  }[p.pos];
  const inList = (col: Prisma.Sql, xs: string[]) =>
    xs.length > 0 ? Prisma.sql`AND ${col} IN (${Prisma.join(xs)})` : Prisma.empty;
  const windowSql = p.added
    ? Prisma.sql`AND p.date_added_to_entrez BETWEEN ${p.added.from} AND ${p.added.to}`
    : Prisma.sql`AND ${yearExpr} BETWEEN ${p.from} AND ${p.to}`;
  // A list that is set but not resolved (or not found) matches nobody.
  const listCwids = p.list ? (p.listData?.cwids ?? []) : null;
  const fromWhere = Prisma.sql`
      FROM publication_author pa
      JOIN scholar s ON s.cwid = pa.cwid
      JOIN publication p ON p.pmid = pa.pmid
      LEFT JOIN journal_impact_factor j ON j.journal_abbrev = p.journal_abbrev
     WHERE pa.is_confirmed = 1
       AND s.deleted_at IS NULL AND s.status = 'active'
       ${personFilterSql({ types: p.types, unitValues: p.units, listCwids }, { scholar: "s", centerMembership: "cm" })}
       ${inList(Prisma.sql`p.publication_type`, p.atypes)}
       ${p.jif > 0 ? Prisma.sql`AND j.impact_score_1 >= ${p.jif}` : Prisma.empty}
       ${posExpr}
       ${extra}
       ${windowSql}`;
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
  /** The article's year on the report's basis (FY / year added / year). */
  year: number;
  articleType: string | null;
  jif: number | null;
  dateAdded: string | null;
  doi: string | null;
  /** The matching scholars, one entry each:
   *  `Name (CWID), person type, department, institution, position`. */
  scholars: string[];
  /** For the page's citation rows. */
  title: string;
  /** Every author as a `Lastname Initials` token, in order. */
  authors: string[];
  /** The matching scholars with their 1-based author rank (0 = unknown,
   *  `publication_author.position`'s sentinel). */
  matches: { cwid: string; name: string; rank: number }[];
  /** `2024;12(3):1-9` — publication year plus volume / issue / pages. */
  source: string | null;
  /** PMID link, or the non-PubMed source id as plain text (`citationIdentifier`). */
  id: { label: string; value: string; href: string | null };
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
  position: number | bigint | null;
};

/** One row per counted article, with its matching scholars — the same scope
 *  as {@link loadArticleCounts}, one row per matching authorship folded in
 *  memory. Only called when the total is within {@link ARTICLE_LIST_CAP}.
 *  `opts.year` narrows to one year of the basis (the page's year pick). */
export async function loadArticleList(
  p: ArticleCountParams,
  opts: { year?: number | null } = {},
): Promise<ArticleRow[]> {
  const yearPick =
    opts.year !== undefined && opts.year !== null
      ? Prisma.sql`AND ${articleYearExpr(p)} = ${opts.year}`
      : Prisma.empty;
  const { yearExpr, fromWhere } = scopeSql(p, yearPick);
  const raw = await db.read.$queryRaw<RawArticleRow[]>`
    SELECT p.pmid, ${yearExpr} AS y, p.title, p.journal, p.year, p.volume, p.issue, p.pages,
           p.full_authors_string, p.authors_string, p.publication_type, p.date_added_to_entrez, p.doi,
           j.impact_score_1 AS jif,
           s.preferred_name, s.cwid, s.role_category, s.primary_department, s.primary_org_code,
           pa.is_first, pa.is_last, pa.position
    ${fromWhere}
     ORDER BY y, p.pmid, pa.position`;

  const byPmid = new Map<string, ArticleRow>();
  for (const r of raw) {
    let row = byPmid.get(r.pmid);
    if (!row) {
      // `full_authors_string` is comma-separated `Lastname Initials` tokens;
      // `authors_string` is the truncated fallback with `((...))` WCM markup.
      const tokens = (r.full_authors_string ?? r.authors_string ?? "")
        .replace(/\(\(|\)\)/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const authors = tokens.map((lastName, i) => ({ rank: i + 1, lastName, firstName: null, personIdentifier: null }));
      const vip = formatVolIssuePages(r.volume, r.issue, r.pages);
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
        title: r.title,
        authors: tokens,
        matches: [],
        source: r.year === null ? null : vip ? `${r.year};${vip}` : String(r.year),
        id: citationIdentifier(r.pmid),
      };
      byPmid.set(r.pmid, row);
    }
    const position = r.is_first ? "first author" : r.is_last ? "last author" : "middle author";
    row.matches.push({ cwid: r.cwid, name: r.preferred_name, rank: Number(r.position ?? 0) });
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

/** The Criteria sheet's CWID-list value. */
export function describeCwidList(p: ArticleCountParams): string {
  if (!p.list) return "None";
  const d = p.listData;
  if (!d || !d.found) return `List ${p.list} was not found, so no one matches`;
  const n = d.cwids.length;
  const base = `List ${p.list}: ${n.toLocaleString()} CWID${n === 1 ? "" : "s"}`;
  if (d.unmatched.length === 0) return `${base}, all active scholars`;
  const shown = d.unmatched.slice(0, 50).join(", ");
  const more = d.unmatched.length > 50 ? ` and ${(d.unmatched.length - 50).toLocaleString()} more` : "";
  return `${base}; ${d.unmatched.length.toLocaleString()} not found among active scholars (not counted): ${shown}${more}`;
}

/** The filters as `[label, value]` pairs — the Criteria sheet, verbatim.
 *  `labels` names each `unit` value ({@link unitLabels}); an unknown one
 *  prints raw. `opts.cwidList` adds the CWID-list row (report 8; report 9,
 *  which has no list, leaves it out). */
export function describeCriteria(
  p: ArticleCountParams,
  generatedAt: Date,
  labels: ReadonlyMap<string, string> = new Map(),
  opts: { cwidList?: boolean } = {},
): [string, string][] {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "All");
  const windowRows: [string, string][] = p.added
    ? [
        ["Year basis", "Year the article was added to PubMed"],
        [ADDED_LABEL, `${p.added.from} to ${p.added.to} (inclusive)`],
      ]
    : [
        [
          "Year basis",
          p.basis === "fy"
            ? "Fiscal year, July 1 – June 30, named by the ending calendar year, by the date the article was added to PubMed"
            : "Calendar year of publication",
        ],
        ["Years", `${p.from}–${p.to}`],
      ];
  return [
    ["Report", "8. Article counts"],
    ["Generated", generatedAt.toISOString()],
    ...personFilterCriteria({ types: p.types, unitValues: p.units }, labels, roleCategoryLabel),
    ...(opts.cwidList ? ([["CWID list", describeCwidList(p)]] as [string, string][]) : []),
    ["Article type", list(p.atypes)],
    [
      "Minimum Journal Impact Factor",
      p.jif > 0 ? `${p.jif} or higher (articles in journals with no JIF on file are excluded)` : "None",
    ],
    ["Author position", POSITION_LABEL[p.pos]],
    ...windowRows,
    [
      "Counting rule",
      "Each article is counted once, however many matching authors it has. Only ReCiter-confirmed authorships of active scholars count; person type, department, division (including hand-added division members), institution and center membership are the scholar's current values.",
    ],
    ["Note", ARTICLE_COUNT_CAVEAT],
  ];
}

/** The year column's header: "Calendar year" / "Fiscal year (July–June)" /
 *  "Year added to PubMed". */
export function articleCountYearHeader(p: ArticleCountParams): string {
  return p.added ? "Year added to PubMed" : BASIS_LABEL[p.basis];
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
  counts.addRow([articleCountYearHeader(p), "Articles"]);
  bold(counts, 1);
  for (const r of rows) counts.addRow([r.year, r.count]);
  counts.addRow(["Total", total]);
  bold(counts, counts.rowCount);
  counts.getColumn(1).width = 26;
  counts.getColumn(2).width = 12;

  const criteria = wb.addWorksheet("Criteria");
  criteria.addRow(["Criterion", "Value"]);
  bold(criteria, 1);
  for (const [k, v] of describeCriteria(p, generatedAt, labels, { cwidList: true })) criteria.addRow([k, v]);
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
  const yearHeader = p.added ? "Year added to PubMed" : p.basis === "fy" ? "Fiscal year" : "Year";
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
