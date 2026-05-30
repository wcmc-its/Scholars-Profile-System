// Unit tests for the SDK-free rollup SQL builder (queries.ts). Runs under the
// repo's root jest config (testMatch test/**/*.test.ts). It imports ONLY
// queries.ts -- which imports nothing from @aws-sdk -- so it passes before the
// Integration step adds the @aws-sdk workspace + lockfile hoist that index.ts
// needs. The import is extensionless on purpose: ts-jest's CommonJS resolver
// does not remap a NodeNext `.js` specifier back to the `.ts` source, but it
// resolves the extensionless path directly to queries.ts.
import { assertIsoDate, buildRollupInsert } from "../lambda/cf-usage-rollup/queries";

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
    for (const metric of [
      "'pageviews'",
      "'profile'",
      "'search_term'",
      "'referrer'",
      "'geo'",
      "'device'",
    ]) {
      expect(sql).toContain(`${metric} AS metric`);
    }
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
    expect(sql).toContain("GROUP BY lower(trim(url_decode");
    // referrer/geo/device CASE group-bys: the CASE keyword follows GROUP BY
    // on the same line (`GROUP BY CASE\n  WHEN ...`).
    expect(sql).toMatch(/GROUP BY CASE\n/);
  });

  it("never selects a raw client-IP column (PII guard)", () => {
    expect(sql).not.toContain("c_ip");
    expect(sql).not.toContain("x_forwarded_for");
  });
});
