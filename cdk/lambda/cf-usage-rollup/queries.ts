// Pure SQL-string builders for the CloudFront usage rollup. This module
// imports NOTHING from @aws-sdk so it (and its unit test) typecheck and run
// without the SDK installed (mirrors the oncall-relay adaptive-card.ts split:
// the pure formatter is testable in isolation from the network/SDK layer).
//
// SECURITY: dt values are validated to the strict YYYY-MM-DD shape by
// assertIsoDate before they ever reach a query string -- the only SQL-injection
// surface, since dt comes from the EventBridge event / a backfill range. Every
// other value (database/table names) comes from the Lambda's own environment
// (set by CDK), not from the event. Do not interpolate event fields into SQL
// without validation.
//
// The rollup emits aggregates ONLY (counts by dimension). It never selects
// c_ip / x_forwarded_for, so no raw client IP is ever written to daily_usage.

/** Strict ISO calendar-date shape; the only event-derived value in any SQL. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throw unless `dt` is a strict YYYY-MM-DD string. SQL-injection guard. */
export function assertIsoDate(dt: string): void {
  if (!ISO_DATE.test(dt)) {
    throw new Error(`invalid_date: ${dt}`);
  }
}

/**
 * The Glue catalog coordinates the rollup INSERT runs against. Supplied to the
 * builder by the handler from the Lambda's own environment (CDK-set), never
 * from the invocation event.
 */
export interface RollupConfig {
  readonly database: string;
  readonly rawTable: string;
  readonly rollupTable: string;
}

// ----------------------------------------------------------------------------
// Reusable predicate / expression fragments.
//
// The geo CASE, device CASE, and referrer CASE are each written ONCE and reused
// verbatim in both the SELECT and the GROUP BY of their arm -- Trino requires a
// grouped expression to be character-identical between SELECT and GROUP BY, so
// inlining them twice by hand is a correctness hazard. SUCCESS_GET is the shared
// "real human-ish hit" filter (a successful GET) every count except the search
// arm applies.
// ----------------------------------------------------------------------------

/** A successful content GET -- the baseline filter for every hit/pageview count. */
const SUCCESS_GET = `cs_method = 'GET' AND sc_status BETWEEN 200 AND 399`;

/**
 * A profile pageview must be a 2xx -- content actually rendered. The wider
 * SUCCESS_GET (<=399) is fine for the traffic-shape arms (geo/device/referrer)
 * but over-counts the profile arms: bot/scanner probes to bare single-segment
 * paths (`/docs`, `/actuator`, `/swagger`, ...) get a 301 redirect, which the
 * 3xx range counted as a "profile pageview" and polluted the top-profiles list
 * (#1476). A 3xx redirect renders nothing, so it is not a view. Excludes 304
 * too -- negligible for these dynamic (no-store) profile HTML pages.
 */
const PROFILE_SUCCESS_GET = `cs_method = 'GET' AND sc_status BETWEEN 200 AND 299`;

/**
 * Coarse continent from the CloudFront edge-location IATA prefix
 * (substr(x_edge_location,1,3)). Not exhaustive -- the long tail rolls into
 * 'Other/Unknown'; the named POPs cover the bulk of PRICE_CLASS_100 (NA + EU)
 * traffic plus the common global edges. Geo is aggregate-only (no IP), so this
 * stays within the PII posture.
 */
const GEO_CASE = [
  "CASE",
  "  WHEN substr(x_edge_location,1,3) IN ('JFK','EWR','BOS','IAD','DCA','ATL','MIA','ORD','DFW','IAH','DEN','SEA','SFO','LAX','SJC','PDX','PHX','SLC','MSP','ORF','YTO','YUL','YVR','QRO','GIG') THEN 'North America'",
  "  WHEN substr(x_edge_location,1,3) IN ('LHR','LCY','MAN','DUB','CDG','MRS','FRA','MUC','TXL','DUS','HAM','AMS','MAD','MXP','FCO','PMO','ARN','CPH','HEL','OSL','VIE','ZRH','WAW','PRG','ATH','LIS','BCN','BRU','SOF','BUH') THEN 'Europe'",
  "  WHEN substr(x_edge_location,1,3) IN ('NRT','KIX','TPE','HKG','SIN','ICN','BOM','DEL','MAA','HYD','BLR','CCU','PEK','SZX','ZHY','BKK','KUL','CGK','MNL','DXB','FJR','TLV','HND') THEN 'Asia'",
  "  WHEN substr(x_edge_location,1,3) IN ('SYD','MEL','PER','AKL','BNE') THEN 'Oceania'",
  "  WHEN substr(x_edge_location,1,3) IN ('GRU','EZE','SCL','BOG','LIM') THEN 'South America'",
  "  WHEN substr(x_edge_location,1,3) IN ('CPT','JNB','NBO','LOS','CAI') THEN 'Africa'",
  "  ELSE 'Other/Unknown'",
  "END",
].join("\n");

