// Unit tests for the SDK-free rollup SQL builder (queries.ts). Runs under the
// repo's root jest config (testMatch test/**/*.test.ts). It imports ONLY
// queries.ts -- which imports nothing from @aws-sdk -- so it passes before the
// Integration step adds the @aws-sdk workspace + lockfile hoist that index.ts
// needs. The import is extensionless on purpose: ts-jest's CommonJS resolver
// does not remap a NodeNext `.js` specifier back to the `.ts` source, but it
// resolves the extensionless path directly to queries.ts.
import {
  assertIsoDate,
  buildRollupInsert,
  isRerollable,
  BOT_SEARCH_STATUSES,
  KNOWN_SCRAPER_UAS,
  MAX_REROLL_AGE_DAYS,
  SUGGESTED_SEARCH_SOURCES,
} from "../lambda/cf-usage-rollup/queries";

const CFG = {
  database: "sps_usage_staging",
  rawTable: "cf_access_logs",
  rollupTable: "daily_usage",
};

describe("assertIsoDate", () => {
  it("accepts a strict YYYY-MM-DD date", () => {
    expect(() => assertIsoDate("2026-05-22")).not.toThrow();
  });

  it("rejects an out-of-shape date", () => {
    // The guard is a strict SHAPE check (YYYY-MM-DD digit grouping), not a
    // calendar-validity check -- it only has to neutralize the SQL-injection
    // surface, and CloudFront log `date` values are always real dates. So the
    // rejected cases are ones that violate the 4-2-2 digit shape.
    expect(() => assertIsoDate("2026-5-2")).toThrow(/invalid_date/);
    expect(() => assertIsoDate("26-05-22")).toThrow(/invalid_date/);
    expect(() => assertIsoDate("2026/05/22")).toThrow(/invalid_date/);
  });

  it("rejects a SQL-injection attempt", () => {
    expect(() => assertIsoDate("2026-05-22'; DROP TABLE")).toThrow(
      /invalid_date/,
    );
  });
});

describe("buildRollupInsert", () => {
  const sql = buildRollupInsert(CFG, "2026-05-22");

  it("validates the date (rejects a bad dt before building SQL)", () => {
    expect(() => buildRollupInsert(CFG, "bad")).toThrow(/invalid_date/);
  });

  it("targets the fully-qualified rollup + raw tables", () => {
    expect(sql).toContain(`INSERT INTO "sps_usage_staging"."daily_usage"`);
    expect(sql).toContain(`"sps_usage_staging"."cf_access_logs"`);
  });

  it("embeds the validated date as a literal predicate", () => {
    expect(sql).toContain(`"date" = DATE '2026-05-22'`);
    // dt projected as the validated literal string in every arm.
    expect(sql).toContain("'2026-05-22' AS dt");
  });

  it("projects the partition column dt LAST in the outer SELECT", () => {
    // Partition-projection rule: dt must be the final column.
    expect(sql).toContain("SELECT metric, dimension, cnt, dt FROM (");
  });

  it("emits all six marketing metric arms", () => {
    for (const metric of ["'pageviews'", "'profile'", "'referrer'", "'geo'", "'device'"]) {
      expect(sql).toContain(`${metric} AS metric`);
    }
    // search_term / search_term_suggested / search_term_bot come from one
    // arm's metric CASE.
    expect(sql).toContain("THEN 'search_term'\nEND AS metric");
    // Five UNION ALL joins between six arms.
    expect(sql.match(/UNION ALL/g)).toHaveLength(5);
  });

  it("uses the AWS cs_referrer spelling and double-quoted reserved word date", () => {
    expect(sql).toContain("cs_referrer");
    expect(sql).not.toMatch(/\bcs_referer\b/);
    expect(sql).toContain('"date"');
  });

  it("groups the per-dimension arms (profile/search/referrer/geo/device)", () => {
    expect(sql).toContain("GROUP BY regexp_extract(cs_uri_stem");
    expect(sql).toContain(
      ", lower(trim(url_decode(url_extract_parameter('http://x?' || cs_uri_query, 'q'))))\n",
    );
    // referrer/geo/device CASE group-bys: the CASE keyword follows GROUP BY
    // on the same line (`GROUP BY CASE\n  WHEN ...`).
    expect(sql).toMatch(/GROUP BY CASE\n/);
  });

  it("never selects a raw client-IP column (PII guard)", () => {
    expect(sql).not.toContain("c_ip");
    expect(sql).not.toContain("x_forwarded_for");
  });

  it("counts profiles at the root vanity slug, not a nonexistent /scholar/ path", () => {
    // SPS profiles live at a root slug (app/(public)/[slug]); there is no
    // /scholar/<cwid> route, so the old pattern counted zero (bug: pageviews=0).
    expect(sql).not.toContain("/scholar/");
    // Single-segment, dot-free root path...
    expect(sql).toContain("^/[^/?.]+/?$");
    // ...minus the reserved app routes.
    expect(sql).toContain("NOT IN ('about', 'browse'");
  });

  it("counts searches at the /search results page, not the typeahead/api paths", () => {
    // /api/search/suggest fires per keystroke and /api/search/key-paper is a
    // Matcha evidence fetch -- neither is a search. Real searches land on
    // /search?q= (document + RSC soft-nav).
    expect(sql).toContain("cs_uri_stem = '/search' AND cs_method = 'GET'\n");
    expect(sql).not.toContain("/api/search");
  });

  it("excludes CloudFront-Function synthetic 200s (/edge-ip) from the profile arms", () => {
    const guards = sql.match(/x_edge_result_type <> 'FunctionGeneratedResponse'/g) ?? [];
    expect(guards).toHaveLength(2);
    // ...and by name: a client hang-up mid-response is logged Error/ClientCommError, not
    // FunctionGeneratedResponse, so the structural guard alone let 10 of 267 hits through.
    expect(sql).toContain("'edge-ip'");
  });

  it("restricts the two profile arms to 2xx, leaves the traffic arms at <=3xx (#1476)", () => {
    // A profile pageview must be a 2xx (content rendered); a 3xx redirect --
    // e.g. bot probes to /docs, /actuator getting a 301 -- is not a view and
    // must not count. The geo/device/referrer traffic-shape arms keep the wider
    // range. So: exactly 2 arms at 200-299, exactly 3 at 200-399.
    const twoxx = sql.match(/sc_status BETWEEN 200 AND 299/g) ?? [];
    const upTo3xx = sql.match(/sc_status BETWEEN 200 AND 399/g) ?? [];
    expect(twoxx).toHaveLength(2);
    expect(upTo3xx).toHaveLength(3);
  });
});

