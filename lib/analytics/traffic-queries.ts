/**
 * SQL builders for the Usage dashboard's traffic sections, reading the
 * `daily_traffic` Athena rollup (metric / dimension / cnt, one partition per
 * UTC day `dt`). Metrics read here:
 *  - `traffic`: dimension 'hits' | 'pageviews' | 'visitors' (a per-day estimate).
 *  - `referrer_page`: lower(host) || path of an external referrer.
 *  - `landing`: '<referrer host>|<path>' for page views with an external referrer.
 *  - `page`: the path of every human page view.
 *  - `ai_agent`: '<fetch|crawler>|<vendor>' for declared AI agents.
 *  - `ai_landing`: '<fetch|crawler>|<path>' for AI agents' page requests.
 * Each top-N metric folds its tail into one '(other)' row per day; the lists
 * here leave it out and the overview reports its size.
 *
 * Athena takes a raw SQL string (no bound parameters), so every interpolated
 * value is validated or escaped first: dates to strict YYYY-MM-DD, categories
 * and AI classes against fixed allowlists, offsets and limits to bounded
 * integers, and free-text search through {@link sqlSearchLiteral} (control
 * characters stripped, length capped, single quotes doubled), matched with
 * `strpos` so LIKE wildcards never apply. A unit-scoped viewer's slug list
 * (from our own database) is allowlisted, never escaped (`slugSqlList`).
 */
import { assertIsoDate, slugSqlList } from "@/lib/analytics/usage-queries";
import {
  type ReferrerCategory,
  isReferrerCategory,
  toSqlCase,
} from "@/lib/analytics/referrer-category";

export const TRAFFIC_TABLE = "daily_traffic";
/** The list page size ("Show 25 more"). */
export const TRAFFIC_PAGE_SIZE = 25;
const MAX_LIMIT = 100;
const MAX_OFFSET = 1_000_000;
const MAX_SEARCH_LEN = 100;
const OTHER = "'(other)'";

export type AiClass = "fetch" | "crawler";
export const AI_CLASSES: readonly AiClass[] = ["fetch", "crawler"];
export function isAiClass(s: string): s is AiClass {
  return s === "fetch" || s === "crawler";
}

/** Top-pages filter tabs. */
export type PageKind = "all" | "home" | "profile" | "topics" | "methods";
export const PAGE_KINDS: readonly PageKind[] = ["all", "home", "profile", "topics", "methods"];
export function isPageKind(s: string): s is PageKind {
  return (PAGE_KINDS as readonly string[]).includes(s);
}

/** Top-level public routes that are not profile slugs (app/(public), /edit, /api). */
const NON_PROFILE_ROOTS = [
  "/search",
  "/about",
  "/browse",
  "/centers",
  "/cores",
  "/departments",
  "/methods",
  "/scholars",
  "/topics",
  "/edit",
  "/api",
];

/** The SQL predicate selecting one page kind over a path column. */
export function pageKindPredicate(kind: PageKind, col: string): string {
  switch (kind) {
    case "all":
      return "TRUE";
    case "home":
      return `${col} IN ('/', '/search')`;
    case "topics":
      return `(${col} = '/topics' OR ${col} LIKE '/topics/%')`;
    case "methods":
      return `(${col} = '/methods' OR ${col} LIKE '/methods/%')`;
    case "profile":
      return `(regexp_like(${col}, '^/[^/]+$') AND ${col} NOT IN (${NON_PROFILE_ROOTS.map((p) => `'${p}'`).join(", ")}))`;
  }
}

/** The JS twin of {@link pageKindPredicate}, for labels and tests. */
export function pageKindOf(path: string): Exclude<PageKind, "all"> | null {
  if (path === "/" || path === "/search") return "home";
  if (path === "/topics" || path.startsWith("/topics/")) return "topics";
  if (path === "/methods" || path.startsWith("/methods/")) return "methods";
  if (/^\/[^/]+$/.test(path) && !NON_PROFILE_ROOTS.includes(path)) return "profile";
  return null;
}