/**
 * Device class from the (url-decoded) User-Agent. Order matters: bots first
 * (they often spoof a desktop/mobile UA tail), then tablet (an Android tablet
 * UA lacks the "Mobile" token a phone carries), then mobile, else desktop.
 */
const DEVICE_CASE = [
  "CASE",
  "  WHEN regexp_like(url_decode(cs_user_agent), '(?i)(bot|crawl|spider|slurp|bingpreview|facebookexternalhit|crawler|fetch|monitor|curl|wget|python-requests|httpclient|headless)') THEN 'bot'",
  "  WHEN regexp_like(url_decode(cs_user_agent), '(?i)(ipad|tablet|playbook|silk|(android(?!.*mobile)))') THEN 'tablet'",
  "  WHEN regexp_like(url_decode(cs_user_agent), '(?i)(mobi|iphone|ipod|android.*mobile|blackberry|iemobile|opera mini|windows phone)') THEN 'mobile'",
  "  ELSE 'desktop'",
  "END",
].join("\n");

/**
 * Referrer bucket: direct/internal vs external host. Per the spec, cs_referrer
 * = '-' (CloudFront's "no referrer" sentinel) and a same-host referrer both
 * collapse to direct/internal; a real external referrer reduces to its host so
 * the dimension stays low-cardinality and PII-free (no full URLs / query strings).
 */
const REFERRER_CASE = [
  "CASE",
  "  WHEN cs_referrer = '-' OR cs_referrer IS NULL THEN '(direct)'",
  "  WHEN url_extract_host(cs_referrer) = cs_host THEN '(internal)'",
  "  WHEN url_extract_host(cs_referrer) = '' THEN '(direct)'",
  "  ELSE url_extract_host(cs_referrer)",
  "END",
].join("\n");

/**
 * Decoded + normalized search term from the `q=` query parameter. The raw
 * cs_uri_query is the query string without a leading '?', so it is prefixed
 * with a dummy URL for url_extract_parameter, then lower-cased + trimmed so
 * "Cancer" and "cancer " collapse to one term.
 */
const SEARCH_TERM_EXPR =
  "lower(trim(url_decode(url_extract_parameter('http://x?' || cs_uri_query, 'q'))))";

/**
 * Reserved top-level route segments that are NOT scholar profiles. SPS serves a
 * profile at a ROOT vanity slug (`app/(public)/[slug]`, e.g. `/carl-f-nathan`) —
 * there is no `/scholar/<cwid>` path — so a profile pageview is a single-segment
 * root path whose segment is none of these app routes. Keep in sync with the
 * app's top-level routes.
 *
 * ponytail: hardcoded reserved list is the maintenance ceiling. If profile
 * counts ever start absorbing a new site section, add that section's root
 * segment here. Dotted paths (favicon.ico, robots.txt, *.png, sitemap.xml) are
 * excluded structurally by the no-dot class below, so they need no entry.
 */
const RESERVED_ROOT_SEGMENTS = [
  "about",
  "browse",
  "centers",
  "cores",
  "departments",
  "methods",
  "scholars",
  "search",
  "topics",
  "api",
  "edit",
  "healthz",
  "og",
  "readiness",
  "sitemap",
]
  .map((s) => `'${s}'`)
  .join(", ");

/** The root vanity slug from a `/<slug>` profile URL (empty if not a bare root path). */
const PROFILE_SLUG_EXPR = "regexp_extract(cs_uri_stem, '^/([^/?]+)', 1)";

