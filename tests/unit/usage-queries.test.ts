import { describe, expect, it } from "vitest";

import {
  SEARCH_STATS_START,
  USAGE_TOP_N,
  assertIsoDate,
  buildUsageQueries,
} from "@/lib/analytics/usage-queries";
import { HERO_SEARCH_SUGGESTIONS } from "@/lib/hero-search-suggestions";

describe("assertIsoDate", () => {
  it("accepts a strict YYYY-MM-DD", () => {
    expect(() => assertIsoDate("2026-07-03")).not.toThrow();
  });
  it("rejects anything else (SQL-injection guard)", () => {
    expect(() => assertIsoDate("2026-7-3")).toThrow(/invalid_date/);
    expect(() => assertIsoDate("2026-07-03'; DROP")).toThrow(/invalid_date/);
    expect(() => assertIsoDate("")).toThrow(/invalid_date/);
  });
});

describe("buildUsageQueries", () => {
  // After SEARCH_STATS_START, so the search queries carry the same window.
  const q = buildUsageQueries("2026-12-03");

  it("windows every query by the given since-date", () => {
    for (const sql of Object.values(q)) {
      expect(sql).toContain("dt >= '2026-12-03'");
    }
  });

  it("targets the right metric per view-model field", () => {
    expect(q.pageviewsByDay).toContain("metric = 'pageviews'");
    expect(q.topProfiles).toContain("metric = 'profile'");
    expect(q.searchTerms).toContain("metric = 'search_term' AND dimension NOT IN (");
    expect(q.suggestedSearchTerms).toContain("metric = 'search_term_suggested' AND");
    expect(q.searchTotals).toContain("metric = 'search_term_suggested' OR (metric = 'search_term' AND dimension NOT IN (");
    // Searches the edge challenged or blocked were never served; not counted.
    for (const sql of Object.values(q)) expect(sql).not.toContain("search_term_bot");
    expect(q.geo).toContain("metric = 'geo'");
    expect(q.device).toContain("metric = 'device'");
    expect(q.hourly).toContain("metric = 'hourly'");
    expect(q.hourly).toContain("SELECT dt, dimension AS slot, SUM(cnt) AS hits");
    expect(q.hourly).toContain("GROUP BY dt, dimension");
  });

  it("caps the ranked metrics at USAGE_TOP_N and leaves grouped ones uncapped", () => {
    expect(q.topProfiles).toContain(`LIMIT ${USAGE_TOP_N}`);
    expect(q.searchTerms).toContain(`LIMIT ${USAGE_TOP_N}`);
    expect(q.suggestedSearchTerms).toContain(`LIMIT ${USAGE_TOP_N}`);
    // Range totals must cover every term, not just the top N.
    expect(q.searchTotals).not.toContain("LIMIT");
    expect(q.geo).not.toContain("LIMIT");
    expect(q.device).not.toContain("LIMIT");
    expect(q.hourly).not.toContain("LIMIT");
  });

  it("emits printable ASCII only (no smart quotes / control chars)", () => {
    for (const sql of Object.values(q)) {
      expect(sql).toMatch(/^[\t\n\x20-\x7E]*$/);
    }
  });

  it("propagates the date guard", () => {
    expect(() => buildUsageQueries("nope")).toThrow(/invalid_date/);
    expect(() => buildUsageQueries("2026-06-03", "2026-06-30'; DROP")).toThrow(/invalid_date/);
  });

  it("bounds every query by an inclusive until-date when given", () => {
    const bounded = buildUsageQueries("2027-01-01", "2027-01-31");
    for (const sql of Object.values(bounded)) {
      expect(sql).toContain("dt >= '2027-01-01' AND dt <= '2027-01-31'");
    }
    // Without one, there is no upper bound.
    for (const sql of Object.values(q)) {
      expect(sql).not.toContain("dt <=");
    }
  });

});

describe("search metrics start at SEARCH_STATS_START", () => {
  const searchSqls = (q: ReturnType<typeof buildUsageQueries>) => [
    q.searchTerms,
    q.suggestedSearchTerms,
    q.searchTotals,
  ];

  it("clamps an earlier window's search queries, not the others", () => {
    const q = buildUsageQueries("2026-10-01", "2026-11-20");
    for (const sql of searchSqls(q)) {
      expect(sql).toContain(`dt >= '${SEARCH_STATS_START}' AND dt <= '2026-11-20'`);
    }
    expect(q.pageviewsByDay).toContain("dt >= '2026-10-01'");
  });

  it("leaves a window that starts later alone", () => {
    const q = buildUsageQueries("2026-12-01");
    for (const sql of searchSqls(q)) expect(sql).toContain("dt >= '2026-12-01'");
  });
});

describe("untagged exact Try-chip terms are not typed searches", () => {
  const q = buildUsageQueries("2026-12-01");

  it("excludes every chip, lower-cased and quote-escaped, from typed and the totals", () => {
    for (const t of HERO_SEARCH_SUGGESTIONS) {
      const lit = `'${t.trim().toLowerCase().replace(/'/g, "''")}'`;
      expect(q.searchTerms).toContain(lit);
      expect(q.searchTotals).toContain(lit);
    }
  });

  it("leaves tagged suggestion clicks alone", () => {
    expect(q.suggestedSearchTerms).not.toContain("NOT IN");
  });
});
