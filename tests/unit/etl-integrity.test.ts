import { describe, expect, it } from "vitest";

import { findVolumeRegressions } from "@/etl/integrity";

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
