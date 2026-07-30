/**
 * Research-Area concentration boost — the pure tier-bucketing helper
 * (spec: docs/search-research-area-relevance-spec.md §3.2). Verifies the
 * relevance×coverage `total` is bucketed into hi/mid/lo weighted function_score
 * clauses keyed on cwid, and that the boundary/empty cases hold.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("SEARCH_AREA_BOOST_W_* env overrides (#1343/#1363 A/B lever)", () => {
    const input = [
      { cwid: "hi1", total: 100 },
      { cwid: "mid1", total: 30 },
      { cwid: "lo1", total: 5 },
    ];
    afterEach(() => vi.unstubAllEnvs());

    it("overrides tier weights from env", () => {
      vi.stubEnv("SEARCH_AREA_BOOST_W_HI", "2");
      vi.stubEnv("SEARCH_AREA_BOOST_W_MID", "1");
      vi.stubEnv("SEARCH_AREA_BOOST_W_LO", "0.5");
      expect(buildAreaBoostFunctions(input)).toEqual([
        { filter: { terms: { cwid: ["hi1"] } }, weight: 2 },
        { filter: { terms: { cwid: ["mid1"] } }, weight: 1 },
        { filter: { terms: { cwid: ["lo1"] } }, weight: 0.5 },
      ]);
    });

    it("weight 0 disables that tier's clause entirely", () => {
      vi.stubEnv("SEARCH_AREA_BOOST_W_LO", "0");
      expect(buildAreaBoostFunctions(input)).toEqual([
        { filter: { terms: { cwid: ["hi1"] } }, weight: AREA_BOOST_W_HI },
        { filter: { terms: { cwid: ["mid1"] } }, weight: AREA_BOOST_W_MID },
      ]);
    });

    it("garbage and negative values fall back to the code defaults", () => {
      vi.stubEnv("SEARCH_AREA_BOOST_W_HI", "banana");
      vi.stubEnv("SEARCH_AREA_BOOST_W_MID", "-1");
      expect(buildAreaBoostFunctions(input)).toEqual([
        { filter: { terms: { cwid: ["hi1"] } }, weight: AREA_BOOST_W_HI },
        { filter: { terms: { cwid: ["mid1"] } }, weight: AREA_BOOST_W_MID },
        { filter: { terms: { cwid: ["lo1"] } }, weight: AREA_BOOST_W_LO },
      ]);
    });
  });
});

/**
 * Contract rule O8 — the graded arm. `total` carries a real evidence magnitude (the
 * concept arm's n²/total over the publications index); three bands discard it. These
 * cover the two properties that matter: OFF is unchanged, and ON makes weight track
 * magnitude for scholars the banded arm cannot separate.
 */
describe("buildAreaBoostFunctions — graded (SEARCH_PEOPLE_AREA_BOOST_GRADED)", () => {
  const CONC = [
    { cwid: "top", total: 100 },
    { cwid: "strong", total: 80 },
    { cwid: "solid", total: 55 },
    { cwid: "thin", total: 30 },
    { cwid: "trace", total: 4 },
  ];

  afterEach(() => {
    delete process.env.SEARCH_PEOPLE_AREA_BOOST_GRADED;
    vi.unstubAllEnvs();
  });

  const weightFor = (fns: Record<string, unknown>[], cwid: string) => {
    const hit = fns.find((f) =>
      (
        (f.filter as { terms?: { cwid?: string[] } } | undefined)?.terms?.cwid ?? []
      ).includes(cwid),
    );
    return hit?.weight as number | undefined;
  };

  it("absent flag reproduces the three-band output exactly", () => {
    const banded = buildAreaBoostFunctions(CONC);
    expect(banded).toHaveLength(3);
    expect(banded.map((f) => f.weight)).toEqual([
      AREA_BOOST_W_HI,
      AREA_BOOST_W_MID,
      AREA_BOOST_W_LO,
    ]);
  });

  it('"off" is byte-identical to absent', () => {
    const absent = buildAreaBoostFunctions(CONC);
    process.env.SEARCH_PEOPLE_AREA_BOOST_GRADED = "off";
    expect(buildAreaBoostFunctions(CONC)).toEqual(absent);
  });

  it("separates scholars the banded arm collapses into one band", () => {
    // Banded: top/strong/solid all clear AREA_BOOST_HI_FRAC (0.5) => identical weight.
    const banded = buildAreaBoostFunctions(CONC);
    expect(weightFor(banded, "top")).toBe(weightFor(banded, "solid"));

    process.env.SEARCH_PEOPLE_AREA_BOOST_GRADED = "on";
    const graded = buildAreaBoostFunctions(CONC);
    // 100 vs 55 is nearly 2x the evidence and must no longer tie.
    expect(weightFor(graded, "top")!).toBeGreaterThan(weightFor(graded, "solid")!);
  });

  it("weight is non-increasing as evidence falls, and stays inside [lo, hi]", () => {
    process.env.SEARCH_PEOPLE_AREA_BOOST_GRADED = "on";
    const fns = buildAreaBoostFunctions(CONC);
    const ws = CONC.map((c) => weightFor(fns, c.cwid)!);
    expect(ws.every((w) => typeof w === "number")).toBe(true);
    for (let i = 1; i < ws.length; i++) expect(ws[i]).toBeLessThanOrEqual(ws[i - 1]);
    expect(Math.max(...ws)).toBeLessThanOrEqual(AREA_BOOST_W_HI);
    expect(Math.min(...ws)).toBeGreaterThanOrEqual(AREA_BOOST_W_LO);
    // The top scholar (frac === 1) must reach the ceiling, not fall one band short.
    expect(weightFor(fns, "top")).toBe(AREA_BOOST_W_HI);
  });

  it("is reorder-only: graded emits the same cwid set as banded", () => {
    const cwids = (fns: Record<string, unknown>[]) =>
      fns
        .flatMap((f) => (f.filter as { terms: { cwid: string[] } }).terms.cwid)
        .sort();
    const banded = cwids(buildAreaBoostFunctions(CONC));
    process.env.SEARCH_PEOPLE_AREA_BOOST_GRADED = "on";
    expect(cwids(buildAreaBoostFunctions(CONC))).toEqual(banded);
  });
});
