import { describe, expect, it } from "vitest";
import {
  scorePublication,
  aggregateScholarScore,
  authorshipWeight,
  pubTypeWeight,
  recencyWeight,
  type RankablePublication,
} from "@/lib/ranking";
import { NOW, WORKED_EXAMPLES } from "../fixtures/ranking-worked-examples";

function makePub(overrides: Partial<RankablePublication> = {}): RankablePublication {
  return {
    pmid: "default-pmid",
    publicationType: "Academic Article",
    reciteraiImpact: 0.5,
    // ~12 months before NOW (2026-04-01) — lands in the 6–18mo peak bucket
    // for both recent_highlights and recent_contributions curves.
    dateAddedToEntrez: new Date("2025-04-01T00:00:00Z"),
    authorship: { isFirst: true, isLast: false, isPenultimate: false },
    isConfirmed: true,
    ...overrides,
  };
}

describe("Variant B worked examples (design-spec-v1.7.1.md:1150-1173)", () => {
  it("Whitcomb 2003 Annals as Selected highlight: 0.46", () => {
    const { input, expected } = WORKED_EXAMPLES.whitcombSelected;
    expect(scorePublication(input, "selected_highlights", true, NOW)).toBeCloseTo(expected, 2);
  });

  it("Whitcomb 2003 Annals as Recent highlight (publication-centric): 0.37", () => {
    const { input, expected } = WORKED_EXAMPLES.whitcombRecentHighlight;
    expect(scorePublication(input, "recent_highlights", false, NOW)).toBeCloseTo(expected, 2);
  });

  it("14mo NEJM postdoc as Recent contribution: 0.88", () => {
    const { input, expected } = WORKED_EXAMPLES.nejmPostdocRecentContribution;
    expect(scorePublication(input, "recent_contributions", true, NOW)).toBeCloseTo(expected, 2);
  });
});

describe("recencyWeight curves at bucket edges", () => {
  it("selected_highlights returns 0 at <6mo, 0.7 at 6-18mo, 1.0 at 18mo-10yr, 0.7 at 10-20yr, 0.5 at 20yr+", () => {
    expect(recencyWeight(3, "selected_highlights")).toBe(0);
    expect(recencyWeight(12, "selected_highlights")).toBe(0.7);
    expect(recencyWeight(60, "selected_highlights")).toBe(1.0);
    expect(recencyWeight(180, "selected_highlights")).toBe(0.7);
    expect(recencyWeight(300, "selected_highlights")).toBe(0.5);
  });

  it("recent_highlights returns 0.4 at <3mo, 0.7 at 3-6mo, 1.0 at 6-18mo, 0.8 at 18-36mo, 0.4 at 3yr+", () => {
    expect(recencyWeight(1, "recent_highlights")).toBe(0.4);
    expect(recencyWeight(4, "recent_highlights")).toBe(0.7);
    expect(recencyWeight(12, "recent_highlights")).toBe(1.0);
    expect(recencyWeight(24, "recent_highlights")).toBe(0.8);
    expect(recencyWeight(48, "recent_highlights")).toBe(0.4);
  });

  it("recent_contributions matches recent_highlights shape per spec line 1125", () => {
    expect(recencyWeight(1, "recent_contributions")).toBe(0.4);
    expect(recencyWeight(4, "recent_contributions")).toBe(0.7);
    expect(recencyWeight(12, "recent_contributions")).toBe(1.0);
    expect(recencyWeight(24, "recent_contributions")).toBe(0.8);
    expect(recencyWeight(48, "recent_contributions")).toBe(0.4);
  });

  it("top_scholars uses the compressed Phase 2 D-14 curve (0.7 / 1.0 / 0.85 / 0.7) — distinct from recent_highlights", () => {
    // CONTEXT.md D-14 — buckets: 0–3mo: 0.7, 3mo–3yr: 1.0, 3–6yr: 0.85, 6yr+: 0.7
    expect(recencyWeight(1, "top_scholars")).toBe(0.7);
    expect(recencyWeight(12, "top_scholars")).toBe(1.0);
    expect(recencyWeight(60, "top_scholars")).toBe(0.85);
    expect(recencyWeight(84, "top_scholars")).toBe(0.7);
    // And it MUST differ from recent_highlights at 1mo (0.7 vs 0.4) — protects
    // against the curve being aliased to recent_highlights by mistake.
    expect(recencyWeight(1, "top_scholars")).not.toBe(recencyWeight(1, "recent_highlights"));
  });
});

