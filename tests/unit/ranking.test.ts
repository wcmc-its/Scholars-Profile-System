import { describe, expect, it } from "vitest";
import {
  authorshipPoints,
  impactPoints,
  rankForHighlights,
  rankForRecent,
  recencyScore,
  typePoints,
} from "@/lib/ranking";

describe("authorshipPoints", () => {
  it("awards 5 for first author", () => {
    expect(authorshipPoints({ isFirst: true, isLast: false, isPenultimate: false })).toBe(5);
  });
  it("awards 5 for last author", () => {
    expect(authorshipPoints({ isFirst: false, isLast: true, isPenultimate: false })).toBe(5);
  });
  it("awards 2 for penultimate author", () => {
    expect(authorshipPoints({ isFirst: false, isLast: false, isPenultimate: true })).toBe(2);
  });
  it("awards 0 for middle author", () => {
    expect(authorshipPoints({ isFirst: false, isLast: false, isPenultimate: false })).toBe(0);
  });
});

describe("typePoints", () => {
  it("maps each publicationTypeCanonical to the spec table", () => {
    expect(typePoints("Academic Article")).toBe(4);
    expect(typePoints("Review")).toBe(2);
    expect(typePoints("Case Report")).toBe(2);
    expect(typePoints("Preprint")).toBe(1);
    expect(typePoints("Letter")).toBe(0);
    expect(typePoints("Editorial Article")).toBe(0);
    expect(typePoints("Erratum")).toBe(0);
  });
  it("treats unknown / null types as 0", () => {
    expect(typePoints(null)).toBe(0);
    expect(typePoints(undefined)).toBe(0);
    expect(typePoints("Made-Up Type")).toBe(0);
  });
});

describe("impactPoints", () => {
  it("returns 0 for zero citations", () => {
    expect(impactPoints(0)).toBe(0);
  });
  it("scales as log10(c+1) × 2", () => {
    expect(impactPoints(99)).toBeCloseTo(Math.log10(100) * 2, 5); // 4
  });
  it("caps at 6 (reached around c≈1000)", () => {
    expect(impactPoints(999)).toBeCloseTo(6, 1);
    expect(impactPoints(10_000)).toBe(6);
    expect(impactPoints(1_000_000)).toBe(6);
  });
});

describe("recencyScore", () => {
  const now = new Date("2026-04-29");

  it("is 8 for a paper added today", () => {
    expect(recencyScore(now, now)).toBeCloseTo(8, 5);
  });

  it("decays exponentially", () => {
    // 5 years ago -> 8 * exp(-1) ≈ 2.94
    const fiveYearsAgo = new Date("2021-04-29");
    expect(recencyScore(fiveYearsAgo, now)).toBeCloseTo(8 * Math.exp(-1), 1);

    // 10 years ago -> 8 * exp(-2) ≈ 1.08
    const tenYearsAgo = new Date("2016-04-29");
    expect(recencyScore(tenYearsAgo, now)).toBeCloseTo(8 * Math.exp(-2), 1);
  });

  it("returns 0 when no date is available", () => {
    expect(recencyScore(null, now)).toBe(0);
  });

  it("pins future dates to the cap", () => {
    const future = new Date("2027-04-29");
    expect(recencyScore(future, now)).toBe(8);
  });
});

