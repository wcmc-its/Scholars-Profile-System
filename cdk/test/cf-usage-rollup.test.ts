// Unit tests for the SDK-free rollup SQL builder (queries.ts). Runs under the
// repo's root jest config (testMatch test/**/*.test.ts). It imports ONLY
// queries.ts -- which imports nothing from @aws-sdk -- so it passes before the
// Integration step adds the @aws-sdk workspace + lockfile hoist that index.ts
// needs. The import is extensionless on purpose: ts-jest's CommonJS resolver
// does not remap a NodeNext `.js` specifier back to the `.ts` source, but it
// resolves the extensionless path directly to queries.ts.
import {
  AI_AGENTS,
  assertIsoDate,
  buildRollupInsert,
  buildTrafficInsert,
  isRerollable,
  OTHER_DIMENSION,
  planRollup,
  resolveTables,
  ROLLUP_TABLES,
  TOP_N,
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
  // The six pageview/search/traffic-shape arms, without the hourly arm (which
  // has its own status classes and tests below).
  const marketing = sql.split("UNION ALL").slice(0, 6).join("UNION ALL");

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

  it("emits all seven metric arms", () => {
    for (const metric of ["'pageviews'", "'profile'", "'referrer'", "'geo'", "'device'", "'hourly'"]) {
      expect(sql).toContain(`${metric} AS metric`);
    }
    // search_term / search_term_suggested / search_term_bot come from one
    // arm's metric CASE.
    expect(sql).toContain("THEN 'search_term'\nEND AS metric");
    // Six UNION ALL joins between seven arms.
    expect(sql.match(/UNION ALL/g)).toHaveLength(6);
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
    const guards = marketing.match(/x_edge_result_type <> 'FunctionGeneratedResponse'/g) ?? [];
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
    const twoxx = marketing.match(/sc_status BETWEEN 200 AND 299/g) ?? [];
    const upTo3xx = marketing.match(/sc_status BETWEEN 200 AND 399/g) ?? [];
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

describe("buildRollupInsert hourly human / bot / error arm", () => {
  const sql = buildRollupInsert(CFG, "2026-11-15");
  const hourly = sql.split("UNION ALL")[6];
  // The dimension expression, exactly as SELECT emits it (GROUP BY and HAVING repeat it).
  const dimStart = hourly.indexOf("SELECT 'hourly' AS metric, ") + "SELECT 'hourly' AS metric, ".length;
  const DIM = hourly.slice(dimStart, hourly.indexOf(" AS dimension,"));
  const branches = DIM.split("\n  WHEN ").slice(1);

  it("is the last arm and emits (metric, dimension, cnt, dt)", () => {
    expect(hourly).toContain("SELECT 'hourly' AS metric, ");
    expect(hourly).toContain("COUNT(*) AS cnt, '2026-11-15' AS dt");
    expect(hourly.trimEnd().endsWith(")")).toBe(true);
  });

  it("keys the dimension on the two-digit UTC hour from the quoted time column", () => {
    expect(DIM.startsWith(`substr("time", 1, 2) || '|' || CASE\n`)).toBe(true);
    expect(DIM.endsWith("\nEND")).toBe(true);
  });

  it("classifies error first, then bot, then human, with no ELSE", () => {
    expect(branches).toHaveLength(3);
    // 1. error: any 5xx, so an outage shows whoever was asking.
    expect(branches[0]).toBe("sc_status >= 500 THEN 'error'");
    // 2. bot: declared UA (NULL-safe), a WAF answer, or another edge Error 4xx.
    expect(branches[1]).toContain("coalesce((regexp_like(url_decode(cs_user_agent), '(?i)(bot|crawl|spider|");
    expect(branches[1]).toContain(`'${KNOWN_SCRAPER_UAS[0]}'`);
    expect(branches[1]).toContain(`OR sc_status IN (${BOT_SEARCH_STATUSES.join(", ")})`);
    expect(branches[1]).toContain(
      "OR (x_edge_result_type = 'Error' AND sc_status BETWEEN 400 AND 499) THEN 'bot'",
    );
    // 3. human: a served 2xx/3xx that no CloudFront Function synthesized.
    expect(branches[2]).toContain("sc_status BETWEEN 200 AND 399");
    expect(branches[2]).toContain("x_edge_result_type <> 'FunctionGeneratedResponse' THEN 'human'");
    expect(DIM).not.toContain("ELSE");
  });

  it("never classes a WAF answer as an error (none of them is a 5xx)", () => {
    for (const status of BOT_SEARCH_STATUSES) expect(status).toBeLessThan(500);
  });

  it("groups and filters on the character-identical dimension (Trino)", () => {
    expect(hourly).toContain(`GROUP BY ${DIM}\n`);
    expect(hourly).toContain(`HAVING ${DIM} IS NOT NULL`);
    expect(sql.split(DIM)).toHaveLength(4); // SELECT + GROUP BY + HAVING
  });

  it("counts page GETs of any status (not the success-only filters)", () => {
    const where = hourly.slice(hourly.indexOf("  WHERE"), hourly.indexOf("  GROUP BY"));
    expect(where).toContain(`"date" = DATE '2026-11-15' AND cs_method = 'GET'`);
    expect(where).toContain("NOT starts_with(cs_uri_stem, '/_next/')");
    expect(where).toContain("NOT starts_with(cs_uri_stem, '/api/')");
    expect(where).toContain("NOT regexp_like(cs_uri_stem, '[.][^/]*$')");
    expect(where).not.toContain("sc_status");
    expect(where).not.toContain("x_edge_result_type");
  });

  it("never selects a raw client-IP column (PII guard)", () => {
    expect(hourly).not.toContain("c_ip");
    expect(hourly).not.toContain("x_forwarded_for");
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

describe("buildRollupInsert referrer self-test uses the public host", () => {
  const referrer = buildRollupInsert(CFG, "2026-11-16").split("UNION ALL")[3];

  it("compares the referrer host to x_host_header, not the cloudfront.net cs_host", () => {
    expect(referrer).toContain(
      "WHEN lower(url_extract_host(cs_referrer)) = lower(x_host_header) THEN '(internal)'",
    );
    expect(referrer).not.toContain("cs_host");
  });
});

describe("buildTrafficInsert (daily_traffic)", () => {
  const TCFG = {
    database: "sps_usage_staging",
    rawTable: "cf_access_logs",
    trafficTable: "daily_traffic",
  };
  const sql = buildTrafficInsert(TCFG, "2026-11-16");
  const arms = sql.split("\n  UNION ALL\n");
  const [traffic, referrerPage, landing, page, aiAgent, aiLanding] = arms;
  const NOT_BOT = "NOT coalesce((regexp_like(url_decode(cs_user_agent), '(?i)(bot|crawl|spider|";
  const EXTERNAL = [
    "lower(url_extract_host(cs_referrer)) <> ''",
    "    AND lower(url_extract_host(cs_referrer)) <> lower(coalesce(x_host_header, ''))",
    "    AND lower(url_extract_host(cs_referrer)) NOT LIKE '%.cloudfront.net'",
  ].join("\n");
  const PATH = "coalesce(try(url_decode(cs_uri_stem)), cs_uri_stem)";
  const FOLD = `CASE WHEN rn <= ${TOP_N} THEN regexp_replace(dimension, '[\\t\\r\\n]', ' ') ELSE '${OTHER_DIMENSION}' END`;

  it("validates the date before building SQL", () => {
    expect(() => buildTrafficInsert(TCFG, "2026-11-16'; DROP")).toThrow(/invalid_date/);
  });

  it("inserts into daily_traffic from the raw table, dt last, six arms", () => {
    expect(sql.startsWith(`INSERT INTO "sps_usage_staging"."daily_traffic"\n`)).toBe(true);
    expect(sql).toContain("SELECT metric, dimension, cnt, dt FROM (");
    expect(sql).not.toContain("daily_usage");
    expect(arms).toHaveLength(6);
    for (const arm of arms) {
      expect(arm).toContain(`FROM "sps_usage_staging"."cf_access_logs"`);
      expect(arm).toContain(`"date" = DATE '2026-11-16'`);
      expect(arm).toContain("'2026-11-16' AS dt");
    }
    const metrics = ["traffic", "referrer_page", "landing", "page", "ai_agent", "ai_landing"];
    arms.forEach((arm, i) => {
      const first = i === 0 ? arm.split("\n")[2] : arm.split("\n")[0];
      expect(first.trimStart().startsWith(`SELECT '${metrics[i]}' AS metric,`)).toBe(true);
    });
    expect(sql.trimEnd().endsWith("\n)")).toBe(true);
  });

  describe("traffic totals", () => {
    it("unpivots hits / pageviews / visitors from one scan over every request", () => {
      expect(traffic).toContain("SELECT COUNT(*) AS hits,");
      expect(traffic).toContain("ARRAY['hits', 'pageviews', 'visitors'],");
      expect(traffic).toContain("ARRAY[totals.hits, totals.pageviews, totals.visitors]");
      expect(traffic).toContain(") AS t (dimension, cnt)");
      // hits = every request: the scan's only WHERE is the day.
      expect(traffic).toContain(`    WHERE "date" = DATE '2026-11-16'\n  ) totals\n  CROSS JOIN UNNEST(`);
    });

    it("counts pageviews over human 200 GET page paths, _rsc= included", () => {
      const pv = traffic.slice(traffic.indexOf("count_if("), traffic.indexOf(") AS pageviews"));
      expect(pv).toContain("cs_method = 'GET' AND sc_status = 200");
      expect(pv).toContain("x_edge_result_type <> 'Error'");
      expect(pv).toContain("x_edge_result_type <> 'FunctionGeneratedResponse'");
      expect(pv).toContain("NOT starts_with(cs_uri_stem, '/_next/')");
      expect(pv).toContain("NOT starts_with(cs_uri_stem, '/api/')");
      expect(pv).toContain("NOT regexp_like(cs_uri_stem, '[.][^/]*$')");
      expect(pv).toContain(NOT_BOT);
      expect(pv).toContain(`'${KNOWN_SCRAPER_UAS[0]}'`);
      // The query string is never inspected, so ?_rsc= navigations count.
      expect(sql).not.toContain("_rsc");
      expect(sql).not.toContain("cs_uri_query");
    });

    it("estimates visitors as approx_distinct(ip|UA) over the same human rows, never storing the key", () => {
      expect(traffic).toMatch(
        /approx_distinct\(CASE WHEN cs_method = 'GET' AND sc_status = 200[\s\S]*THEN c_ip \|\| '\|' \|\| cs_user_agent END\) AS visitors/,
      );
      // c_ip appears only inside approx_distinct; x_forwarded_for never.
      expect(sql.match(/c_ip/g)).toHaveLength(1);
      expect(sql).not.toContain("x_forwarded_for");
    });
  });

  describe("top-N collapse", () => {
    it("keeps the top 5000 per metric and folds the rest into one (other) row", () => {
      expect(TOP_N).toBe(5000);
      expect(OTHER_DIMENSION).toBe("(other)");
      for (const arm of [referrerPage, landing, page, aiLanding]) {
        expect(arm).toContain(`AS metric, ${FOLD} AS dimension,`);
        expect(arm).toContain("    SUM(cnt) AS cnt, '2026-11-16' AS dt");
        expect(arm).toContain("      row_number() OVER (ORDER BY cnt DESC, dimension) AS rn");
        expect(arm).toContain(`  GROUP BY ${FOLD}`);
      }
      // TSV safety: a decoded %09 / %0A in a kept dimension cannot split the row.
      expect(FOLD).toContain("regexp_replace(dimension, '[\\t\\r\\n]', ' ')");
      // traffic and ai_agent are small fixed sets: no fold.
      for (const arm of [traffic, aiAgent]) expect(arm).not.toContain("row_number()");
    });

    it("drops NULL / empty dimensions before ranking (grouped expression repeated verbatim)", () => {
      expect(page).toContain(
        `      GROUP BY ${PATH}\n      HAVING ${PATH} IS NOT NULL AND ${PATH} <> ''`,
      );
    });
  });

  describe("referrer_page", () => {
    it("is host + path with query string and fragment dropped, empty path as /", () => {
      expect(referrerPage).toContain(
        "SELECT lower(url_extract_host(cs_referrer)) || coalesce(nullif(url_extract_path(cs_referrer), ''), '/') AS dimension",
      );
      expect(referrerPage).not.toMatch(/SELECT cs_referrer AS dimension/);
      expect(referrerPage).not.toContain("url_extract_query");
      expect(referrerPage).not.toContain("url_extract_fragment");
    });

    it("excludes self (x_host_header), *.cloudfront.net, and missing/unparseable referrers", () => {
      expect(referrerPage).toContain(EXTERNAL);
      expect(referrerPage).not.toContain("cs_host");
      expect(referrerPage).toContain(NOT_BOT);
      expect(referrerPage).toContain("sc_status = 200");
    });
  });

  describe("landing", () => {
    it("is '<referrer host>|<decoded path>' for external human pageviews", () => {
      expect(landing).toContain(
        `SELECT lower(url_extract_host(cs_referrer)) || '|' || ${PATH} AS dimension`,
      );
      expect(landing).toContain(EXTERNAL);
      expect(landing).toContain(NOT_BOT);
    });
  });

  describe("page", () => {
    it("is the decoded path of human pageviews, with no referrer filter", () => {
      expect(page).toContain(`SELECT ${PATH} AS dimension, COUNT(*) AS cnt`);
      expect(page).toContain(NOT_BOT);
      expect(page).not.toContain("cs_referrer");
    });
  });

  describe("AI agents", () => {
    it("declares the fetch and crawler agents with their vendors", () => {
      const fetch = AI_AGENTS.filter((a) => a.agentClass === "fetch").map((a) => a.token);
      const crawler = AI_AGENTS.filter((a) => a.agentClass === "crawler").map((a) => a.token);
      expect(fetch).toEqual(["ChatGPT-User", "Claude-User", "Perplexity-User", "MistralAI-User"]);
      expect(crawler).toEqual([
        "GPTBot",
        "OAI-SearchBot",
        "ClaudeBot",
        "Claude-SearchBot",
        "PerplexityBot",
        "CCBot",
        "Google-Extended",
        "Bytespider",
        "Amazonbot",
        "meta-externalagent",
        "Applebot-Extended",
        "DuckAssistBot",
      ]);
      expect([...new Set(AI_AGENTS.map((a) => a.vendor))].sort()).toEqual(
        [
          "Amazon",
          "Anthropic",
          "Apple",
          "ByteDance",
          "Common Crawl",
          "DuckDuckGo",
          "Google",
          "Meta",
          "Mistral",
          "OpenAI",
          "Perplexity",
        ].sort(),
      );
      // No token is a substring of another, so CASE order cannot misattribute.
      for (const a of AI_AGENTS) {
        for (const b of AI_AGENTS) {
          if (a !== b) expect(b.token.toLowerCase()).not.toContain(a.token.toLowerCase());
        }
      }
    });

    it("ai_agent buckets ALL requests as '<class>|<vendor>'", () => {
      expect(aiAgent).toContain(
        "WHEN regexp_like(cs_user_agent, '(?i)(ChatGPT-User)') THEN 'fetch|OpenAI'",
      );
      expect(aiAgent).toContain(
        "WHEN regexp_like(cs_user_agent, '(?i)(CCBot)') THEN 'crawler|Common Crawl'",
      );
      expect(aiAgent).toContain(
        "WHEN regexp_like(cs_user_agent, '(?i)(meta-externalagent)') THEN 'crawler|Meta'",
      );
      const where = aiAgent.slice(aiAgent.indexOf("  WHERE"), aiAgent.indexOf("  GROUP BY"));
      expect(where.trim()).toBe(`WHERE "date" = DATE '2026-11-16'`);
      expect(aiAgent).toMatch(/HAVING CASE\n[\s\S]*\nEND IS NOT NULL$/);
    });

    it("ai_landing is '<class>|<path>' for 200 GET page fetches, bots NOT excluded", () => {
      expect(aiLanding).toContain(
        "WHEN regexp_like(cs_user_agent, '(?i)(ChatGPT-User|Claude-User|Perplexity-User|MistralAI-User)') THEN 'fetch'",
      );
      expect(aiLanding).toContain(`THEN 'crawler'\nEND || '|' || ${PATH} AS dimension`);
      expect(aiLanding).toContain("cs_method = 'GET' AND sc_status = 200");
      expect(aiLanding).toContain("NOT starts_with(cs_uri_stem, '/_next/')");
      expect(aiLanding).not.toContain("NOT coalesce(");
    });
  });
});

describe("resolveTables", () => {
  it("defaults to both tables", () => {
    expect(resolveTables(undefined)).toEqual(["usage", "traffic"]);
    expect([...ROLLUP_TABLES]).toEqual(["usage", "traffic"]);
  });

  it("accepts a subset, deduplicated, in canonical order", () => {
    expect(resolveTables(["traffic"])).toEqual(["traffic"]);
    expect(resolveTables(["usage"])).toEqual(["usage"]);
    expect(resolveTables(["traffic", "usage", "traffic"])).toEqual(["usage", "traffic"]);
  });

  it("rejects anything else", () => {
    for (const bad of [[], ["daily_usage"], ["traffic", "x"], "traffic", [1], null, {}]) {
      expect(() => resolveTables(bad)).toThrow(/invalid_tables/);
    }
  });
});

describe("planRollup", () => {
  const today = "2026-11-16";

  it("tables:['traffic'] rolls only daily_traffic for each date", () => {
    const { steps, skipped } = planRollup(
      ["2026-11-14", "2026-11-15"],
      resolveTables(["traffic"]),
      today,
    );
    expect(steps).toEqual([
      { dt: "2026-11-14", table: "traffic" },
      { dt: "2026-11-15", table: "traffic" },
    ]);
    expect(skipped).toEqual([]);
  });

  it("rolls both tables per date by default, usage first", () => {
    expect(planRollup(["2026-11-15"], resolveTables(undefined), today).steps).toEqual([
      { dt: "2026-11-15", table: "usage" },
      { dt: "2026-11-15", table: "traffic" },
    ]);
  });

  it("skips (never purges) days past the raw-log retention margin, for every table", () => {
    // 2026-08-23 is exactly MAX_REROLL_AGE_DAYS (85) before 2026-11-16.
    const { steps, skipped } = planRollup(
      ["2026-08-18", "2026-08-22", "2026-08-23"],
      ["traffic"],
      today,
    );
    expect(skipped).toEqual(["2026-08-18", "2026-08-22"]);
    expect(steps).toEqual([{ dt: "2026-08-23", table: "traffic" }]);
  });
});