/**
 * Free-text search -> a safe SQL string literal (quotes included), or null for
 * an empty search. Lower-cased (the match is case-insensitive), trimmed,
 * control characters removed, capped at 100 characters, single quotes doubled.
 * Athena string literals have no backslash escapes, so a doubled quote is the
 * only escape needed; `strpos` matching means `%` and `_` are literal.
 */
export function sqlSearchLiteral(q: string | null | undefined): string | null {
  if (!q) return null;
  const clean = q
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .toLowerCase()
    .slice(0, MAX_SEARCH_LEN);
  if (!clean) return null;
  return `'${clean.replace(/'/g, "''")}'`;
}

function int(v: number, lo: number, hi: number, name: string): number {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`invalid_${name}: ${v}`);
  return v;
}

function dtWindow(since: string, until: string): string {
  assertIsoDate(since);
  assertIsoDate(until);
  return `dt >= '${since}' AND dt <= '${until}'`;
}

function categoryList(cats: readonly string[]): string {
  for (const c of cats) if (!isReferrerCategory(c)) throw new Error(`invalid_category: ${c}`);
  return cats.map((c) => `'${c}'`).join(", ");
}

function aiClassList(classes: readonly string[]): string {
  for (const c of classes) if (!isAiClass(c)) throw new Error(`invalid_ai_class: ${c}`);
  return classes.map((c) => `'${c}'`).join(", ");
}

/** `OFFSET … LIMIT …`, or nothing for an unpaged (export) read. */
function paging(offset: number, limit: number | null): string {
  const o = int(offset, 0, MAX_OFFSET, "offset");
  if (limit === null) return o === 0 ? "" : `OFFSET ${o}`;
  return `OFFSET ${o} LIMIT ${int(limit, 1, MAX_LIMIT, "limit")}`;
}

const REF_HOST = "split_part(dimension, '/', 1)";
const LANDING_HOST = "split_part(dimension, '|', 1)";
/** Everything after the first '|' (a path may itself contain '|'). */
const AFTER_PIPE = "substr(dimension, strpos(dimension, '|') + 1)";

/** The overview queries for `[since, until]`, keyed by view-model field. */
export interface TrafficOverviewQueries {
  /** kind ('hits' | 'pageviews' | 'visitors'), cnt (range sum), days (days with a row). */
  readonly kpi: string;
  /** dt, category, visits: external referrals per day and source category. */
  readonly sourcesDaily: string;
  /** total, other (folded into '(other)'), site_only (referrer names no page). */
  readonly referrerTotals: string;
  /** dt, series ('referral' | 'fetch' | 'crawler'), cnt. */
  readonly aiDaily: string;
  /** vendor, cnt: declared AI agents by company. */
  readonly vendors: string;
  /** first_dt: the first day daily_traffic holds, over the whole table. */
  readonly firstDt: string;
}

