/**
 * GrantRecs Phase 2, Task 7 — reverse matcher ("Find researchers for this
 * opportunity") combination core. Given per-topic ranked scholars (from the
 * existing getTopScholarsForTopic-style aggregation), combine across the
 * opportunity's topics weighted by each topic's score, keeping `topicFit` and
 * `stageAppeal` as DISTINCT axes (symmetric with the forward matcher; spec §7.4).
 * Pure — no DB.
 */
import { describe, expect, it } from "vitest";

import {
  deriveGrantSignals,
  meanTopRelevance,
  rankResearchers,
  type TopicResult,
} from "@/lib/api/match-researchers";

const TOPICS: TopicResult[] = [
  {
    topicId: "implementation_science",
    topicWeight: 0.97,
    scholars: [
      { cwid: "aaa", slug: "a", variantBScore: 10 },
      { cwid: "bbb", slug: "b", variantBScore: 4 },
    ],
  },
  {
    topicId: "biostatistics",
    topicWeight: 0.41,
    scholars: [
      { cwid: "bbb", slug: "b", variantBScore: 8 },
      { cwid: "ccc", slug: "c", variantBScore: 6 },
    ],
  },
];

describe("rankResearchers — weighted topic union", () => {
  it("combines per-topic scores weighted by topic score; primary-topic expert wins", () => {
    const ranked = rankResearchers(TOPICS, {});
    // aaa: 0.97*10 = 9.7 ; bbb: 0.97*4 + 0.41*8 = 3.88+3.28 = 7.16 ; ccc: 0.41*6 = 2.46
    expect(ranked.map((r) => r.cwid)).toEqual(["aaa", "bbb", "ccc"]);
    expect(ranked[0].axes.topicFit).toBeCloseTo(9.7);
  });

  it("records per-topic contributions", () => {
    const bbb = rankResearchers(TOPICS, {}).find((r) => r.cwid === "bbb")!;
    expect(bbb.topicContributions).toEqual([
      { topicId: "implementation_science", contribution: expect.closeTo(3.88), pubCount: 0, minYear: null },
      { topicId: "biostatistics", contribution: expect.closeTo(3.28), pubCount: 0, minYear: null },
    ]);
  });

  it("carries per-topic pubCount/minYear evidence and the career-stage bucket through to the result", () => {
    const topics: TopicResult[] = [
      {
        topicId: "implementation_science",
        topicWeight: 1,
        scholars: [{ cwid: "aaa", slug: "a", variantBScore: 5, pubCount: 18, minYear: 2021 }],
      },
    ];
    const [r] = rankResearchers(topics, {
      appealByStage: { early: 1 },
      stageByCwid: new Map([["aaa", "early"]]),
    });
    expect(r.careerStage).toBe("early");
    expect(r.topicContributions[0]).toMatchObject({ pubCount: 18, minYear: 2021 });
  });

  it("defaults careerStage to null when the scholar's stage is unknown", () => {
    const [r] = rankResearchers(TOPICS, {});
    expect(r.careerStage).toBeNull();
  });

  it("keeps stageAppeal distinct; default (lens off) ranks by topicFit only", () => {
    const ranked = rankResearchers(TOPICS, {
      appealByStage: { grad: 0, postdoc: 0, early: 1, mid: 0.2, senior: 0 },
      stageByCwid: new Map([
        ["aaa", "senior"],
        ["bbb", "early"],
        ["ccc", "mid"],
      ]),
    });
    expect(ranked.map((r) => r.cwid)).toEqual(["aaa", "bbb", "ccc"]); // unchanged — lens off
    expect(ranked.find((r) => r.cwid === "aaa")!.axes.stageAppeal).toBe(0); // senior appeal 0
    expect(ranked.find((r) => r.cwid === "bbb")!.axes.stageAppeal).toBe(1); // early appeal 1
  });

  it("stageLens on re-ranks toward stage-appropriate scholars without altering axes", () => {
    const opts = {
      appealByStage: { grad: 0, postdoc: 0, early: 1, mid: 0.2, senior: 0 },
      stageByCwid: new Map<string, "grad" | "postdoc" | "early" | "mid" | "senior">([
        ["aaa", "senior"],
        ["bbb", "early"],
        ["ccc", "mid"],
      ]),
    };
    const off = rankResearchers(TOPICS, opts);
    const on = rankResearchers(TOPICS, { ...opts, stageLens: true });
    // bbb (early, appeal 1) overtakes aaa (senior, appeal 0) under the lens.
    expect(on[0].cwid).toBe("bbb");
    // axes identical between runs; only defaultScore/order moves.
    const offB = off.find((r) => r.cwid === "bbb")!;
    const onB = on.find((r) => r.cwid === "bbb")!;
    expect(onB.axes).toEqual(offB.axes);
  });

  it("sort:'stage' orders by stageAppeal independently of topicFit", () => {
    const ranked = rankResearchers(TOPICS, {
      sort: "stage",
      appealByStage: { grad: 0, postdoc: 0, early: 1, mid: 0.5, senior: 0 },
      stageByCwid: new Map([
        ["aaa", "senior"],
        ["bbb", "early"],
        ["ccc", "mid"],
      ]),
    });
    expect(ranked[0].cwid).toBe("bbb"); // highest stageAppeal
  });

  it("respects limit", () => {
    expect(rankResearchers(TOPICS, { limit: 2 })).toHaveLength(2);
  });

  describe("esiOnly soft gate", () => {
    // Fit order is aaa > bbb > ccc; ccc is the only ESI-eligible.
    const esi = new Map([
      ["aaa", false],
      ["bbb", false],
      ["ccc", true],
    ]);

    it("off (default): order unchanged", () => {
      expect(rankResearchers(TOPICS, { esiEligibleByCwid: esi }).map((r) => r.cwid)).toEqual([
        "aaa",
        "bbb",
        "ccc",
      ]);
    });

    it("on: demotes ineligible below eligible, preserving within-group order; drops no one", () => {
      const ranked = rankResearchers(TOPICS, { esiOnly: true, esiEligibleByCwid: esi });
      expect(ranked.map((r) => r.cwid)).toEqual(["ccc", "aaa", "bbb"]);
      expect(ranked).toHaveLength(3); // soft — nobody removed
    });

    it("demote happens BEFORE the limit slice — an eligible scholar past the cut surfaces", () => {
      // Without the gate, limit:1 yields the top-fit aaa. With it, the only
      // eligible (ccc, ranked 3rd by fit) must surface despite the cut.
      expect(rankResearchers(TOPICS, { limit: 1 }).map((r) => r.cwid)).toEqual(["aaa"]);
      expect(
        rankResearchers(TOPICS, { limit: 1, esiOnly: true, esiEligibleByCwid: esi }).map((r) => r.cwid),
      ).toEqual(["ccc"]);
    });

    it("treats unknown (undateable) eligibility as ineligible — demoted, never dropped", () => {
      // ccc absent from the map → unknown → ranked among the ineligible group, not removed.
      const ranked = rankResearchers(TOPICS, {
        esiOnly: true,
        esiEligibleByCwid: new Map([["aaa", true]]),
      });
      expect(ranked.map((r) => r.cwid)).toEqual(["aaa", "bbb", "ccc"]);
      expect(ranked).toHaveLength(3);
    });
  });
});