describe("rankForHighlights", () => {
  const now = new Date("2026-04-29");

  it("filters out errata and unconfirmed authorships", () => {
    const pubs = [
      makePub({ pmid: "1", publicationType: "Academic Article", isConfirmed: true }),
      makePub({ pmid: "2", publicationType: "Erratum", isConfirmed: true }),
      makePub({ pmid: "3", publicationType: "Academic Article", isConfirmed: false }),
    ];
    const ranked = rankForHighlights(pubs, now);
    expect(ranked.map((p) => p.pmid)).toEqual(["1"]);
  });

  it("sorts by highlight_score desc, then citations desc, then date desc", () => {
    // landmark: Academic Article (4), 1000 cites (capped 6), first author (5) = 15
    const landmark = makePub({
      pmid: "landmark",
      publicationType: "Academic Article",
      citationCount: 1000,
      dateAddedToEntrez: new Date("2015-01-01"),
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
    });
    // strong: Academic Article (4), 50 cites (~3.4), first author (5) = ~12.4
    const strong = makePub({
      pmid: "strong",
      publicationType: "Academic Article",
      citationCount: 50,
      dateAddedToEntrez: new Date("2024-01-01"),
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
    });
    // tiebreakA & B: identical highlight scores, same cites — date breaks the tie.
    const tieNewer = makePub({
      pmid: "tieNewer",
      publicationType: "Academic Article",
      citationCount: 200,
      dateAddedToEntrez: new Date("2023-01-01"),
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
    });
    const tieOlder = makePub({
      pmid: "tieOlder",
      publicationType: "Academic Article",
      citationCount: 200,
      dateAddedToEntrez: new Date("2018-01-01"),
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
    });

    const ranked = rankForHighlights([strong, tieOlder, tieNewer, landmark], now);
    expect(ranked[0].pmid).toBe("landmark");
    // tieNewer / tieOlder both score above strong (more cites); date breaks tie between them.
    expect(ranked[1].pmid).toBe("tieNewer");
    expect(ranked[2].pmid).toBe("tieOlder");
    expect(ranked[3].pmid).toBe("strong");
  });
});

describe("rankForRecent", () => {
  const now = new Date("2026-04-29");

  it("filters out unconfirmed authorships but keeps errata", () => {
    const pubs = [
      makePub({ pmid: "1", publicationType: "Academic Article", isConfirmed: true }),
      makePub({ pmid: "2", publicationType: "Erratum", isConfirmed: true }),
      makePub({ pmid: "3", publicationType: "Academic Article", isConfirmed: false }),
    ];
    const ranked = rankForRecent(pubs, now);
    expect(ranked.map((p) => p.pmid).sort()).toEqual(["1", "2"]);
  });

  it("favors recent landmark first/last papers over older ones", () => {
    const recent = makePub({
      pmid: "recent",
      publicationType: "Academic Article",
      citationCount: 50,
      dateAddedToEntrez: new Date("2025-09-01"),
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
    });
    const ancient = makePub({
      pmid: "ancient",
      publicationType: "Academic Article",
      citationCount: 50,
      dateAddedToEntrez: new Date("2014-01-01"),
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
    });
    const ranked = rankForRecent([ancient, recent], now);
    expect(ranked[0].pmid).toBe("recent");
  });

  it("respects the recency cap so a landmark old paper can still beat a thin new one", () => {
    const oldLandmark = makePub({
      pmid: "old-landmark",
      publicationType: "Review",
      citationCount: 1000,
      dateAddedToEntrez: new Date("2018-01-01"),
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
    });
    const thinNew = makePub({
      pmid: "thin-new",
      publicationType: "Letter",
      citationCount: 0,
      dateAddedToEntrez: new Date("2026-04-01"),
      authorship: { isFirst: false, isLast: false, isPenultimate: false },
    });
    const ranked = rankForRecent([thinNew, oldLandmark], now);
    expect(ranked[0].pmid).toBe("old-landmark");
  });
});

// --- helpers ---

function makePub(overrides: Partial<MakePubOverrides> = {}) {
  return {
    pmid: "default",
    publicationType: "Academic Article",
    citationCount: 0,
    dateAddedToEntrez: new Date("2024-01-01"),
    authorship: { isFirst: true, isLast: false, isPenultimate: false },
    isConfirmed: true,
    ...overrides,
  };
}

type MakePubOverrides = {
  pmid: string;
  publicationType: string | null;
  citationCount: number;
  dateAddedToEntrez: Date | null;
  authorship: { isFirst: boolean; isLast: boolean; isPenultimate: boolean };
  isConfirmed: boolean;
};