describe("buildRollupInsert bot / prefetch / edge-error filters (#3368)", () => {
  const sql = buildRollupInsert(CFG, "2026-11-12");
  // Arms in emit order: pageviews, profile, search_term, referrer, geo, device.
  const [pageviews, profile, search, referrer, geo, device] = sql.split("UNION ALL");
  const NOT_BOT = "NOT coalesce((regexp_like(url_decode(cs_user_agent)";
  const SCRAPER = `'${KNOWN_SCRAPER_UAS[0]}'`;

  it("lists the 2026-11-12 residential-proxy scraper UA decoded", () => {
    expect(KNOWN_SCRAPER_UAS).toContain(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    );
    // Compared against the url-decoded UA, never the raw %20-encoded field.
    expect(sql).toContain(`url_decode(cs_user_agent) IN (${SCRAPER})`);
  });

  it("excludes bot UAs from the pageview, profile, and search arms", () => {
    for (const arm of [pageviews, profile, search]) {
      expect(arm).toContain(NOT_BOT);
      expect(arm).toContain(SCRAPER);
      // `bot` covers GPTBot/ClaudeBot/CCBot/Amazonbot/Applebot; `spider` Bytespider.
      expect(arm).toContain("(?i)(bot|crawl|spider|");
      expect(arm).toContain("perplexity|googleother");
    }
  });

  it("keeps bots visible in the device breakdown and does not filter traffic arms by UA", () => {
    // The device arm LABELS bots (same pattern + scraper list) but never excludes them.
    expect(device).toContain("WHEN (regexp_like(url_decode(cs_user_agent)");
    expect(device).toContain("perplexity|googleother");
    expect(device).toContain(SCRAPER);
    expect(device).toContain("THEN 'bot'");
    for (const arm of [referrer, geo, device]) {
      expect(arm).not.toContain("NOT coalesce(");
    }
  });

  it("counts RSC (_rsc=) soft-nav clicks in every arm (profile links never prefetch)", () => {
    // Profile <Link>s are prefetch={false}, so a ?_rsc= profile hit is a real click.
    for (const arm of [pageviews, profile, search]) {
      expect(arm).not.toContain("_rsc=");
    }
    expect(sql).not.toContain("_rsc=");
  });

  it("excludes CloudFront edge errors (WAF block/challenge) from every arm", () => {
    for (const arm of [pageviews, profile, search, referrer, geo, device]) {
      expect(arm).toContain("x_edge_result_type <> 'Error'");
    }
  });

  it("never counts a 202 WAF challenge in the traffic-source arms", () => {
    for (const arm of [referrer, geo, device]) {
      expect(arm).toContain("sc_status BETWEEN 200 AND 399 AND sc_status <> 202");
    }
  });

  it("restricts referrer/geo/device to page paths (no /_next/, /api/, dotted assets)", () => {
    for (const arm of [referrer, geo, device]) {
      expect(arm).toContain("NOT starts_with(cs_uri_stem, '/_next/')");
      expect(arm).toContain("NOT starts_with(cs_uri_stem, '/api/')");
      expect(arm).toContain("NOT regexp_like(cs_uri_stem, '[.][^/]*$')");
    }
    for (const arm of [pageviews, profile, search]) {
      expect(arm).not.toContain("starts_with(cs_uri_stem, '/_next/')");
    }
  });
});