describe("deriveGrantSignals — grant-history display signals", () => {
  const NOW = new Date("2026-06-22T00:00:00Z");
  const future = new Date("2027-01-01");
  const past = new Date("2020-01-01");

  it("funded when any award is currently active (any role)", () => {
    const s = deriveGrantSignals(
      { grants: [{ endDate: future, role: "Co-I", mechanism: null }], educations: [] },
      NOW,
    );
    expect(s.fundingStatus).toBe("funded");
  });

  it("unfunded when every award has ended (or there are none)", () => {
    expect(
      deriveGrantSignals({ grants: [{ endDate: past, role: "PI", mechanism: "R01" }], educations: [] }, NOW)
        .fundingStatus,
    ).toBe("unfunded");
    expect(deriveGrantSignals({ grants: [], educations: [] }, NOW).fundingStatus).toBe("unfunded");
  });

  it("still funded within the 12-month NCE grace (matches the profile's Active badge)", () => {
    // Ended 4 months before NOW → past the end date but inside the canonical grace.
    const recentlyEnded = new Date("2026-02-22");
    expect(
      deriveGrantSignals({ grants: [{ endDate: recentlyEnded, role: "PI", mechanism: "R01" }] }, NOW)
        .fundingStatus,
    ).toBe("funded");
  });

  it("ESI-eligible: within the 10yr window with no prior major PI award", () => {
    const s = deriveGrantSignals(
      { grants: [{ endDate: future, role: "Co-I", mechanism: "K08" }], educations: [{ year: 2020 }] },
      NOW,
    );
    expect(s).toMatchObject({ esiEligible: true, yearsSinceDegree: 6 });
  });

  it("ESI forfeited by a prior R01-equivalent held as PI", () => {
    const s = deriveGrantSignals(
      { grants: [{ endDate: past, role: "PI", mechanism: "R01" }], educations: [{ year: 2020 }] },
      NOW,
    );
    expect(s.esiEligible).toBe(false);
  });

  it("a major mechanism held only as co-I does NOT forfeit ESI", () => {
    const s = deriveGrantSignals(
      { grants: [{ endDate: past, role: "Co-I", mechanism: "U01" }], educations: [{ year: 2022 }] },
      NOW,
    );
    expect(s.esiEligible).toBe(true);
  });

  it("not ESI-eligible past the window, and never when the degree year is unknown", () => {
    expect(
      deriveGrantSignals({ grants: [], educations: [{ year: 2005 }] }, NOW).esiEligible,
    ).toBe(false); // 21 yrs out
    const unknown = deriveGrantSignals({ grants: [], educations: [] }, NOW);
    expect(unknown).toMatchObject({ esiEligible: false, yearsSinceDegree: null });
  });

  it("ESI clock uses the TERMINAL degree, not a later non-doctoral credential", () => {
    // MD 2005 + a later MPH 2020: terminal = MD (21 yrs out) → NOT ESI-eligible,
    // even though max(year) over all rows would wrongly read 6 yrs.
    const s = deriveGrantSignals(
      { grants: [], educations: [{ year: 2005, degree: "MD" }, { year: 2020, degree: "MPH" }] },
      NOW,
    );
    expect(s).toMatchObject({ esiEligible: false, yearsSinceDegree: 21 });
  });

  it("dates from the latest doctorate for an MD-PhD; ignores a later master's", () => {
    const s = deriveGrantSignals(
      {
        grants: [],
        educations: [
          { year: 2018, degree: "M.D." },
          { year: 2021, degree: "Ph.D." },
          { year: 2023, degree: "M.S." },
        ],
      },
      NOW,
    );
    expect(s).toMatchObject({ esiEligible: true, yearsSinceDegree: 5 }); // 2026 − 2021
  });

  it("falls back to all education rows when no degree string parses as a doctorate", () => {
    const s = deriveGrantSignals({ grants: [], educations: [{ year: 2022, degree: "Residency" }] }, NOW);
    expect(s.yearsSinceDegree).toBe(4); // no doctorate → use the row we have
  });
});

