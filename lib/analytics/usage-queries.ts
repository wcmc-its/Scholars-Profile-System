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
 * against a future caller. Every other token in these strings is a literal.
 */

/** Strict ISO calendar-date shape; the only interpolated value in any query. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throw unless `dt` is a strict YYYY-MM-DD string. SQL-injection guard. */
export function assertIsoDate(dt: string): void {
  if (!ISO_DATE.test(dt)) {
    throw new Error(`invalid_date: ${dt}`);
  }
}

/** How many rows the ranked (top-N) metrics return. */
export const USAGE_TOP_N = 25;

/** The six usage queries keyed by view-model field, windowed to `sinceDt` (inclusive). */
export interface UsageQueries {
  readonly pageviewsByDay: string;
  readonly topProfiles: string;
  readonly searchTerms: string;
  readonly referrers: string;
  readonly geo: string;
  readonly device: string;
}

/**
 * Build the six usage queries for the window `[sinceDt, today]`. `dt` in
 * daily_usage is a 'YYYY-MM-DD' partition string, so a lexicographic
 * `dt >= '<sinceDt>'` is a correct date-range filter (ISO dates sort
 * chronologically). Column aliases match what {@link shapeUsageRows} reads.
 */
export function buildUsageQueries(sinceDt: string): UsageQueries {
  assertIsoDate(sinceDt);
  const since = `dt >= '${sinceDt}'`;
  const ranked = (metric: string, dimAlias: string, cntAlias: string): string =>
    [
      `SELECT dimension AS ${dimAlias}, SUM(cnt) AS ${cntAlias}`,
      "FROM daily_usage",
      `WHERE metric = '${metric}' AND ${since}`,
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
    topProfiles: ranked("profile", "cwid", "views"),
    searchTerms: ranked("search_term", "term", "searches"),
    referrers: grouped("referrer", "referrer", "hits"),
    geo: grouped("geo", "region", "hits"),
    device: grouped("device", "device", "hits"),
  };
}
