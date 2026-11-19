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
// The rollup emits aggregates ONLY (counts by dimension). The daily_usage
// builder never selects c_ip / x_forwarded_for; the daily_traffic builder reads
// c_ip only inside approx_distinct (the per-day visitor estimate), so no raw
// client IP is ever written to either table.

/** Strict ISO calendar-date shape; the only event-derived value in any SQL. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throw unless `dt` is a strict YYYY-MM-DD string. SQL-injection guard. */
export function assertIsoDate(dt: string): void {
  if (!ISO_DATE.test(dt)) {
    throw new Error(`invalid_date: ${dt}`);
  }
}

/**
 * Oldest date (in whole UTC days before today) the rollup will re-roll. The raw
 * CloudFront logs expire 90 days after delivery (EdgeStack's
 * `sps-cf-logs-expire-<env>` lifecycle rule), and the handler PURGES a day's
 * rollup partition before re-inserting it. Re-rolling a day whose raw logs have
 * expired (or partly expired) would replace a good durable rollup with an empty
 * or short one, and the rollup is the only long-term copy of that day. 85 leaves
 * a few days of margin for delivery lag and S3's midnight-rounded expiry. Keep
 * it below the EdgeStack expiry if that rule ever changes.
 */
export const MAX_REROLL_AGE_DAYS = 85;

/**
 * True when `dt` is recent enough that its raw logs are still guaranteed to
 * exist, so a delete-then-insert re-roll cannot shrink its durable rollup.
 * `today` is the UTC calendar date the handler runs on (YYYY-MM-DD).
 */
export function isRerollable(dt: string, today: string): boolean {
  assertIsoDate(dt);
  assertIsoDate(today);
  const ageDays =
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dt}T00:00:00Z`)) /
    86_400_000;
  return ageDays <= MAX_REROLL_AGE_DAYS;
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

/**
 * Not a CloudFront edge error. WAF blocks (403), rate-limit rejections (429)
 * and WAF Challenge interstitials (202) are all logged with
 * `x_edge_result_type = 'Error'`, so this drops them regardless of status code
 * -- a future WAF Challenge rule returns a 202, which the 2xx/3xx ranges below
 * would otherwise admit. Applied to every arm (#3368).
 */
const NOT_EDGE_ERROR = "x_edge_result_type <> 'Error'";

/**
 * A successful content GET -- the baseline filter for the traffic-shape arms.
 * 202 is excluded explicitly: the WAF Challenge interstitial is a 202 with no
 * content, not a hit (NOT_EDGE_ERROR covers it too; this is belt and braces).
 */
const SUCCESS_GET = [
  "cs_method = 'GET' AND sc_status BETWEEN 200 AND 399 AND sc_status <> 202",
  `    AND ${NOT_EDGE_ERROR}`,
].join("\n");

/**
 * The traffic-shape arms (referrer/geo/device) count PAGE requests only: not
 * Next.js build assets (`/_next/`), not API calls (`/api/`), and not static
 * files (a dot in the last path segment: favicon.ico, robots.txt, *.png,
 * sitemap.xml). One page load fans out into dozens of those, so counting them
 * weighted every dimension by asset count rather than by page (#3368).
 */
const PAGE_PATH_PREDICATE = [
  "NOT starts_with(cs_uri_stem, '/_next/')",
  "    AND NOT starts_with(cs_uri_stem, '/api/')",
  "    AND NOT regexp_like(cs_uri_stem, '[.][^/]*$')",
].join("\n");

/**
 * A profile pageview must be a 2xx -- content actually rendered. The wider
 * SUCCESS_GET (<=399) is fine for the traffic-shape arms (geo/device/referrer)
 * but over-counts the profile arms: bot/scanner probes to bare single-segment
 * paths (`/docs`, `/actuator`, `/swagger`, ...) get a 301 redirect, which the
 * 3xx range counted as a "profile pageview" and polluted the top-profiles list
 * (#1476). A 3xx redirect renders nothing, so it is not a view. Excludes 304
 * too -- negligible for these dynamic (no-store) profile HTML pages.
 *
 * Also excludes responses a CloudFront Function synthesized at the edge
 * (`x_edge_result_type = 'FunctionGeneratedResponse'`): `/edge-ip`, the IP echo
 * the off-network block page fetches, is a single-segment 200 that never
 * reaches the origin, and it topped the profile list with hundreds of "views".
 * Structural rather than a reserved-list entry so the next synthetic path
 * cannot repeat it.
 */
const PROFILE_SUCCESS_GET = [
  "cs_method = 'GET' AND sc_status BETWEEN 200 AND 299",
  "    AND x_edge_result_type <> 'FunctionGeneratedResponse'",
  `    AND ${NOT_EDGE_ERROR}`,
].join("\n");

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
 * Crawler/automation User-Agent tokens (case-insensitive). The single source
 * for both the device CASE's 'bot' bucket and the NOT_BOT_UA exclusion on the
 * pageview/profile/search arms. `bot` already covers GPTBot, ClaudeBot, CCBot,
 * Amazonbot, Applebot and Googlebot, and `spider` covers Bytespider; the AI
 * crawlers without either token are named explicitly (#3368).
 */
const BOT_UA_PATTERN =
  "(?i)(bot|crawl|spider|slurp|bingpreview|facebookexternalhit|crawler|fetch|monitor|curl|wget|python-requests|httpclient|headless|perplexity|googleother|siteimprove)";

// `siteimprove`: WCM's site-QA crawler ("... LinkCheck by Siteimprove.com")
// sends a full browser UA with no bot token; unnamed, it counted as human
// (~10k pages/day from 2026-11-10).

/**
 * Exact User-Agents of scrapers that spoof a real browser, so no token regex
 * can catch them. Compared against the url-decoded cs_user_agent (CloudFront
 * standard logs URL-encode the field, e.g. spaces arrive as %20), so list them
 * DECODED, exactly as the client sent them.
 *
 * - Chrome 133 on macOS: the residential-proxy scraper of 2026-11-12 (~55k
 *   /search requests; WAF-blocked since #3367). A genuine Chrome 133 user
 *   matches too, but Chrome auto-updates and 133 is long superseded, so the
 *   real-user cost is negligible.
 */
export const KNOWN_SCRAPER_UAS: readonly string[] = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
];

const KNOWN_SCRAPER_UA_LIST = KNOWN_SCRAPER_UAS.map(
  (ua) => `'${ua.replace(/'/g, "''")}'`,
).join(", ");