/**
 * Predicate identifying a scholar-profile pageview: a single-segment root path
 * with no dot (so static files like `/robots.txt` are excluded) and an optional
 * trailing slash, whose segment is not a reserved app route. Shared verbatim by
 * the pageviews + profile arms.
 */
const PROFILE_PATH_PREDICATE = [
  "regexp_like(cs_uri_stem, '^/[^/?.]+/?$')",
  `    AND ${PROFILE_SLUG_EXPR} NOT IN (${RESERVED_ROOT_SEGMENTS})`,
].join("\n");

/**
 * INSERT INTO daily_usage the six aggregated marketing metrics for a single dt
 * partition: pageviews, profile, search_term, referrer, geo, device. Every arm
 * emits (metric, dimension, cnt, dt) with dt LAST (the partition-projection
 * column-order rule -- the partition key is the final column of the SELECT),
 * and dt is the literal validated date string.
 *
 * Idempotency is handled OUT OF BAND by index.ts deleting the
 * rollup/daily-usage/dt=<date>/ S3 prefix before this INSERT runs
 * (delete-then-insert) -- Athena INSERT INTO only appends, and external Glue
 * tables support neither INSERT OVERWRITE of a partition nor DELETE, so a
 * re-run without the purge would double-count.
 */
export function buildRollupInsert(cfg: RollupConfig, dt: string): string {
  assertIsoDate(dt);
  const { database, rawTable, rollupTable } = cfg;
  const from = `"${database}"."${rawTable}"`;
  const into = `"${database}"."${rollupTable}"`;
  // The reserved word `date` is double-quoted; DATE '<dt>' is the typed literal
  // the partition predicate compares against.
  const day = `DATE '${dt}'`;
  const dtLit = `'${dt}'`;

  return [
    `INSERT INTO ${into}`,
    "SELECT metric, dimension, cnt, dt FROM (",

    // (1) pageviews -- successful GETs to a bare /<slug> profile page (root
    // vanity slug, minus reserved routes); a single rolled-up bucket label
    // (totals live in the cnt column).
    "  SELECT 'pageviews' AS metric, 'profile_pageviews' AS dimension,",
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${PROFILE_SUCCESS_GET}`,
    `    AND ${PROFILE_PATH_PREDICATE}`,

    "  UNION ALL",

    // (2) profile -- dimension = the vanity slug, cnt = views per profile.
    `  SELECT 'profile' AS metric, ${PROFILE_SLUG_EXPR} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${PROFILE_SUCCESS_GET}`,
    `    AND ${PROFILE_PATH_PREDICATE}`,
    `  GROUP BY ${PROFILE_SLUG_EXPR}`,
    `  HAVING ${PROFILE_SLUG_EXPR} <> ''`,

    "  UNION ALL",

    // (3) search_term -- dimension = decoded/normalized q=, cnt = searches.
    `  SELECT 'search_term' AS metric, ${SEARCH_TERM_EXPR} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day}`,
    "    AND cs_uri_stem LIKE '/api/search%'",
    "    AND cs_uri_query IS NOT NULL AND cs_uri_query <> '-'",
    "    AND url_extract_parameter('http://x?' || cs_uri_query, 'q') IS NOT NULL",
    `  GROUP BY ${SEARCH_TERM_EXPR}`,
    `  HAVING ${SEARCH_TERM_EXPR} <> ''`,

    "  UNION ALL",

    // (4) referrer -- direct/internal/external-host bucket, cnt = hits.
    `  SELECT 'referrer' AS metric, ${REFERRER_CASE} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${SUCCESS_GET}`,
    `  GROUP BY ${REFERRER_CASE}`,

    "  UNION ALL",

    // (5) geo -- coarse continent from x_edge_location prefix, cnt = hits.
    `  SELECT 'geo' AS metric, ${GEO_CASE} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${SUCCESS_GET}`,
    `  GROUP BY ${GEO_CASE}`,

    "  UNION ALL",

    // (6) device -- bot/tablet/mobile/desktop from cs_user_agent, cnt = hits.
    `  SELECT 'device' AS metric, ${DEVICE_CASE} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${SUCCESS_GET}`,
    `  GROUP BY ${DEVICE_CASE}`,

    ")",
  ].join("\n");
}
