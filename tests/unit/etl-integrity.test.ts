import { describe, expect, it } from "vitest";

import { findVolumeRegressions, staleSources } from "@/etl/integrity";

describe("findVolumeRegressions", () => {
  it("flags a >50% overnight drop on a substantial source", () => {
    const out = findVolumeRegressions([
      { source: "ReCiter", latest: 40_000, previous: 180_000 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("ReCiter");
    expect(out[0].dropPct).toBeGreaterThan(50);
  });

  it("passes growth and moderate shrink", () => {
    expect(
      findVolumeRegressions([
        { source: "ED", latest: 9_100, previous: 8_900 },
        { source: "COI", latest: 5_100, previous: 6_000 },
      ]),
    ).toEqual([]);
  });

  it("exempts sources that were never substantial (Tools in ddb mode, empty COI-Gap)", () => {
    expect(
      findVolumeRegressions([
        { source: "Tools", latest: 0, previous: 0 },
        { source: "COI-Gap", latest: 1, previous: 40 },
      ]),
    ).toEqual([]);
  });

  it("honors custom thresholds", () => {
    const out = findVolumeRegressions(
      [{ source: "Reporter", latest: 700, previous: 1_000 }],
      { maxDropPct: 20 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].dropPct).toBe(30);
  });
});

// #2038 — the nightly and the weekly run the same `etl:integrity`, so a weekly
// source used to be re-graded by every nightly against a pair that cannot move
// until its next weekly run. Prod News: backfill 1595 -> first delta 5, pinned,
// failing the nightly identically every night 08-03 .. 08-09.
describe("findVolumeRegressions — cycle-window scoping (#2038)", () => {
  const NOW = new Date("2026-08-04T04:25:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

  // The real prod pair, verbatim.
  const NEWS = { source: "News", latest: 5, previous: 1_595 } as const;

  it("does not grade a weekly source on a nightly that did not run it", () => {
    expect(
      findVolumeRegressions([{ ...NEWS, latestAt: hoursAgo(48) }], { now: NOW }),
    ).toEqual([]);
  });

  it("STILL grades that same pair in the cycle that produced it", () => {
    // Guards against "fixed" by simply never grading News again.
    const out = findVolumeRegressions([{ ...NEWS, latestAt: hoursAgo(1) }], {
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("News");
    expect(out[0].dropPct).toBeCloseTo(99.7, 1);
  });

  it("grades a sample with unknown age, as before (fail-safe)", () => {
    expect(findVolumeRegressions([NEWS], { now: NOW })).toHaveLength(1);
    expect(
      findVolumeRegressions([{ ...NEWS, latestAt: null }], { now: NOW }),
    ).toHaveLength(1);
  });

  it("names the skipped sources so the gap is never silent", () => {
    const history = [
      { ...NEWS, latestAt: hoursAgo(48) },
      { source: "ED", latest: 9_100, previous: 8_900, latestAt: hoursAgo(1) },
    ];
    expect(staleSources(history, NOW)).toEqual(["News"]);
  });
});
