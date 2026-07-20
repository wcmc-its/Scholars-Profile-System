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

  // 35d = a 31-day month + ~4d grace. Anything <= 31 days false-alarms every
  // long month; the point of the widening is lost if this creeps back down.
  it("gives the monthly cadence enough room for a 31-day month", () => {
    expect(SLA_HOURS.monthly).toBe(35 * 24);
    expect(SLA_HOURS.monthly).toBeGreaterThan(31 * 24);
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