describe("meanTopRelevance (abstention signal)", () => {
  it("averages the top-3 relevances per scholar across the top-k ranked", () => {
    const rel = new Map<string, number[]>([
      ["aaa", [0.9, 0.8, 0.7, 0.1]], // top-3 = 0.9,0.8,0.7 (the 0.1 is dropped)
      ["bbb", [0.6, 0.5]], // fewer than 3 → both count
    ]);
    // (0.9+0.8+0.7 + 0.6+0.5) / 5 = 3.5/5
    expect(meanTopRelevance(["aaa", "bbb"], rel)).toBeCloseTo(0.7, 6);
  });

  it("only counts the top-k scholars", () => {
    const rel = new Map<string, number[]>([
      ["aaa", [0.5]],
      ["zzz", [0.0]], // outside k=1 → ignored
    ]);
    expect(meanTopRelevance(["aaa", "zzz"], rel, 1)).toBeCloseTo(0.5, 6);
  });

  it("returns 0 when no ranked scholar carries relevance (dead grant / empty pool)", () => {
    expect(meanTopRelevance(["aaa"], new Map())).toBe(0);
    expect(meanTopRelevance([], new Map([["aaa", [0.9]]]))).toBe(0);
  });

  it("separates a dead grant from a strong one at the 0.10 floor", () => {
    const dead = new Map<string, number[]>([["a", [0.04]], ["b", [0.03]]]);
    const strong = new Map<string, number[]>([["a", [0.6]], ["b", [0.4]]]);
    expect(meanTopRelevance(["a", "b"], dead)).toBeLessThan(0.1);
    expect(meanTopRelevance(["a", "b"], strong)).toBeGreaterThan(0.1);
  });
});