describe("authorshipWeight", () => {
  it("scholar-centric: first or last = 1.0", () => {
    expect(authorshipWeight({ isFirst: true, isLast: false, isPenultimate: false }, true)).toBe(1.0);
    expect(authorshipWeight({ isFirst: false, isLast: true, isPenultimate: false }, true)).toBe(1.0);
  });
  it("scholar-centric: penultimate = 0 (filter, not down-weight)", () => {
    expect(authorshipWeight({ isFirst: false, isLast: false, isPenultimate: true }, true)).toBe(0);
  });
  it("scholar-centric: middle = 0", () => {
    expect(authorshipWeight({ isFirst: false, isLast: false, isPenultimate: false }, true)).toBe(0);
  });
  it("publication-centric: returns 1.0 for any authorship position", () => {
    expect(authorshipWeight({ isFirst: false, isLast: false, isPenultimate: false }, false)).toBe(1.0);
    expect(authorshipWeight({ isFirst: true, isLast: false, isPenultimate: false }, false)).toBe(1.0);
    expect(authorshipWeight({ isFirst: false, isLast: false, isPenultimate: true }, false)).toBe(1.0);
  });
});

describe("pubTypeWeight", () => {
  it("Academic Article = 1.0", () => {
    expect(pubTypeWeight("Academic Article")).toBe(1.0);
  });
  it("Review = 0.7", () => {
    expect(pubTypeWeight("Review")).toBe(0.7);
  });
  it("Letter / Editorial Article / Erratum = 0 (hard exclude)", () => {
    expect(pubTypeWeight("Letter")).toBe(0);
    expect(pubTypeWeight("Editorial Article")).toBe(0);
    expect(pubTypeWeight("Erratum")).toBe(0);
  });
  it("null and unknown types return 0", () => {
    expect(pubTypeWeight(null)).toBe(0);
    expect(pubTypeWeight("Unknown Type")).toBe(0);
  });
});

describe("aggregateScholarScore (Top scholars chip row, D-14)", () => {
  it("sums per-publication scores using top_scholars curve, scholarCentric=true (filter)", () => {
    const pubs: RankablePublication[] = [
      // first → contributes
      makePub({ pmid: "p1", reciteraiImpact: 0.5, authorship: { isFirst: true, isLast: false, isPenultimate: false } }),
      // last → contributes
      makePub({ pmid: "p2", reciteraiImpact: 0.5, authorship: { isFirst: false, isLast: true, isPenultimate: false } }),
      // penultimate → 0 (D-14 filter)
      makePub({ pmid: "p3", reciteraiImpact: 0.5, authorship: { isFirst: false, isLast: false, isPenultimate: true } }),
      // middle → 0 (D-14 filter)
      makePub({ pmid: "p4", reciteraiImpact: 0.5, authorship: { isFirst: false, isLast: false, isPenultimate: false } }),
    ];
    // 12mo-old paper, top_scholars curve at 12mo = 1.0; per-pub score = 0.5 × 1 × 1 × 1 = 0.5
    // p1 (0.5) + p2 (0.5) + p3 (0) + p4 (0) = 1.0
    const total = aggregateScholarScore(pubs, "top_scholars", NOW);
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("middle and penultimate authorship contribute 0 (filter, not down-weight)", () => {
    const pubs: RankablePublication[] = [
      makePub({ authorship: { isFirst: false, isLast: false, isPenultimate: true } }),
      makePub({ authorship: { isFirst: false, isLast: false, isPenultimate: false } }),
    ];
    expect(aggregateScholarScore(pubs, "top_scholars", NOW)).toBe(0);
  });

  it("hard-excluded publication types contribute 0 (Letter / Editorial Article / Erratum)", () => {
    const pubs: RankablePublication[] = [
      makePub({ pmid: "letter", publicationType: "Letter" }),
      makePub({ pmid: "editorial", publicationType: "Editorial Article" }),
      makePub({ pmid: "erratum", publicationType: "Erratum" }),
    ];
    expect(aggregateScholarScore(pubs, "top_scholars", NOW)).toBe(0);
  });

  it("defaults to top_scholars curve when no curve passed", () => {
    const pubs: RankablePublication[] = [
      makePub({ pmid: "p1", reciteraiImpact: 0.5 }),
    ];
    expect(aggregateScholarScore(pubs, undefined, NOW)).toBeCloseTo(0.5, 2);
  });
});

describe("scorePublication confirmation gating", () => {
  it("unconfirmed authorships score 0 regardless of curve", () => {
    const pub = makePub({ isConfirmed: false });
    expect(scorePublication(pub, "selected_highlights", true, NOW)).toBe(0);
    expect(scorePublication(pub, "recent_highlights", false, NOW)).toBe(0);
  });
});