export function buildTrafficOverviewQueries(since: string, until: string): TrafficOverviewQueries {
  const w = dtWindow(since, until);
  const refCase = toSqlCase(REF_HOST);
  return {
    kpi: [
      "SELECT dimension AS kind, SUM(cnt) AS cnt, COUNT(DISTINCT dt) AS days",
      `FROM ${TRAFFIC_TABLE}`,
      `WHERE metric = 'traffic' AND ${w}`,
      "GROUP BY dimension",
    ].join("\n"),
    sourcesDaily: [
      `SELECT dt, ${refCase} AS category, SUM(cnt) AS visits`,
      `FROM ${TRAFFIC_TABLE}`,
      `WHERE metric = 'referrer_page' AND dimension <> ${OTHER} AND ${w}`,
      "GROUP BY 1, 2",
      "ORDER BY 1, 2",
    ].join("\n"),
    referrerTotals: [
      "SELECT SUM(cnt) AS total,",
      `  SUM(CASE WHEN dimension = ${OTHER} THEN cnt ELSE 0 END) AS other,`,
      `  SUM(CASE WHEN dimension <> ${OTHER} AND strpos(dimension, '/') IN (0, length(dimension)) THEN cnt ELSE 0 END) AS site_only`,
      `FROM ${TRAFFIC_TABLE}`,
      `WHERE metric = 'referrer_page' AND ${w}`,
    ].join("\n"),
    aiDaily: [
      "SELECT dt, series, SUM(cnt) AS cnt FROM (",
      `  SELECT dt, split_part(dimension, '|', 1) AS series, cnt FROM ${TRAFFIC_TABLE}`,
      `  WHERE metric = 'ai_agent' AND ${w}`,
      "  UNION ALL",
      `  SELECT dt, 'referral' AS series, cnt FROM ${TRAFFIC_TABLE}`,
      `  WHERE metric = 'referrer_page' AND dimension <> ${OTHER} AND ${w}`,
      `    AND ${refCase} = 'AI assistants'`,
      ")",
      "GROUP BY dt, series",
      "ORDER BY dt, series",
    ].join("\n"),
    vendors: [
      "SELECT split_part(dimension, '|', 2) AS vendor, SUM(cnt) AS cnt",
      `FROM ${TRAFFIC_TABLE}`,
      `WHERE metric = 'ai_agent' AND ${w}`,
      "GROUP BY 1",
      "ORDER BY cnt DESC",
    ].join("\n"),
    firstDt: `SELECT MIN(dt) AS first_dt FROM ${TRAFFIC_TABLE} WHERE metric = 'traffic'`,
  };
}

export type ReferrerView = "site" | "page";

export type ReferrerListParams = {
  since: string;
  until: string;
  view: ReferrerView;
  /** Empty = every category. */
  categories: readonly ReferrerCategory[];
  q?: string | null;
  offset: number;
  /** null = every row (the Excel export). */
  limit: number | null;
};

/**
 * Referring sites (grouped by host) or pages (the full host + path), busiest
 * first. Columns: ref, category, visits, total (matching rows before paging).
 */
export function buildReferrerListQuery(p: ReferrerListParams): string {
  const w = dtWindow(p.since, p.until);
  const key = p.view === "site" ? REF_HOST : "dimension";
  const where = ["TRUE"];
  if (p.categories.length > 0) where.push(`category IN (${categoryList(p.categories)})`);
  const q = sqlSearchLiteral(p.q);
  if (q) where.push(`strpos(lower(ref), ${q}) > 0`);
  return [
    "SELECT ref, category, visits, COUNT(*) OVER () AS total FROM (",
    `  SELECT ${key} AS ref, ${toSqlCase(REF_HOST)} AS category, SUM(cnt) AS visits`,
    `  FROM ${TRAFFIC_TABLE}`,
    `  WHERE metric = 'referrer_page' AND dimension <> ${OTHER} AND ${w}`,
    "  GROUP BY 1, 2",
    ")",
    `WHERE ${where.join(" AND ")}`,
    "ORDER BY visits DESC, ref",
    paging(p.offset, p.limit),
  ]
    .filter(Boolean)
    .join("\n");
}

export type PageListParams = {
  since: string;
  until: string;
  kind: PageKind;
  /** "Arrived from" referrer categories (landing pages); empty with no AI classes = every page view. */
  categories: readonly ReferrerCategory[];
  aiClasses: readonly AiClass[];
  q?: string | null;
  /** A unit-scoped viewer's people: only their profile pages (`/<slug>`,
   *  matched lower-cased). Allowlisted slugs only; an empty list matches nothing. */
  slugs?: readonly string[];
  offset: number;
  limit: number | null;
};

/** `<col>` is the profile page of one of `slugs`; FALSE for an empty list. */
function profilePathIn(col: string, slugs: readonly string[]): string {
  return slugs.length === 0 ? "FALSE" : `lower(${col}) IN (${slugSqlList(slugs, "/")})`;
}

