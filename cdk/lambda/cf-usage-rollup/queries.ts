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
  "(?i)(bot|crawl|spider|slurp|bingpreview|facebookexternalhit|crawler|fetch|monitor|curl|wget|python-requests|httpclient|headless|perplexity|googleother)";

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
 * search_term_bot, from the same arm), referrer, geo, device. Every arm
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

    ")",
  ].join("\n");
}
