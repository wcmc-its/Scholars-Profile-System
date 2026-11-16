import { describe, expect, it } from "vitest";

import { USAGE_TOP_N, assertIsoDate, buildUsageQueries } from "@/lib/analytics/usage-queries";
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
  const q = buildUsageQueries("2026-06-03");

  it("windows every query by the given since-date", () => {
    for (const sql of Object.values(q)) {
      expect(sql).toContain("dt >= '2026-06-03'");
    }
  });

  it("targets the right metric per view-model field", () => {
    expect(q.pageviewsByDay).toContain("metric = 'pageviews'");
    expect(q.topProfiles).toContain("metric = 'profile'");
    expect(q.searchTerms).toContain("metric = 'search_term' AND dimension NOT IN (");
    expect(q.suggestedSearchTerms).toContain("metric = 'search_term_suggested' OR");
    expect(q.searchTotals).toContain("metric IN ('search_term', 'search_term_suggested')");
    // Searches the edge challenged or blocked were never served; not counted.
    for (const sql of Object.values(q)) expect(sql).not.toContain("search_term_bot");
    expect(q.referrers).toContain("metric = 'referrer'");
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
    const bounded = buildUsageQueries("2026-07-01", "2026-07-31");
    for (const sql of Object.values(bounded)) {
      expect(sql).toContain("dt >= '2026-07-01' AND dt <= '2026-07-31'");
    }
    // Without one, there is no upper bound.
    for (const sql of Object.values(q)) {
      expect(sql).not.toContain("dt <=");
    }
  });

});

describe("home-chip terms count as likely suggestion clicks", () => {
  const q = buildUsageQueries("2026-06-03");
  const chip = HERO_SEARCH_SUGGESTIONS.find((t) => t.includes("-"))!.toLowerCase();

  it("moves an untagged exact chip term out of typed and into suggested", () => {
    expect(q.searchTerms).toMatch(new RegExp(`NOT IN \\([^)]*'${chip}'`));
    expect(q.suggestedSearchTerms).toMatch(
      new RegExp(`metric = 'search_term' AND dimension IN \\([^)]*'${chip}'`),
    );
    expect(q.searchTotals).toContain("THEN 'suggested' ELSE 'typed' END AS metric");
  });

  it("uses every chip, lower-cased, with quotes escaped", () => {
    for (const t of HERO_SEARCH_SUGGESTIONS) {
      expect(q.searchTerms).toContain(`'${t.trim().toLowerCase().replace(/'/g, "''")}'`);
    }
  });
});
