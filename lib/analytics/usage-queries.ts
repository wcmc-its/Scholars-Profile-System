/**
 * SQL builders for the in-app Usage dashboard. Each query reads the
 * pre-aggregated `daily_usage` Athena table (the nightly CloudFront rollup) by
 * its `metric` discriminator — the same table the saved `sps-usage-*` named
 * queries read, so the dashboard and the console queries never disagree. Usage
 * metrics ONLY: `daily_usage` holds aggregates (counts by dimension), never raw
 * client IPs or paths, so this surface carries no PII. The per-URL performance
 * queries deliberately live only in the operator-restricted workgroup (they read
 * the raw log table) and are NOT surfaced here.
 *
 * Athena's StartQueryExecution takes a raw SQL string (no bound params like
 * Prisma), so the window cutoff is INLINED — and therefore validated to a strict
 * YYYY-MM-DD shape by {@link assertIsoDate} first. `sinceDt` is computed
 * server-side (utcDaysAgo), never from user input; the guard is defense in depth
 * against a future caller. Every other token in these strings is a literal,
 * except the Try-chip term list, which comes from a checked-in source file
 * (HERO_SEARCH_SUGGESTIONS) and is quote-escaped.
 */
import { HERO_SEARCH_SUGGESTIONS } from "@/lib/hero-search-suggestions";

/** Strict ISO calendar-date shape; the only interpolated value in any query. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throw unless `dt` is a strict YYYY-MM-DD string. SQL-injection guard. */
export function assertIsoDate(dt: string): void {
  if (!ISO_DATE.test(dt)) {
    throw new Error(`invalid_date: ${dt}`);
  }
}

/**
 * First day the search metrics can be trusted (prod and staging alike). Before
 * it, link prefetch (home chips, profile and /search facet links) fired
 * uncached /search requests indistinguishable from clicks in the CloudFront
 * logs, and suggestion clicks carried no `src=` tag; #3370, #3376, #3377 and
 * #3382 fixed both on 11-13. Earlier days can't be cleaned after the fact, so
 * every search query clamps its window to start here.
 */
export const SEARCH_STATS_START = "2026-11-14";

/**
 * The home-page Try chip terms, normalized the way the rollup normalizes `q=`
 * (lower-cased, trimmed), as a SQL IN-list. Since SEARCH_STATS_START a real
 * chip click carries `src=chip`, so an UNTAGGED search for exactly a chip term
 * is automated (prod 11-14: a scraper sent thousands of untagged "molecular
 * imaging" searches). Those are left out of typed searches entirely.
 * ponytail: a person who types a chip term verbatim is dropped too; accepted.
 */
const CHIP_TERMS = `(${[...new Set(HERO_SEARCH_SUGGESTIONS.map((t) => t.trim().toLowerCase()))]
  .map((t) => `'${t.replace(/'/g, "''")}'`)
  .join(", ")})`;
const TYPED = `metric = 'search_term' AND dimension NOT IN ${CHIP_TERMS}`;

/** How many rows the ranked (top-N) metrics return. */
export const USAGE_TOP_N = 25;

/** The usage queries keyed by view-model field, windowed to `sinceDt` (inclusive). */
export interface UsageQueries {
  readonly pageviewsByDay: string;
  readonly topProfiles: string;
  /** Typed searches (`search_term`: no `src=` tag), minus untagged exact Try-chip terms. */
  readonly searchTerms: string;
  /** Suggestion clicks (`search_term_suggested`: home chips, typeahead concept picks). */
  readonly suggestedSearchTerms: string;
  /** Range totals (`metric` = 'typed' | 'suggested', `searches`), not capped at top-N. */
  readonly searchTotals: string;
  readonly geo: string;
  readonly device: string;
  /**
   * Page requests per UTC hour and traffic class (`hourly`: dimension
   * `'<HH>|<human|bot|error>'`), one row per (dt, dimension). Uncapped: at
   * most 72 rows a day.
   */
  readonly hourly: string;
}

/**
 * Build the usage queries for the window `[sinceDt, untilDt]` (both
 * inclusive; no upper bound when `untilDt` is omitted). `dt` in daily_usage is a
 * 'YYYY-MM-DD' partition string, so lexicographic `dt >= / <=` comparisons are a
 * correct date-range filter (ISO dates sort chronologically), and partition
 * projection prunes to just those days. Column aliases match what
 * {@link shapeUsageRows} reads.
 */
export function buildUsageQueries(sinceDt: string, untilDt?: string): UsageQueries {
  assertIsoDate(sinceDt);
  if (untilDt !== undefined) assertIsoDate(untilDt);
  const since =
    untilDt === undefined ? `dt >= '${sinceDt}'` : `dt >= '${sinceDt}' AND dt <= '${untilDt}'`;
  // ISO dates compare correctly as strings.
  const searchFrom = sinceDt > SEARCH_STATS_START ? sinceDt : SEARCH_STATS_START;
  const searchSince = since.replace(`dt >= '${sinceDt}'`, `dt >= '${searchFrom}'`);
  const ranked = (metric: string, dimAlias: string, cntAlias: string, window = since): string =>
    rankedWhere(`metric = '${metric}'`, dimAlias, cntAlias, window);
  const rankedWhere = (where: string, dimAlias: string, cntAlias: string, window = since): string =>
    [
      `SELECT dimension AS ${dimAlias}, SUM(cnt) AS ${cntAlias}`,
      "FROM daily_usage",
      `WHERE ${where} AND ${window}`,
      "GROUP BY dimension",
      `ORDER BY ${cntAlias} DESC`,
      `LIMIT ${USAGE_TOP_N}`,
    ].join("\n");
  const grouped = (metric: string, dimAlias: string, cntAlias: string): string =>
    [
      `SELECT dimension AS ${dimAlias}, SUM(cnt) AS ${cntAlias}`,
      "FROM daily_usage",
      `WHERE metric = '${metric}' AND ${since}`,
      "GROUP BY dimension",
      `ORDER BY ${cntAlias} DESC`,
    ].join("\n");

  return {
    pageviewsByDay: [
      "SELECT dt, SUM(cnt) AS views",
      "FROM daily_usage",
      `WHERE metric = 'pageviews' AND ${since}`,
      "GROUP BY dt",
      "ORDER BY dt",
    ].join("\n"),
    topProfiles: ranked("profile", "slug", "views"),
    searchTerms: rankedWhere(TYPED, "term", "searches", searchSince),
    suggestedSearchTerms: ranked("search_term_suggested", "term", "searches", searchSince),
    // search_term_bot (requests the edge challenged or blocked, or declared
    // bot UAs) is left out: those searches were never served.
    searchTotals: [
      "SELECT CASE metric WHEN 'search_term_suggested' THEN 'suggested' ELSE 'typed' END AS metric,",
      "  SUM(cnt) AS searches",
      "FROM daily_usage",
      `WHERE (metric = 'search_term_suggested' OR (${TYPED})) AND ${searchSince}`,
      "GROUP BY 1",
    ].join("\n"),
    geo: grouped("geo", "region", "hits"),
    device: grouped("device", "device", "hits"),
    hourly: [
      "SELECT dt, dimension AS slot, SUM(cnt) AS hits",
      "FROM daily_usage",
      `WHERE metric = 'hourly' AND ${since}`,
      "GROUP BY dt, dimension",
      "ORDER BY dt, dimension",
    ].join("\n"),
  };
}
