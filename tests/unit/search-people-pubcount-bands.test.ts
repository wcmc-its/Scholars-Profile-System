/**
 * Issue #2068 — properties of the capped volume-prior step ladder.
 *
 * The contract (`docs/search-relevance-contract.md`, rule O3) requires every
 * query-independent prior to STATE A CEILING. This file machine-checks that claim
 * against the real `PEOPLE_PROMINENCE_PUBCOUNT_BANDS` table rather than trusting a
 * comment: the ladder is mutually exclusive (so its contribution to the outer
 * `score_mode: sum` is exactly ONE band weight), monotone non-decreasing in the
 * publication count, ceilinged at the declared
 * `PEOPLE_PROMINENCE_PUBCOUNT_CEILING`, and contributes NOTHING at P = 0 (the
 * `missing: 0` / `ln1p(0) = 0` semantics of the `field_value_factor` it replaces).
 *
 * Deliberately imports the REAL module (no `vi.mock("@/lib/search")`) — a mocked
 * copy of the table would assert against the copy, not the shipped ladder.
 */
import { describe, expect, it } from "vitest";

import {
  PEOPLE_PROMINENCE_PUBCOUNT_BANDS as BANDS,
  PEOPLE_PROMINENCE_PUBCOUNT_CEILING as CEILING,
} from "@/lib/search";

/** Every band a given publication count falls into (should always be 0 or 1). */
function matchingBands(p: number) {
  return BANDS.filter((b) => p >= b.gte && (b.lt === undefined || p < b.lt));
}

/** The ladder's total contribution to the `score_mode: sum` at `p`. */
function weightAt(p: number): number {
  return matchingBands(p).reduce((acc, b) => acc + b.weight, 0);
}

/** Boundaries ±1 plus a wide sweep — the places an off-by-one band edge hides. */
const PROBE_COUNTS = [
  ...new Set([
    0,
    ...BANDS.flatMap((b) => [b.gte - 1, b.gte, b.gte + 1]),
    ...BANDS.flatMap((b) => (b.lt === undefined ? [] : [b.lt - 1, b.lt, b.lt + 1])),
    ...Array.from({ length: 301 }, (_, i) => i),
    500,
    580,
    923,
    5000,
    1_000_000,
  ]),
]
  .filter((n) => n >= 0)
  .sort((a, b) => a - b);

describe("#2068 volume-prior ladder — the declared table", () => {
  it("is exactly the #2068 ladder (the reviewed weights, in descending order)", () => {
    expect(BANDS).toEqual([
      { gte: 200, weight: 3.0 },
      { gte: 100, lt: 200, weight: 2.75 },
      { gte: 50, lt: 100, weight: 2.5 },
      { gte: 20, lt: 50, weight: 2.0 },
      { gte: 5, lt: 20, weight: 1.25 },
      { gte: 1, lt: 5, weight: 0.5 },
    ]);
  });
});

describe("#2068 volume-prior ladder — mutual exclusivity", () => {
  it("matches EXACTLY ONE band for every P >= 1", () => {
    const violations = PROBE_COUNTS.filter((p) => p >= 1 && matchingBands(p).length !== 1).map(
      (p) => ({ p, bands: matchingBands(p).length }),
    );
    expect(violations).toEqual([]);
  });

  it("so the contribution to the sum is that band's weight, never a sum of two", () => {
    for (const band of BANDS) {
      expect(weightAt(band.gte)).toBe(band.weight);
      if (band.lt !== undefined) expect(weightAt(band.lt - 1)).toBe(band.weight);
    }
  });
});

describe("#2068 volume-prior ladder — monotone non-decreasing", () => {
  it("never loses weight as the publication count rises", () => {
    const regressions: { from: number; to: number; w0: number; w1: number }[] = [];
    for (let i = 1; i < PROBE_COUNTS.length; i++) {
      const prev = PROBE_COUNTS[i - 1];
      const cur = PROBE_COUNTS[i];
      const w0 = weightAt(prev);
      const w1 = weightAt(cur);
      if (w1 < w0) regressions.push({ from: prev, to: cur, w0, w1 });
    }
    expect(regressions).toEqual([]);
  });

  it("the table itself is ordered by a strictly decreasing weight (no ties, no inversions)", () => {
    for (let i = 1; i < BANDS.length; i++) {
      expect(BANDS[i].weight).toBeLessThan(BANDS[i - 1].weight);
      expect(BANDS[i].gte).toBeLessThan(BANDS[i - 1].gte);
    }
  });
});

describe("#2068 volume-prior ladder — the stated ceiling (contract O3)", () => {
  it("declares a ceiling of 3.0", () => {
    expect(CEILING).toBe(3.0);
  });

  it("the maximum band weight IS the declared ceiling (one source of truth)", () => {
    expect(Math.max(...BANDS.map((b) => b.weight))).toBe(CEILING);
  });

  it("no publication count, however large, can exceed the ceiling", () => {
    for (const p of PROBE_COUNTS) expect(weightAt(p)).toBeLessThanOrEqual(CEILING);
    expect(weightAt(1_000_000)).toBe(CEILING);
    // The unbounded factor this replaces: ln1p(1e6) ~= 13.8, i.e. 4.6x the ceiling.
    expect(Math.log1p(1_000_000)).toBeGreaterThan(CEILING);
  });

  it("the top band is open-ended, so the ceiling is reached and never exceeded", () => {
    const top = BANDS.find((b) => b.weight === CEILING)!;
    expect(top.lt).toBeUndefined();
  });
});

describe("#2068 volume-prior ladder — P = 0 contributes nothing", () => {
  it("matches no band at all at P = 0 (preserves `missing: 0` / ln1p(0) = 0)", () => {
    expect(matchingBands(0)).toEqual([]);
    expect(weightAt(0)).toBe(0);
  });

  it("has no band reaching below 1 publication (no `lt: 1` band)", () => {
    expect(BANDS.every((b) => b.gte >= 1)).toBe(true);
  });
});