/**
 * Top pages, busiest first. With no "Arrived from" filter, every human page
 * view (`page`); otherwise the landing pages of visits from the chosen
 * referrer categories (`landing`) plus the chosen AI agent classes
 * (`ai_landing`), summed per path. Columns: page, visits, total.
 */
export function buildPageListQuery(p: PageListParams): string {
  const w = dtWindow(p.since, p.until);
  let source: string;
  if (p.categories.length === 0 && p.aiClasses.length === 0) {
    source = [
      `  SELECT dimension AS page, SUM(cnt) AS visits FROM ${TRAFFIC_TABLE}`,
      `  WHERE metric = 'page' AND dimension <> ${OTHER} AND ${w}`,
      "  GROUP BY 1",
    ].join("\n");
  } else {
    const arms: string[] = [];
    if (p.categories.length > 0) {
      arms.push(
        [
          `    SELECT ${AFTER_PIPE} AS page, cnt FROM ${TRAFFIC_TABLE}`,
          `    WHERE metric = 'landing' AND dimension <> ${OTHER} AND ${w}`,
          `      AND ${toSqlCase(LANDING_HOST)} IN (${categoryList(p.categories)})`,
        ].join("\n"),
      );
    }
    if (p.aiClasses.length > 0) {
      arms.push(
        [
          `    SELECT ${AFTER_PIPE} AS page, cnt FROM ${TRAFFIC_TABLE}`,
          `    WHERE metric = 'ai_landing' AND dimension <> ${OTHER} AND ${w}`,
          `      AND split_part(dimension, '|', 1) IN (${aiClassList(p.aiClasses)})`,
        ].join("\n"),
      );
    }
    source = [
      "  SELECT page, SUM(cnt) AS visits FROM (",
      arms.join("\n    UNION ALL\n"),
      "  )",
      "  GROUP BY page",
    ].join("\n");
  }
  const where = [pageKindPredicate(p.kind, "page")];
  const q = sqlSearchLiteral(p.q);
  if (q) where.push(`strpos(lower(page), ${q}) > 0`);
  if (p.slugs) where.push(profilePathIn("page", p.slugs));
  return [
    "SELECT page, visits, COUNT(*) OVER () AS total FROM (",
    source,
    ")",
    `WHERE ${where.join(" AND ")}`,
    "ORDER BY visits DESC, page",
    paging(p.offset, p.limit),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Every landing page with where it came from, for the Excel export: source
 * (a referrer category, or an AI class), referrer_host ('' for AI), page,
 * visits. Busiest first. With `slugs` (a unit-scoped viewer's people), only
 * landings on their profile pages.
 */
export function buildLandingExportQuery(
  since: string,
  until: string,
  slugs?: readonly string[],
): string {
  const w = slugs
    ? `${dtWindow(since, until)} AND ${profilePathIn(AFTER_PIPE, slugs)}`
    : dtWindow(since, until);
  return [
    "SELECT source, referrer_host, page, SUM(cnt) AS visits FROM (",
    `  SELECT ${toSqlCase(LANDING_HOST)} AS source, ${LANDING_HOST} AS referrer_host, ${AFTER_PIPE} AS page, cnt`,
    `  FROM ${TRAFFIC_TABLE} WHERE metric = 'landing' AND dimension <> ${OTHER} AND ${w}`,
    "  UNION ALL",
    `  SELECT split_part(dimension, '|', 1) AS source, '' AS referrer_host, ${AFTER_PIPE} AS page, cnt`,
    `  FROM ${TRAFFIC_TABLE} WHERE metric = 'ai_landing' AND dimension <> ${OTHER} AND ${w}`,
    ")",
    "GROUP BY 1, 2, 3",
    "ORDER BY visits DESC, page",
  ].join("\n");
}
