/** lib/analytics/traffic-queries — SQL shape and the guard on every interpolated value. */
import { describe, expect, it } from "vitest";

import type { ReferrerCategory } from "@/lib/analytics/referrer-category";
import {
  type AiClass,
  buildLandingExportQuery,
  buildPageListQuery,
  buildReferrerListQuery,
  buildTrafficOverviewQueries,
  pageKindOf,
  sqlSearchLiteral,
} from "@/lib/analytics/traffic-queries";

const W = { since: "2026-11-01", until: "2026-11-15" };
const ref = (over: Partial<Parameters<typeof buildReferrerListQuery>[0]> = {}) =>
  buildReferrerListQuery({ ...W, view: "site", categories: [], offset: 0, limit: 25, ...over });
const pages = (over: Partial<Parameters<typeof buildPageListQuery>[0]> = {}) =>
  buildPageListQuery({
    ...W,
    kind: "all",
    categories: [],
    aiClasses: [],
    offset: 0,
    limit: 25,
    ...over,
  });

describe("buildTrafficOverviewQueries", () => {
  const q = buildTrafficOverviewQueries(W.since, W.until);

  it("reads daily_traffic by metric over the inclusive window", () => {
    for (const sql of [q.kpi, q.sourcesDaily, q.referrerTotals, q.aiDaily, q.vendors]) {
      expect(sql).toContain("FROM daily_traffic");
      expect(sql).toContain("dt >= '2026-11-01' AND dt <= '2026-11-15'");
    }
    expect(q.kpi).toContain("metric = 'traffic'");
    expect(q.kpi).toContain("COUNT(DISTINCT dt) AS days");
    expect(q.vendors).toContain("metric = 'ai_agent'");
  });

  it("categorizes sources by the host part and leaves '(other)' out of the categories", () => {
    expect(q.sourcesDaily).toContain("metric = 'referrer_page' AND dimension <> '(other)'");
    expect(q.sourcesDaily).toContain("regexp_like(split_part(dimension, '/', 1)");
    expect(q.referrerTotals).toContain("WHEN dimension = '(other)' THEN cnt");
  });

  it("counts AI referrals from referrer_page and fetch/crawler from ai_agent", () => {
    expect(q.aiDaily).toContain("'referral' AS series");
    expect(q.aiDaily).toContain("= 'AI assistants'");
    expect(q.aiDaily).toContain("split_part(dimension, '|', 1) AS series");
  });

  it("reads the first rollup day over the whole table", () => {
    expect(q.firstDt).toBe(
      "SELECT MIN(dt) AS first_dt FROM daily_traffic WHERE metric = 'traffic'",
    );
  });

  it("rejects a malformed date", () => {
    expect(() => buildTrafficOverviewQueries("2026-11-01' OR '1'='1", W.until)).toThrow(
      /invalid_date/,
    );
    expect(() => buildTrafficOverviewQueries(W.since, "yesterday")).toThrow(/invalid_date/);
  });
});

describe("buildReferrerListQuery", () => {
  it("groups by host for sites and by the full referrer for pages", () => {
    expect(ref()).toContain("SELECT split_part(dimension, '/', 1) AS ref");
    expect(ref({ view: "page" })).toContain("SELECT dimension AS ref");
  });

  it("pages busiest first with a window total", () => {
    const sql = ref({ offset: 50 });
    expect(sql).toContain("COUNT(*) OVER () AS total");
    expect(sql).toContain("ORDER BY visits DESC, ref");
    expect(sql.endsWith("OFFSET 50 LIMIT 25")).toBe(true);
    expect(ref({ limit: null })).not.toContain("LIMIT");
  });

  it("filters by category and searches case-insensitively with strpos", () => {
    const sql = ref({ categories: ["WCM", "Old VIVO"], q: "  Radiology " });
    expect(sql).toContain("category IN ('WCM', 'Old VIVO')");
    expect(sql).toContain("strpos(lower(ref), 'radiology') > 0");
    expect(sql).not.toContain("LIKE");
  });

  it("escapes quotes in search text and ignores LIKE wildcards", () => {
    const sql = ref({ q: "x' OR '1'='1' --" });
    expect(sql).toContain("strpos(lower(ref), 'x'' or ''1''=''1'' --') > 0");
    expect(ref({ q: "50%_off" })).toContain("strpos(lower(ref), '50%_off') > 0");
  });

  it("rejects an unknown category, a bad offset or limit", () => {
    expect(() => ref({ categories: ["WCM') OR (1=1" as ReferrerCategory] })).toThrow(
      /invalid_category/,
    );
    expect(() => ref({ offset: -1 })).toThrow(/invalid_offset/);
    expect(() => ref({ offset: 1.5 })).toThrow(/invalid_offset/);
    expect(() => ref({ limit: 0 })).toThrow(/invalid_limit/);
    expect(() => ref({ limit: 101 })).toThrow(/invalid_limit/);
    expect(() => ref({ since: "2026-1-1" })).toThrow(/invalid_date/);
  });
});

