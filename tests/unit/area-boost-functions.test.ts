/**
 * Research-Area concentration boost — the pure tier-bucketing helper
 * (spec: docs/search-research-area-relevance-spec.md §3.2). Verifies the
 * relevance×coverage `total` is bucketed into hi/mid/lo weighted function_score
 * clauses keyed on cwid, and that the boundary/empty cases hold.
 */
import { describe, expect, it } from "vitest";
import { buildAreaBoostFunctions } from "@/lib/api/search";
import {
  AREA_BOOST_W_HI,
  AREA_BOOST_W_MID,
  AREA_BOOST_W_LO,
} from "@/lib/search";

describe("buildAreaBoostFunctions", () => {
  it("returns [] for empty input", () => {
    expect(buildAreaBoostFunctions([])).toEqual([]);
  });

  it("returns [] when the top total is not positive", () => {
    expect(buildAreaBoostFunctions([{ cwid: "a", total: 0 }])).toEqual([]);
  });

  it("buckets by fraction of the top total into hi/mid/lo weighted clauses", () => {
    // max = 100 → hi ≥ 50 (frac ≥ 0.5), mid ≥ 20 (≥ 0.2), lo > 0
    const fns = buildAreaBoostFunctions([
      { cwid: "hi1", total: 100 },
      { cwid: "hi2", total: 60 },
      { cwid: "mid1", total: 30 },
      { cwid: "lo1", total: 5 },
    ]);
    expect(fns).toEqual([
      { filter: { terms: { cwid: ["hi1", "hi2"] } }, weight: AREA_BOOST_W_HI },
      { filter: { terms: { cwid: ["mid1"] } }, weight: AREA_BOOST_W_MID },
      { filter: { terms: { cwid: ["lo1"] } }, weight: AREA_BOOST_W_LO },
    ]);
  });

  it("skips non-positive totals and omits empty tiers", () => {
    const fns = buildAreaBoostFunctions([
      { cwid: "hi1", total: 100 },
      { cwid: "z", total: 0 },
    ]);
    expect(fns).toEqual([
      { filter: { terms: { cwid: ["hi1"] } }, weight: AREA_BOOST_W_HI },
    ]);
  });

  it("a single tangential scholar (tiny total) is starved — lands in lo, never hi", () => {
    // The '1-of-286' case: top scholar dominates, the tangential one is far below.
    const fns = buildAreaBoostFunctions([
      { cwid: "focused", total: 80 },
      { cwid: "tangential", total: 1 },
    ]);
    // tangential 1/80 = 0.0125 < 0.2 ⇒ lo tier, not hi.
    expect(fns).toEqual([
      { filter: { terms: { cwid: ["focused"] } }, weight: AREA_BOOST_W_HI },
      { filter: { terms: { cwid: ["tangential"] } }, weight: AREA_BOOST_W_LO },
    ]);
  });
});
