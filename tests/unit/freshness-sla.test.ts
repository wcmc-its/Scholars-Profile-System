import { describe, expect, it } from "vitest";

import { SLA_HOURS, TRACKED } from "@/etl/freshness/index";

describe("freshness SLAs", () => {
  // Spotlight's producer lives in ReciterAI, not this repo, and publishes
  // MONTHLY (reciterai-spotlight-monthly, cron(0 13 1 * ? *)). Under the 8-day
  // weekly SLA it used to carry, the source was stale by construction and the
  // scholars-heartbeat-<env> machine failed every day in BOTH envs. If someone
  // tidies Spotlight back into the weekly block, that daily failure returns —
  // so pin the cadence, not just the number.
  it("tracks Spotlight on the monthly cadence, not weekly", () => {
    expect(TRACKED.Spotlight?.cadence).toBe("monthly");
  });

  // 40d = 31d (longest month) + 7d (our weekly loader's worst-case pickup lag)
  // + 2d grace. Both terms are required: freshness anchors on the PRODUCER's
  // manifestGeneratedAt, but we only re-read it when the weekly ETL runs, so a
  // perfectly healthy monthly producer still reads 38 days old just before our
  // loader next fires. An SLA <= 38 false-alarms every long month.
  //
  // Asserted as the derivation rather than a bare literal, so the next person to
  // adjust it has to move a term they can name. A first cut at 35 forgot the
  // load-lag term entirely and would have alarmed on a healthy producer.
  const LONGEST_MONTH_DAYS = 31;
  const WEEKLY_LOADER_LAG_DAYS = 7;

  it("covers a 31-day month PLUS the weekly loader's pickup lag", () => {
    const worstHealthyAgeDays = LONGEST_MONTH_DAYS + WEEKLY_LOADER_LAG_DAYS;
    expect(SLA_HOURS.monthly).toBeGreaterThan(worstHealthyAgeDays * 24);
    expect(SLA_HOURS.monthly).toBe(40 * 24);
  });

  // The weekly SLA has the same shape of dependency and must stay above a 7-day
  // producer interval; if someone ever tightens it below that, weekly sources
  // start alarming on healthy runs.
  it("keeps the weekly SLA above its own 7-day interval", () => {
    expect(SLA_HOURS.weekly).toBeGreaterThan(7 * 24);
  });

  // Guards the ordering invariant the table depends on: a longer cadence must
  // tolerate a longer silence, or a source would alarm faster than it can run.
  it("keeps SLAs monotonic across cadences", () => {
    expect(SLA_HOURS.nightly).toBeLessThan(SLA_HOURS.weekly);
    expect(SLA_HOURS.weekly).toBeLessThan(SLA_HOURS.monthly);
    expect(SLA_HOURS.monthly).toBeLessThan(SLA_HOURS.annual);
  });

  // Every tracked source must resolve to a cadence that exists in SLA_HOURS —
  // otherwise slaHours is undefined and `ageHours > undefined` is false, so the
  // source silently reads FRESH forever. That is the exact class of bug the
  // manifest-anchoring fix already had to undo once.
  it("resolves every tracked source to a real SLA", () => {
    for (const [source, spec] of Object.entries(TRACKED)) {
      expect(
        SLA_HOURS[spec.cadence],
        `${source} has cadence "${spec.cadence}" with no SLA`,
      ).toBeGreaterThan(0);
    }
  });
});
