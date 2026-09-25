/**
 * `scripts/backfills/2026-09-25-usage-rollup-history.ts` — the pure planners.
 * The AWS calls (Lambda config, S3 listing, Lambda invoke) are not exercised.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_REROLL_AGE_DAYS,
  parseArgs,
  partitionDates,
  planBackfillDates,
} from "@/scripts/backfills/2026-09-25-usage-rollup-history";

describe("partitionDates", () => {
  it("extracts dt= dates from S3 common prefixes and ignores anything else", () => {
    expect(
      partitionDates([
        "rollup/daily-usage/dt=2026-09-01/",
        "rollup/daily-usage/dt=2026-09-02/",
        "rollup/daily-usage/_tmp/",
        "rollup/daily-usage/dt=bad/",
      ]),
    ).toEqual(new Set(["2026-09-01", "2026-09-02"]));
  });
});

describe("planBackfillDates", () => {
  const today = "2026-09-25";

  it("plans only missing days, oldest first, from the retention floor to yesterday", () => {
    const existing = new Set<string>();
    // Everything from the floor through yesterday exists except two days.
    for (let i = 1; i <= MAX_REROLL_AGE_DAYS; i++) {
      const d = new Date(Date.parse(`${today}T00:00:00Z`) - i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (d !== "2026-09-10" && d !== "2026-07-15") existing.add(d);
    }
    expect(planBackfillDates({ existing, today })).toEqual(["2026-07-15", "2026-09-10"]);
  });

  it("never reaches past the raw-log retention floor, even when --from is older", () => {
    const plan = planBackfillDates({ existing: new Set(), today, from: "2026-05-22" });
    expect(plan[0]).toBe("2026-07-02"); // today - 85
    expect(plan[plan.length - 1]).toBe("2026-09-24"); // yesterday, never today
    expect(plan).toHaveLength(MAX_REROLL_AGE_DAYS);
  });

  it("honours a later --from and --limit", () => {
    expect(
      planBackfillDates({ existing: new Set(["2026-09-21"]), today, from: "2026-09-20", limit: 2 }),
    ).toEqual(["2026-09-20", "2026-09-22"]);
  });

  it("plans nothing when every day already has a partition", () => {
    const all = new Set(planBackfillDates({ existing: new Set(), today }));
    expect(planBackfillDates({ existing: all, today })).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("requires --env and parses the optional flags", () => {
    expect(() => parseArgs([])).toThrow(/--env/);
    expect(() => parseArgs(["--env=dev"])).toThrow(/--env/);
    expect(parseArgs(["--env=staging", "--dry-run", "--from=2026-08-01", "--limit=3"])).toEqual({
      env: "staging",
      dryRun: true,
      from: "2026-08-01",
      limit: 3,
    });
    expect(() => parseArgs(["--env=prod", "--from=08/01/2026"])).toThrow(/--from/);
    expect(() => parseArgs(["--env=prod", "--limit=0"])).toThrow(/--limit/);
  });

  // Read as text, not imported: `cdk/` is in .dockerignore, and the app
  // image's `next build` typechecks tests/, so a TS import from cdk/ breaks it.
  it("stays in step with the rollup Lambda's re-roll guard", () => {
    const src = readFileSync(
      path.join(process.cwd(), "cdk/lambda/cf-usage-rollup/queries.ts"),
      "utf8",
    );
    const m = src.match(/export const MAX_REROLL_AGE_DAYS = (\d+);/);
    expect(m).not.toBeNull();
    expect(MAX_REROLL_AGE_DAYS).toBe(Number(m![1]));
  });
});
