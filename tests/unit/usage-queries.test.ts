import { describe, expect, it } from "vitest";

import { USAGE_TOP_N, assertIsoDate, buildUsageQueries } from "@/lib/analytics/usage-queries";

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
    expect(q.searchTerms).toContain("metric = 'search_term'");
    expect(q.referrers).toContain("metric = 'referrer'");
    expect(q.geo).toContain("metric = 'geo'");
    expect(q.device).toContain("metric = 'device'");
  });

  it("caps the ranked metrics at USAGE_TOP_N and leaves grouped ones uncapped", () => {
    expect(q.topProfiles).toContain(`LIMIT ${USAGE_TOP_N}`);
    expect(q.searchTerms).toContain(`LIMIT ${USAGE_TOP_N}`);
    expect(q.geo).not.toContain("LIMIT");
    expect(q.device).not.toContain("LIMIT");
  });

  it("emits printable ASCII only (no smart quotes / control chars)", () => {
    for (const sql of Object.values(q)) {
      expect(sql).toMatch(/^[\t\n\x20-\x7E]*$/);
    }
  });

  it("propagates the date guard", () => {
    expect(() => buildUsageQueries("nope")).toThrow(/invalid_date/);
  });
});