/** True when the request's User-Agent is a known crawler, bot, or scraper. */
const IS_BOT_UA = [
  `(regexp_like(url_decode(cs_user_agent), '${BOT_UA_PATTERN}')`,
  `    OR url_decode(cs_user_agent) IN (${KNOWN_SCRAPER_UA_LIST}))`,
].join("\n");

/**
 * Human-traffic filter for the pageview/profile/search arms. coalesce: a NULL
 * User-Agent makes IS_BOT_UA NULL, and `NOT NULL` would silently drop the row.
 */
const NOT_BOT_UA = `NOT coalesce(${IS_BOT_UA}, false)`;

/**
 * Device class from the (url-decoded) User-Agent. Order matters: bots first
 * (they often spoof a desktop/mobile UA tail), then tablet (an Android tablet
 * UA lacks the "Mobile" token a phone carries), then mobile, else desktop.
 * The device arm deliberately does NOT apply NOT_BOT_UA: the 'bot' bucket is
 * how the dashboard shows bot share.
 */
const DEVICE_CASE = [
  "CASE",
  `  WHEN ${IS_BOT_UA} THEN 'bot'`,
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
 *
 * "Same host" compares against x_host_header (the Host the viewer asked for,
 * i.e. the public site host), NOT cs_host (the distribution's
 * *.cloudfront.net domain, which no browser ever navigates from). Days rolled
 * before this fix show in-site navigation as an external referrer equal to the
 * public host; they are deliberately not re-rolled.
 */
const REFERRER_CASE = [
  "CASE",
  "  WHEN cs_referrer = '-' OR cs_referrer IS NULL THEN '(direct)'",
  "  WHEN lower(url_extract_host(cs_referrer)) = lower(x_host_header) THEN '(internal)'",
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
 * Values of the `src=` query parameter the app adds to a `/search?q=` link the
 * user did not type: `chip` (the home "Try:" chips) and `suggest` (a MeSH
 * concept picked from the search-box typeahead). See SEARCH_SOURCES in
 * lib/search/query-url.ts -- keep the two lists in sync. Any other value, or
 * none, counts as typed.
 */
export const SUGGESTED_SEARCH_SOURCES: readonly string[] = ["chip", "suggest"];

/**
 * Which search_term metric a /search request lands in: `search_term_suggested`
 * when it carries a known `src=` tag, else `search_term` (typed). Days rolled
 * before the app started tagging have no `src=`, so every search on those days
 * stays under `search_term` -- the same metric name the dashboard and the
 * `sps-usage-search-terms-*` saved query already read.
 */
/**
 * Edge (WAF) responses that mark a /search request as automated: 202 = WAF
 * Challenge interstitial (no token yet), 403 = WAF block (labelled bot or a
 * known scraper UA), 405 = WAF CAPTCHA (automated-browser signals), 429 = WAF
 * rate limit.
 */
export const BOT_SEARCH_STATUSES: readonly number[] = [202, 403, 405, 429];

/**
 * A /search?q= request counted as a bot search: a declared bot UA (IS_BOT_UA,
 * any status), or a request the edge WAF answered instead of the origin (one of
 * BOT_SEARCH_STATUSES, or any `x_edge_result_type = 'Error'`). Before the WAF
 * challenged /search (mid-November 2026) only the UA rule can fire, so earlier
 * days undercount bots. A person's first search in a session can also land
 * here once, as the 202 Challenge their browser then solves and retries.
 * coalesce: a NULL User-Agent makes IS_BOT_UA NULL, which would otherwise fall
 * through the CASE to the human branches.
 */
const IS_BOT_SEARCH = [
  `coalesce(${IS_BOT_UA}, false)`,
  `    OR sc_status IN (${BOT_SEARCH_STATUSES.join(", ")})`,
  "    OR x_edge_result_type = 'Error'",
].join("\n");

/**
 * Human-search filter: exactly the search arm's pre-bot-split WHERE (an origin
 * 200, not an edge error, not a bot UA), so search_term and
 * search_term_suggested count what they counted before search_term_bot.
 */
const IS_HUMAN_SEARCH = `sc_status = 200 AND ${NOT_EDGE_ERROR} AND ${NOT_BOT_UA}`;

const SEARCH_METRIC_CASE = [
  "CASE",
  `  WHEN ${IS_BOT_SEARCH} THEN 'search_term_bot'`,
  `  WHEN ${IS_HUMAN_SEARCH}`,
  `    AND url_extract_parameter('http://x?' || cs_uri_query, 'src') IN (${SUGGESTED_SEARCH_SOURCES.map((v) => `'${v}'`).join(", ")}) THEN 'search_term_suggested'`,
  `  WHEN ${IS_HUMAN_SEARCH} THEN 'search_term'`,
  "END",
].join("\n");

/**
 * Traffic class of one page request, for the `hourly` arm. Order matters:
 *
 * 1. `error` -- a 5xx, whoever asked. During an outage CloudFront still logs
 *    every request (502/503/504, edge result `Error` when the origin is
 *    unreachable), so this is the series that shows a downtime. None of the
 *    WAF answers (BOT_SEARCH_STATUSES) is a 5xx, so a firewall block never
 *    lands here.
 * 2. `bot` -- a declared bot UA (IS_BOT_UA, NULL-safe), a WAF answer (one of
 *    BOT_SEARCH_STATUSES), or any other edge `Error` with a 4xx.
 * 3. `human` -- everything else the site served (2xx/3xx), minus responses a
 *    CloudFront Function synthesized at the edge (the /edge-ip echo).
 *
 * Anything else (a non-bot 4xx such as a 404) is NULL, and the arm's HAVING
 * drops it.
 */
const HOURLY_CLASS_CASE = [
  "CASE",
  "  WHEN sc_status >= 500 THEN 'error'",
  `  WHEN coalesce(${IS_BOT_UA}, false)`,
  `    OR sc_status IN (${BOT_SEARCH_STATUSES.join(", ")})`,
  "    OR (x_edge_result_type = 'Error' AND sc_status BETWEEN 400 AND 499) THEN 'bot'",
  "  WHEN sc_status BETWEEN 200 AND 399",
  "    AND x_edge_result_type <> 'FunctionGeneratedResponse' THEN 'human'",
  "END",
].join("\n");

/**
 * The `hourly` arm's dimension: `'<HH>|<class>'`, HH the two-digit UTC hour
 * from the raw log's `time` column ('HH:MM:SS', UTC like `date`; quoted, since
 * TIME is a Trino keyword). NULL whenever the class is NULL (Trino's `||` is
 * NULL-propagating), so one `IS NOT NULL` drops the unclassified rows.
 */
const HOURLY_DIMENSION_EXPR = `substr("time", 1, 2) || '|' || ${HOURLY_CLASS_CASE}`;

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
  // The CloudFront Function IP echo (cdk/lib/edge-stack.ts EDGE_IP_PATH). PROFILE_SUCCESS_GET
  // already drops it structurally via x_edge_result_type = 'FunctionGeneratedResponse', but a
  // client that hangs up mid-response is logged as Error/ClientCommError with sc_status 200
  // (10 of 267 hits in prod's first 30 days), so the path needs naming too.
  "edge-ip",
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
 * Shared WHERE tail for the two profile arms (pageviews + profile).
 *
 * `_rsc=` (Next.js Flight) requests are COUNTED by the profile arms. The client
 * router appends `?_rsc=<hash>` to prefetches and soft-navigation clicks alike,
 * and CloudFront cannot tell the two apart. Every profile <Link> is therefore
 * `prefetch={false}` (#3368), so a `?_rsc=` hit on a profile path is a real
 * in-app click. Days rolled up before that app release are prefetch-inflated if
 * re-rolled with this predicate; do not re-roll them.
 */
const PROFILE_VIEW_FILTERS = [
  PROFILE_PATH_PREDICATE,
  `    AND ${NOT_BOT_UA}`,
].join("\n");

/**
 * INSERT INTO daily_usage the aggregated marketing metrics for a single dt
 * partition: pageviews, profile, search_term (+ search_term_suggested and
 * search_term_bot, from the same arm), referrer, geo, device, hourly. Every arm
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
    `    AND ${PROFILE_VIEW_FILTERS}`,

    "  UNION ALL",

    // (2) profile -- dimension = the vanity slug, cnt = views per profile.
    `  SELECT 'profile' AS metric, ${PROFILE_SLUG_EXPR} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${PROFILE_SUCCESS_GET}`,
    `    AND ${PROFILE_VIEW_FILTERS}`,
    `  GROUP BY ${PROFILE_SLUG_EXPR}`,
    `  HAVING ${PROFILE_SLUG_EXPR} <> ''`,

    "  UNION ALL",

    // (3) search_term / search_term_suggested -- dimension = decoded/normalized
    // q=, cnt = searches.
    // Counted at the results page (`/search?q=`, the router.push target of a
    // submitted query), NOT under `/api/search%`: the browser never calls
    // `/api/search?q=` -- the only `/api/search/*` callers are the typeahead
    // (`/api/search/suggest`, every >=2-char keystroke) and the per-evidence
    // key-paper fetch, so the old arm listed typing prefixes ("sch", "ma") and
    // Matcha's internal lookups, and zero actual searches. Both the document
    // load and the RSC soft-navigation carry q=, so both count. `_rsc=` is
    // KEPT here, as in the profile arms: a submitted query is a client-side
    // router.push, so nearly every real search IS an RSC soft-nav and dropping
    // `_rsc=` would erase most real searches. Bots are kept out of the human
    // metrics by NOT_BOT_UA and NOT_EDGE_ERROR instead (#3368).
    // ponytail: pagination / tab switches re-request /search?q= and count as
    // another search of the same term; there is no session key to dedupe on
    // (cs_cookie is not logged). Accept the over-count.
    // Split by origin in one scan: a suggestion click carries `src=` and lands
    // in search_term_suggested; everything else (typed searches, and every
    // page/filter/tab change, since the search page never re-emits `src=`)
    // stays in search_term.
    // Bots split off in the same scan: search_term_bot takes every bot
    // request (IS_BOT_SEARCH, any src=) BEFORE the human branches, so each
    // request lands in exactly one metric. A request that is neither (a
    // non-bot 3xx/5xx) gets a NULL metric and the HAVING drops it.
    `  SELECT ${SEARCH_METRIC_CASE} AS metric, ${SEARCH_TERM_EXPR} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day}`,
    "    AND cs_uri_stem = '/search' AND cs_method = 'GET'",
    "    AND cs_uri_query IS NOT NULL AND cs_uri_query <> '-'",
    "    AND url_extract_parameter('http://x?' || cs_uri_query, 'q') IS NOT NULL",
    `  GROUP BY ${SEARCH_METRIC_CASE}, ${SEARCH_TERM_EXPR}`,
    `  HAVING ${SEARCH_METRIC_CASE} IS NOT NULL AND ${SEARCH_TERM_EXPR} <> ''`,

    "  UNION ALL",

    // (4) referrer -- direct/internal/external-host bucket, cnt = hits.
    `  SELECT 'referrer' AS metric, ${REFERRER_CASE} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${SUCCESS_GET}`,
    `    AND ${PAGE_PATH_PREDICATE}`,
    `  GROUP BY ${REFERRER_CASE}`,

    "  UNION ALL",

    // (5) geo -- coarse continent from x_edge_location prefix, cnt = hits.
    `  SELECT 'geo' AS metric, ${GEO_CASE} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${SUCCESS_GET}`,
    `    AND ${PAGE_PATH_PREDICATE}`,
    `  GROUP BY ${GEO_CASE}`,

    "  UNION ALL",

    // (6) device -- bot/tablet/mobile/desktop from cs_user_agent, cnt = hits.
    `  SELECT 'device' AS metric, ${DEVICE_CASE} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND ${SUCCESS_GET}`,
    `    AND ${PAGE_PATH_PREDICATE}`,
    `  GROUP BY ${DEVICE_CASE}`,

    "  UNION ALL",

    // (7) hourly -- dimension = '<HH>|<human|bot|error>' (UTC hour), cnt =
    // page requests. Page paths only (as the traffic-shape arms), any status:
    // the error and bot classes are the point (downtime and WAF load), so
    // this arm deliberately skips SUCCESS_GET / NOT_EDGE_ERROR. Starts the
    // night after it deploys; past days are NOT re-rolled for it (re-rolling
    // pre-#3368 days would inflate their profile pageviews).
    `  SELECT 'hourly' AS metric, ${HOURLY_DIMENSION_EXPR} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE "date" = ${day} AND cs_method = 'GET'`,
    `    AND ${PAGE_PATH_PREDICATE}`,
    `  GROUP BY ${HOURLY_DIMENSION_EXPR}`,
    `  HAVING ${HOURLY_DIMENSION_EXPR} IS NOT NULL`,

    ")",
  ].join("\n");
}

// ----------------------------------------------------------------------------
// daily_traffic -- site-traffic rollup (hits / pageviews / visitors, referrer
// pages, landing pages, top pages, declared AI agents). A SEPARATE table from
// daily_usage so it can be backfilled on its own (`tables: ["traffic"]`)
// without re-rolling daily_usage history. Same (metric, dimension, cnt, dt)
// shape and the same delete-then-insert idempotency (index.ts purges
// rollup/daily-traffic/dt=<date>/ before the INSERT).
// ----------------------------------------------------------------------------

/** The Glue coordinates of the daily_traffic INSERT (CDK-set Lambda env). */
export interface TrafficConfig {
  readonly database: string;
  readonly rawTable: string;
  readonly trafficTable: string;
}

/** Rows kept per high-cardinality metric per day; the rest fold into OTHER_DIMENSION. */
export const TOP_N = 5000;

/** The single row a top-N metric's long tail collapses into. */
export const OTHER_DIMENSION = "(other)";

/**
 * A page response that rendered: a 200 GET to a page path (PAGE_PATH_PREDICATE:
 * not /_next/, /api/, or a dotted static file), not an edge error, and not a
 * response a CloudFront Function synthesized (the /edge-ip echo is a dot-free
 * 200 that never reaches the origin). `?_rsc=` client navigations are page
 * requests too, so they count -- the query string is not inspected.
 */
const PAGE_OK = [
  "cs_method = 'GET' AND sc_status = 200",
  `    AND ${NOT_EDGE_ERROR}`,
  "    AND x_edge_result_type <> 'FunctionGeneratedResponse'",
  `    AND ${PAGE_PATH_PREDICATE}`,
].join("\n");

/** PAGE_OK from a non-bot User-Agent (the same bot rule as daily_usage). */
const PAGE_HUMAN = `${PAGE_OK}\n    AND ${NOT_BOT_UA}`;

/**
 * The request path, url-decoded. try(): url_decode throws on a malformed
 * %-sequence, which would fail the whole INSERT; such a path is kept raw.
 */
const PATH_EXPR = "coalesce(try(url_decode(cs_uri_stem)), cs_uri_stem)";

/** Lower-cased referrer host; NULL for '-' or an unparseable referrer. */
const REF_HOST_EXPR = "lower(url_extract_host(cs_referrer))";

/**
 * An external referrer: a parseable host that is neither the site itself
 * (x_host_header, the public host the viewer requested) nor a CloudFront
 * distribution domain. A NULL host ('-', empty, unparseable) fails the first
 * test, and a NULL comparison is not true, so those rows drop out.
 */
const EXTERNAL_REFERRER = [
  `${REF_HOST_EXPR} <> ''`,
  `    AND ${REF_HOST_EXPR} <> lower(coalesce(x_host_header, ''))`,
  `    AND ${REF_HOST_EXPR} NOT LIKE '%.cloudfront.net'`,
].join("\n");

/**
 * Referring page: host + path, query string and fragment dropped
 * (url_extract_path excludes both). An empty path reads as '/'.
 */
const REFERRER_PAGE_EXPR = `${REF_HOST_EXPR} || coalesce(nullif(url_extract_path(cs_referrer), ''), '/')`;

/** Landing page from an external referrer: '<referrer host>|<request path>'. */
const LANDING_EXPR = `${REF_HOST_EXPR} || '|' || ${PATH_EXPR}`;

/** One declared AI agent: the UA token, its class, and its vendor. */
export interface AiAgent {
  readonly token: string;
  readonly agentClass: "fetch" | "crawler";
  readonly vendor: string;
}

/**
 * Declared AI agents, matched case-insensitively as a token in the User-Agent.
 * `fetch` = a user-triggered fetch (an assistant reading a page for someone);
 * `crawler` = bulk collection for training or an AI search index. Order is the
 * CASE order (first match wins); no token is a substring of another.
 *
 * Google-Extended and Applebot-Extended are robots.txt product tokens their
 * vendors document rather than distinct crawlers, so they are listed for
 * completeness and may never match a request.
 */
export const AI_AGENTS: readonly AiAgent[] = [
  { token: "ChatGPT-User", agentClass: "fetch", vendor: "OpenAI" },
  { token: "Claude-User", agentClass: "fetch", vendor: "Anthropic" },
  { token: "Perplexity-User", agentClass: "fetch", vendor: "Perplexity" },
  { token: "MistralAI-User", agentClass: "fetch", vendor: "Mistral" },
  { token: "GPTBot", agentClass: "crawler", vendor: "OpenAI" },
  { token: "OAI-SearchBot", agentClass: "crawler", vendor: "OpenAI" },
  { token: "ClaudeBot", agentClass: "crawler", vendor: "Anthropic" },
  { token: "Claude-SearchBot", agentClass: "crawler", vendor: "Anthropic" },
  { token: "PerplexityBot", agentClass: "crawler", vendor: "Perplexity" },
  { token: "CCBot", agentClass: "crawler", vendor: "Common Crawl" },
  { token: "Google-Extended", agentClass: "crawler", vendor: "Google" },
  { token: "Bytespider", agentClass: "crawler", vendor: "ByteDance" },
  { token: "Amazonbot", agentClass: "crawler", vendor: "Amazon" },
  { token: "meta-externalagent", agentClass: "crawler", vendor: "Meta" },
  { token: "Applebot-Extended", agentClass: "crawler", vendor: "Apple" },
  { token: "DuckAssistBot", agentClass: "crawler", vendor: "DuckDuckGo" },
];

/** Escape a literal token for a Java/Joni regex inside a SQL string literal. */
function regexLiteral(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "''");
}

/**
 * Matched against the RAW cs_user_agent: CloudFront URL-encodes the field, but
 * every token is plain ASCII letters and hyphens, which it never encodes, and
 * the raw match cannot fail on a malformed %-sequence the way url_decode can.
 */
function uaMatches(tokens: readonly string[]): string {
  return `regexp_like(cs_user_agent, '(?i)(${tokens.map(regexLiteral).join("|")})')`;
}

/** '<class>|<vendor>' of a declared AI agent; NULL for any other UA. */
const AI_AGENT_CASE = [
  "CASE",
  ...AI_AGENTS.map(
    (a) => `  WHEN ${uaMatches([a.token])} THEN '${a.agentClass}|${a.vendor}'`,
  ),
  "END",
].join("\n");

/** 'fetch' / 'crawler' for a declared AI agent; NULL for any other UA. */
const AI_CLASS_CASE = [
  "CASE",
  ...(["fetch", "crawler"] as const).map(
    (cls) =>
      `  WHEN ${uaMatches(AI_AGENTS.filter((a) => a.agentClass === cls).map((a) => a.token))} THEN '${cls}'`,
  ),
  "END",
].join("\n");

/** '<class>|<path>' of an AI agent's page fetch; NULL for any other UA. */
const AI_LANDING_EXPR = `${AI_CLASS_CASE} || '|' || ${PATH_EXPR}`;

/**
 * One top-N arm: count rows by `dimExpr`, keep the TOP_N largest dimensions
 * (ties broken by dimension, so a re-roll is deterministic), and fold the rest
 * into a single OTHER_DIMENSION row. A NULL or empty dimension is dropped
 * before ranking. The fold CASE is emitted identically in SELECT and GROUP BY
 * (Trino's grouped-expression rule).
 *
 * The kept dimension has TAB / CR / LF replaced by a space: daily_traffic is
 * TSV with no escaping, and a decoded path (`%09`, `%0A`) would otherwise
 * split or shift its row.
 */
function topNArm(
  metric: string,
  dimExpr: string,
  from: string,
  where: string,
  dtLit: string,
): string[] {
  const fold = `CASE WHEN rn <= ${TOP_N} THEN regexp_replace(dimension, '[\\t\\r\\n]', ' ') ELSE '${OTHER_DIMENSION}' END`;
  return [
    `  SELECT '${metric}' AS metric, ${fold} AS dimension,`,
    `    SUM(cnt) AS cnt, ${dtLit} AS dt`,
    "  FROM (",
    "    SELECT dimension, cnt,",
    "      row_number() OVER (ORDER BY cnt DESC, dimension) AS rn",
    "    FROM (",
    `      SELECT ${dimExpr} AS dimension, COUNT(*) AS cnt`,
    `      FROM ${from}`,
    `      WHERE ${where}`,
    `      GROUP BY ${dimExpr}`,
    `      HAVING ${dimExpr} IS NOT NULL AND ${dimExpr} <> ''`,
    "    )",
    "  )",
    `  GROUP BY ${fold}`,
  ];
}

/**
 * INSERT INTO daily_traffic every site-traffic metric for one dt partition:
 *
 * - traffic: 'hits' (every request), 'pageviews' (PAGE_HUMAN), 'visitors'
 *   (approx_distinct of ip|UA over PAGE_HUMAN; a per-day estimate -- only the
 *   count is written, never the key).
 * - referrer_page: external referring page (host + path), PAGE_HUMAN. Top N.
 * - landing: '<referrer host>|<path>' for PAGE_HUMAN with an external referrer. Top N.
 * - page: decoded path, PAGE_HUMAN. Top N.
 * - ai_agent: '<class>|<vendor>' over ALL requests by a declared AI agent.
 * - ai_landing: '<class>|<path>' for PAGE_OK requests by a declared AI agent. Top N.
 *
 * Referrer source categories are NOT stored: the dashboard derives them from
 * the host at read time, so a category rule change needs no backfill.
 */
export function buildTrafficInsert(cfg: TrafficConfig, dt: string): string {
  assertIsoDate(dt);
  const { database, rawTable, trafficTable } = cfg;
  const from = `"${database}"."${rawTable}"`;
  const into = `"${database}"."${trafficTable}"`;
  const day = `"date" = DATE '${dt}'`;
  const dtLit = `'${dt}'`;
  const externalPageWhere = `${day} AND ${PAGE_HUMAN}\n    AND ${EXTERNAL_REFERRER}`;

  return [
    `INSERT INTO ${into}`,
    "SELECT metric, dimension, cnt, dt FROM (",

    // (1) traffic -- three totals from one scan, unpivoted to rows.
    `  SELECT 'traffic' AS metric, t.dimension, t.cnt, ${dtLit} AS dt`,
    "  FROM (",
    "    SELECT COUNT(*) AS hits,",
    `      count_if(${PAGE_HUMAN}) AS pageviews,`,
    `      approx_distinct(CASE WHEN ${PAGE_HUMAN} THEN c_ip || '|' || cs_user_agent END) AS visitors`,
    `    FROM ${from}`,
    `    WHERE ${day}`,
    "  ) totals",
    "  CROSS JOIN UNNEST(",
    "    ARRAY['hits', 'pageviews', 'visitors'],",
    "    ARRAY[totals.hits, totals.pageviews, totals.visitors]",
    "  ) AS t (dimension, cnt)",

    "  UNION ALL",

    // (2) referrer_page -- external referring page.
    ...topNArm("referrer_page", REFERRER_PAGE_EXPR, from, externalPageWhere, dtLit),

    "  UNION ALL",

    // (3) landing -- where external referrals land.
    ...topNArm("landing", LANDING_EXPR, from, externalPageWhere, dtLit),

    "  UNION ALL",

    // (4) page -- human pageviews by path.
    ...topNArm("page", PATH_EXPR, from, `${day} AND ${PAGE_HUMAN}`, dtLit),

    "  UNION ALL",

    // (5) ai_agent -- every request by a declared AI agent, any status.
    `  SELECT 'ai_agent' AS metric, ${AI_AGENT_CASE} AS dimension,`,
    `    COUNT(*) AS cnt, ${dtLit} AS dt`,
    `  FROM ${from}`,
    `  WHERE ${day}`,
    `  GROUP BY ${AI_AGENT_CASE}`,
    `  HAVING ${AI_AGENT_CASE} IS NOT NULL`,

    "  UNION ALL",

    // (6) ai_landing -- pages AI agents fetched successfully.
    ...topNArm("ai_landing", AI_LANDING_EXPR, from, `${day} AND ${PAGE_OK}`, dtLit),

    ")",
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Which tables a run rolls. The handler takes an optional event `tables` list
// so an operator can backfill daily_traffic alone; validated here (SDK-free)
// so the rule is unit-testable.
// ----------------------------------------------------------------------------

/** A rollup target: daily_usage ('usage') or daily_traffic ('traffic'). */
export type RollupTable = "usage" | "traffic";

/** Every rollup target, in the order a run rolls them. */
export const ROLLUP_TABLES: readonly RollupTable[] = ["usage", "traffic"];

/**
 * Validate the event's `tables` field. Absent = every table. Otherwise it must
 * be a non-empty array of known names; the result is deduplicated and in
 * ROLLUP_TABLES order. Throws `invalid_tables` before any partition is purged.
 */
export function resolveTables(tables: unknown): RollupTable[] {
  if (tables === undefined) return [...ROLLUP_TABLES];
  if (
    !Array.isArray(tables) ||
    tables.length === 0 ||
    !tables.every(
      (t) =>
        typeof t === "string" &&
        (ROLLUP_TABLES as readonly string[]).includes(t),
    )
  ) {
    throw new Error(
      `invalid_tables: expected a non-empty array of ${ROLLUP_TABLES.map((t) => `"${t}"`).join(" | ")}`,
    );
  }
  return ROLLUP_TABLES.filter((t) => (tables as unknown[]).includes(t));
}

/** One unit of rollup work: purge then re-insert `table`'s partition for `dt`. */
export interface RollupStep {
  readonly dt: string;
  readonly table: RollupTable;
}

/**
 * The ordered work for a run: each selected table, each rerollable date --
 * TABLE-major, so every daily_usage day is rolled before any daily_traffic
 * query runs. The handler stops at the first failure (and the Lambda timeout
 * caps the whole run), so a failing or slow traffic query must not keep the
 * newer day's daily_usage from being rolled. Dates older than
 * MAX_REROLL_AGE_DAYS are returned in `skipped` and never purged.
 */
export function planRollup(
  dates: readonly string[],
  tables: readonly RollupTable[],
  today: string,
): { steps: RollupStep[]; skipped: string[] } {
  const rerollable: string[] = [];
  const skipped: string[] = [];
  for (const dt of dates) {
    if (isRerollable(dt, today)) rerollable.push(dt);
    else skipped.push(dt);
  }
  const steps: RollupStep[] = [];
  for (const table of tables) {
    for (const dt of rerollable) steps.push({ dt, table });
  }
  return { steps, skipped };
}