describe("buildPageListQuery", () => {
  it("reads every page view when no source is chosen", () => {
    const sql = pages();
    expect(sql).toContain("metric = 'page' AND dimension <> '(other)'");
    expect(sql).not.toContain("'landing'");
    expect(sql).toContain("WHERE TRUE");
  });

  it("switches to landing pages for chosen categories and AI classes", () => {
    const sql = pages({ categories: ["Search engines"], aiClasses: ["fetch"] });
    expect(sql).toContain("metric = 'landing'");
    expect(sql).toContain("IN ('Search engines')");
    expect(sql).toContain("metric = 'ai_landing'");
    expect(sql).toContain("split_part(dimension, '|', 1) IN ('fetch')");
    expect(sql).toContain("UNION ALL");
    expect(pages({ aiClasses: ["crawler"] })).not.toContain("metric = 'landing'");
    expect(pages({ categories: ["WCM"] })).not.toContain("ai_landing");
  });

  it("filters by page kind", () => {
    expect(pages({ kind: "home" })).toContain("page IN ('/', '/search')");
    expect(pages({ kind: "topics" })).toContain("page LIKE '/topics/%'");
    expect(pages({ kind: "methods" })).toContain("page LIKE '/methods/%'");
    expect(pages({ kind: "profile" })).toContain("regexp_like(page, '^/[^/]+$')");
  });

  it("rejects an unknown AI class", () => {
    expect(() => pages({ aiClasses: ["fetch') OR (1=1" as AiClass] })).toThrow(/invalid_ai_class/);
  });
});

it("buildLandingExportQuery lists landing and AI landing rows with their source", () => {
  const sql = buildLandingExportQuery(W.since, W.until);
  expect(sql).toContain("metric = 'landing'");
  expect(sql).toContain("metric = 'ai_landing'");
  expect(sql).toContain("GROUP BY 1, 2, 3");
  expect(() => buildLandingExportQuery("x", W.until)).toThrow(/invalid_date/);
});

describe("sqlSearchLiteral", () => {
  it("returns null for empty input", () => {
    expect(sqlSearchLiteral("")).toBeNull();
    expect(sqlSearchLiteral("   ")).toBeNull();
    expect(sqlSearchLiteral(null)).toBeNull();
  });

  it("strips control characters, lower-cases, caps length and doubles quotes", () => {
    expect(sqlSearchLiteral("A\u0000B\nC")).toBe("'abc'");
    expect(sqlSearchLiteral("o'brien")).toBe("'o''brien'");
    expect(sqlSearchLiteral("x".repeat(500))).toBe(`'${"x".repeat(100)}'`);
  });
});

it("pageKindOf matches the SQL page kinds", () => {
  expect(pageKindOf("/")).toBe("home");
  expect(pageKindOf("/search")).toBe("home");
  expect(pageKindOf("/topics/cardiology/scholars")).toBe("topics");
  expect(pageKindOf("/methods/imaging")).toBe("methods");
  expect(pageKindOf("/test-person-1")).toBe("profile");
  expect(pageKindOf("/about")).toBeNull();
  expect(pageKindOf("/departments/medicine")).toBeNull();
});