describe("buildRollupInsert typed vs suggested vs bot search terms", () => {
  const sql = buildRollupInsert(CFG, "2026-11-13");
  const search = sql.split("UNION ALL")[2];
  const UA_RE = "(regexp_like(url_decode(cs_user_agent), '(?i)(bot|crawl|spider|";
  const SRC_IN = "url_extract_parameter('http://x?' || cs_uri_query, 'src') IN ('chip', 'suggest')";
  const HUMAN = "sc_status = 200 AND x_edge_result_type <> 'Error' AND NOT coalesce(";
  // The metric CASE, exactly as SELECT emits it (GROUP BY and HAVING repeat it).
  const caseStart = search.indexOf("SELECT CASE\n") + "SELECT ".length;
  const METRIC_CASE = search.slice(caseStart, search.indexOf("\nEND AS metric") + "\nEND".length);
  const branches = METRIC_CASE.split("\n  WHEN ").slice(1);

  it("tags exactly the app's suggestion sources (lib/search/query-url.ts SEARCH_SOURCES)", () => {
    expect([...SUGGESTED_SEARCH_SOURCES]).toEqual(["chip", "suggest"]);
  });

  it("counts the WAF challenge / block / CAPTCHA / rate-limit statuses as bot", () => {
    expect([...BOT_SEARCH_STATUSES]).toEqual([202, 403, 405, 429]);
  });

  it("splits the search arm three ways in one scan, bot first so each request counts once", () => {
    expect(branches).toHaveLength(3);
    // 1. bot: declared bot UA (NULL-safe), or a WAF-answered request, any src=.
    expect(branches[0]).toContain(`coalesce(${UA_RE}`);
    expect(branches[0]).toContain("OR sc_status IN (202, 403, 405, 429)");
    expect(branches[0]).toContain("OR x_edge_result_type = 'Error'");
    expect(branches[0]).toMatch(/THEN 'search_term_bot'$/);
    expect(branches[0]).not.toContain("'src'");
    // 2. suggested: a human 200 carrying src=chip|suggest.
    expect(branches[1]).toContain(HUMAN);
    expect(branches[1]).toContain(`${SRC_IN} THEN 'search_term_suggested'`);
    // 3. typed: every other human 200 (pre-tag days included).
    expect(branches[2]).toContain(HUMAN);
    expect(branches[2]).not.toContain("'src'");
    expect(branches[2]).toMatch(/THEN 'search_term'\nEND$/);
    // No ELSE: a non-bot 3xx/5xx is NULL and the HAVING drops it.
    expect(METRIC_CASE).not.toContain("ELSE");
  });

  it("groups and filters on the character-identical CASE (Trino), search arm only", () => {
    expect(search).toContain(`GROUP BY ${METRIC_CASE}, lower(trim(url_decode(`);
    expect(search).toContain(`HAVING ${METRIC_CASE} IS NOT NULL AND lower(trim(`);
    expect(sql.split(METRIC_CASE)).toHaveLength(4); // SELECT + GROUP BY + HAVING
  });

  it("no longer filters status / edge error / UA in WHERE, so bot rows reach the CASE", () => {
    const where = search.slice(search.indexOf("  WHERE"), search.indexOf("  GROUP BY"));
    expect(where).toContain("cs_uri_stem = '/search' AND cs_method = 'GET'");
    expect(where).toContain("url_extract_parameter('http://x?' || cs_uri_query, 'q') IS NOT NULL");
    expect(where).not.toContain("sc_status");
    expect(where).not.toContain("x_edge_result_type");
    expect(where).not.toContain("cs_user_agent");
  });
});

describe("isRerollable", () => {
  it("allows a re-roll while the raw logs are still retained", () => {
    expect(isRerollable("2026-09-24", "2026-09-25")).toBe(true);
    expect(isRerollable("2026-09-25", "2026-09-25")).toBe(true);
    // Exactly MAX_REROLL_AGE_DAYS (85) old is still inside the margin.
    expect(isRerollable("2026-07-02", "2026-09-25")).toBe(true);
  });

  it("refuses a day old enough that its raw logs may have expired", () => {
    // 86+ days: a purge-then-insert here could wipe the only durable copy.
    expect(isRerollable("2026-07-01", "2026-09-25")).toBe(false);
    expect(isRerollable("2026-05-22", "2026-09-25")).toBe(false);
  });

  it("keeps the margin below EdgeStack's 90-day raw-log expiry", () => {
    expect(MAX_REROLL_AGE_DAYS).toBeLessThan(90);
  });

  it("validates both dates", () => {
    expect(() => isRerollable("bad", "2026-09-25")).toThrow(/invalid_date/);
    expect(() => isRerollable("2026-09-24", "x")).toThrow(/invalid_date/);
  });
});
