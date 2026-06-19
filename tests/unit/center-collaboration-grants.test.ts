import { describe, it, expect } from "vitest";
import {
  UMBRELLA_MECHANISMS,
  UMBRELLA_MEMBER_FLOOR,
  isUmbrellaAward,
  awardInYearRange,
  filterAwards,
  countUmbrellaExcluded,
  awardYearExtent,
  mergeAxisEdges,
  mergeAxisEdgesThresholded,
} from "@/lib/center-collaboration/grants";
import {
  buildPeopleEdges,
  buildProgramEdges,
  programKey,
} from "@/lib/center-collaboration/graph";
import type { CollabAward } from "@/lib/center-collaboration/types";

// A minimal award factory — only the fields the helpers read.
const award = (over: Partial<CollabAward> = {}): CollabAward => ({
  awardId: "A",
  m: [0, 1],
  year: 2021,
  endYear: 2024,
  active: true,
  umbrella: false,
  ...over,
});

describe("isUmbrellaAward", () => {
  it("flags NIH center/training mechanisms (case-insensitive)", () => {
    expect(isUmbrellaAward(["P50"], 4)).toBe(true);
    expect(isUmbrellaAward(["ul1"], 3)).toBe(true);
    expect(isUmbrellaAward(["U54", null], 5)).toBe(true);
  });
  it("does not flag ordinary research mechanisms", () => {
    expect(isUmbrellaAward(["R01"], 4)).toBe(false);
    expect(isUmbrellaAward(["U01", "K23"], 6)).toBe(false);
    expect(isUmbrellaAward([null, null], 3)).toBe(false);
  });
  it("flags large null-mechanism awards via the member floor (e.g. PICI)", () => {
    expect(isUmbrellaAward([null], UMBRELLA_MEMBER_FLOOR)).toBe(true);
    expect(isUmbrellaAward([null], UMBRELLA_MEMBER_FLOOR - 1)).toBe(false);
  });
  it("exports the documented mechanism set", () => {
    for (const m of ["P30", "P50", "U54", "UL1", "S10", "KL2", "TL1"]) {
      expect(UMBRELLA_MECHANISMS.has(m)).toBe(true);
    }
    expect(UMBRELLA_MECHANISMS.has("R01")).toBe(false);
  });
});

describe("awardInYearRange (span overlap, not point)", () => {
  it("includes everything when no range / open range", () => {
    expect(awardInYearRange(award(), undefined)).toBe(true);
    expect(awardInYearRange(award(), [null, null])).toBe(true);
  });
  it("keeps an award whose span overlaps the window even if it started earlier", () => {
    // span 2015–2024, window 2020–2022 → overlaps.
    expect(awardInYearRange(award({ year: 2015, endYear: 2024 }), [2020, 2022])).toBe(true);
  });
  it("drops an award whose span is entirely outside the window", () => {
    expect(awardInYearRange(award({ year: 2010, endYear: 2014 }), [2020, 2022])).toBe(false);
    expect(awardInYearRange(award({ year: 2030, endYear: 2031 }), [2020, 2022])).toBe(false);
  });
  it("respects a one-sided bound", () => {
    expect(awardInYearRange(award({ year: 2018, endYear: 2019 }), [2020, null])).toBe(false);
    expect(awardInYearRange(award({ year: 2018, endYear: 2021 }), [2020, null])).toBe(true);
  });
  it("drops a fully-undated award once a bound is set", () => {
    expect(awardInYearRange(award({ year: null, endYear: null }), [2020, 2022])).toBe(false);
    expect(awardInYearRange(award({ year: null, endYear: null }), undefined)).toBe(true);
  });
});

describe("filterAwards", () => {
  const awards = [
    award({ awardId: "real", umbrella: false, active: true, year: 2022, endYear: 2025 }),
    award({ awardId: "umbrella", umbrella: true, active: true, year: 2022, endYear: 2025 }),
    award({ awardId: "expired", umbrella: false, active: false, year: 2010, endYear: 2014 }),
  ];
  it("drops umbrella awards when excludeUmbrella is set", () => {
    const out = filterAwards(awards, { excludeUmbrella: true });
    expect(out.map((a) => a.awardId).sort()).toEqual(["expired", "real"]);
  });
  it("drops inactive awards when activeOnly is set", () => {
    const out = filterAwards(awards, { activeOnly: true });
    expect(out.map((a) => a.awardId).sort()).toEqual(["real", "umbrella"]);
  });
  it("combines all three filters", () => {
    const out = filterAwards(awards, {
      excludeUmbrella: true,
      activeOnly: true,
      yearRange: [2020, 2026],
    });
    expect(out.map((a) => a.awardId)).toEqual(["real"]);
  });
  it("returns everything with no options", () => {
    expect(filterAwards(awards)).toHaveLength(3);
  });
});

describe("countUmbrellaExcluded", () => {
  it("counts only umbrella awards that survive the active/year filters", () => {
    const awards = [
      award({ umbrella: true, active: true, year: 2022, endYear: 2025 }),
      award({ umbrella: true, active: false, year: 2010, endYear: 2014 }), // dropped by activeOnly
      award({ umbrella: false, active: true, year: 2022, endYear: 2025 }), // not umbrella
    ];
    expect(countUmbrellaExcluded(awards, { activeOnly: true })).toBe(1);
    expect(countUmbrellaExcluded(awards)).toBe(2);
  });
});

describe("awardYearExtent", () => {
  it("spans the min start and max end across awards", () => {
    expect(
      awardYearExtent([
        award({ year: 2018, endYear: 2022 }),
        award({ year: 2020, endYear: 2026 }),
      ]),
    ).toEqual([2018, 2026]);
  });
  it("returns null when no award has any year", () => {
    expect(awardYearExtent([award({ year: null, endYear: null })])).toBeNull();
  });
});

describe("group-agnostic builders accept awards", () => {
  // Two awards over 4 members: a real pair (0,1) and an umbrella clique (0,1,2,3).
  const awards: CollabAward[] = [
    award({ awardId: "r1", m: [0, 1] }),
    award({ awardId: "u1", m: [0, 1, 2, 3], umbrella: true }),
  ];
  it("buildPeopleEdges builds grant edges from award member sets", () => {
    const edges = buildPeopleEdges(awards);
    const w = new Map(edges.map((e) => [`${e.a}-${e.b}`, e.weight]));
    expect(w.get("0-1")).toBe(2); // both awards
    expect(w.get("2-3")).toBe(1); // only the umbrella award
  });
  it("excluding the umbrella award drops its clique edges", () => {
    const edges = buildPeopleEdges(filterAwards(awards, { excludeUmbrella: true }));
    const w = new Map(edges.map((e) => [`${e.a}-${e.b}`, e.weight]));
    expect(w.get("0-1")).toBe(1); // only the real award remains
    expect(w.has("2-3")).toBe(false);
  });
  it("buildProgramEdges rolls grant awards up to programs", () => {
    const progOf = (i: number): string | null => (i < 2 ? "CB" : "CT");
    const { edges, internal } = buildProgramEdges(awards, progOf);
    // r1 is wholly within CB; u1 spans CB+CT.
    expect(internal.get("CB")).toBe(1);
    const cross = edges.find((e) => e.a === "CB" && e.b === "CT");
    expect(cross?.weight).toBe(1);
  });
});

describe("mergeAxisEdges (option C relationship coloring)", () => {
  const pub = [
    { a: 0, b: 1, weight: 3, strength: 3 }, // pub-only
    { a: 1, b: 2, weight: 1, strength: 1 }, // shared with grant → both
  ];
  const grant = [
    { a: 1, b: 2, weight: 2, strength: 2 }, // both
    { a: 2, b: 3, weight: 1, strength: 1 }, // grant-only
  ];
  it("colors each pair by the relationship and keeps both weights", () => {
    const merged = mergeAxisEdges(pub, grant);
    const byKey = new Map(merged.map((e) => [`${e.a}-${e.b}`, e]));
    expect(byKey.get("0-1")?.rel).toBe("pub");
    expect(byKey.get("0-1")?.grantWeight).toBe(0);
    expect(byKey.get("1-2")?.rel).toBe("both");
    expect(byKey.get("1-2")?.pubWeight).toBe(1);
    expect(byKey.get("1-2")?.grantWeight).toBe(2);
    expect(byKey.get("1-2")?.strength).toBe(2); // max of the two
    expect(byKey.get("2-3")?.rel).toBe("grant");
    expect(byKey.get("2-3")?.pubWeight).toBe(0);
    expect(merged).toHaveLength(3);
  });
  it("works for string-keyed program edges too", () => {
    const merged = mergeAxisEdges(
      [{ a: programKey("CB"), b: programKey(null), weight: 2 }],
      [{ a: programKey("CB"), b: programKey(null), weight: 1 }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].rel).toBe("both");
  });
});

describe("mergeAxisEdgesThresholded (threshold AFTER merge — both views agree)", () => {
  // The headline option-C bug: a pub-heavy pair with a single shared grant must
  // stay "both" (green), not be downgraded by a per-axis pre-threshold.
  it("keeps a pub=3 / grant=1 pair as 'both' at min=2 (not downgraded to pub-only)", () => {
    const merged = mergeAxisEdgesThresholded(
      [{ a: 0, b: 1, weight: 3, strength: 3 }],
      [{ a: 0, b: 1, weight: 1, strength: 1 }],
      2,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].rel).toBe("both");
    expect(merged[0].grantWeight).toBe(1);
  });
  it("drops a pair whose stronger tie is below the threshold", () => {
    const merged = mergeAxisEdgesThresholded(
      [{ a: 0, b: 1, weight: 1, strength: 1 }],
      [{ a: 0, b: 1, weight: 1, strength: 1 }],
      2,
    );
    expect(merged).toHaveLength(0);
  });
  it("matches for string-keyed (program) edges — same helper, same result", () => {
    const merged = mergeAxisEdgesThresholded(
      [{ a: "CB", b: "CT", weight: 3 }],
      [{ a: "CB", b: "CT", weight: 1 }],
      2,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].rel).toBe("both");
  });
});
