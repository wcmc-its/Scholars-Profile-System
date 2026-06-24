import { describe, expect, it } from "vitest";

import {
  rankMethodExemplar,
  rankMethodExemplarList,
  queryTitleTokens,
  markTitleQueryTerms,
  type ExemplarCandidate,
} from "@/lib/api/method-exemplar-rank";

const YEAR = 2026;

/** Minimal candidate with overridable fields; defaults are a plain, non-owned,
 *  unscored original-research paper so each test isolates ONE ranking signal. */
function cand(over: Partial<ExemplarCandidate> & { pmid: string }): ExemplarCandidate {
  return {
    title: `Title ${over.pmid}`,
    year: 2020,
    publicationType: "Academic Article",
    impactScore: null,
    citationCount: 0,
    isFirstOrSenior: false,
    ...over,
  };
}

describe("rankMethodExemplar — §7 lexicographic key", () => {
  it("returns null on an empty candidate set", () => {
    expect(rankMethodExemplar([], YEAR)).toBeNull();
  });

  it("1. original research outranks a review even if the review is newer / more cited", () => {
    const review = cand({ pmid: "2", publicationType: "Review", year: 2025, citationCount: 999 });
    const original = cand({ pmid: "1", publicationType: "Academic Article", year: 2010 });
    expect(rankMethodExemplar([review, original], YEAR)?.pmid).toBe("1");
  });

  it("falls back to the best NON-original when no original research exists (not null)", () => {
    const olderReview = cand({ pmid: "2", publicationType: "Review", year: 2012 });
    const newerReview = cand({ pmid: "1", publicationType: "Review", year: 2024 });
    // No Academic Article present ⇒ originals tier is a wash ⇒ later keys decide.
    expect(rankMethodExemplar([olderReview, newerReview], YEAR)?.pmid).toBe("1");
  });

  it("2. first/senior author outranks a middle-author paper at equal type", () => {
    const middle = cand({ pmid: "2", isFirstOrSenior: false, impactScore: 90 });
    const owned = cand({ pmid: "1", isFirstOrSenior: true, impactScore: 10 });
    // Ownership is checked BEFORE impact, so the low-impact owned paper wins.
    expect(rankMethodExemplar([middle, owned], YEAR)?.pmid).toBe("1");
  });

  it("3a. higher impactScore wins; nulls rank last", () => {
    const unscored = cand({ pmid: "2", impactScore: null, citationCount: 500 });
    const scored = cand({ pmid: "1", impactScore: 42 });
    expect(rankMethodExemplar([unscored, scored], YEAR)?.pmid).toBe("1");
  });

  it("3b. citations-per-year breaks ties when impactScore is equal/absent", () => {
    const lowCpy = cand({ pmid: "2", year: 2016, citationCount: 10 }); // 10/11 ≈ 0.9/yr
    const highCpy = cand({ pmid: "1", year: 2024, citationCount: 30 }); // 30/3 = 10/yr
    expect(rankMethodExemplar([lowCpy, highCpy], YEAR)?.pmid).toBe("1");
  });

  it("4. recency is the final substantive tiebreak", () => {
    const older = cand({ pmid: "2", year: 2018 });
    const newer = cand({ pmid: "1", year: 2023 });
    expect(rankMethodExemplar([older, newer], YEAR)?.pmid).toBe("1");
  });

  it("5. equal on every signal ⇒ deterministic pmid tiebreak (stable across requests)", () => {
    const a = cand({ pmid: "555" });
    const b = cand({ pmid: "111" });
    expect(rankMethodExemplar([a, b], YEAR)?.pmid).toBe("111");
    // Order-independent.
    expect(rankMethodExemplar([b, a], YEAR)?.pmid).toBe("111");
  });

  it("hard-drops Retraction / Erratum even when they would otherwise win", () => {
    const retraction = cand({ pmid: "2", publicationType: "Retraction", impactScore: 100, isFirstOrSenior: true });
    const erratum = cand({ pmid: "3", publicationType: "Erratum", impactScore: 100 });
    const plain = cand({ pmid: "1", publicationType: "Review", impactScore: 1 });
    expect(rankMethodExemplar([retraction, erratum, plain], YEAR)?.pmid).toBe("1");
    expect(rankMethodExemplar([retraction, erratum], YEAR)).toBeNull();
  });

  it("drops candidates with a blank title", () => {
    const blank = cand({ pmid: "2", title: "   ", impactScore: 100, isFirstOrSenior: true });
    const real = cand({ pmid: "1", title: "Real paper", impactScore: 1 });
    expect(rankMethodExemplar([blank, real], YEAR)?.pmid).toBe("1");
  });

  it("returns {pmid,title,year} of the winner; undated year normalizes to null", () => {
    const undated = cand({ pmid: "9", year: null, title: "Undated", publicationType: "Review" });
    expect(rankMethodExemplar([undated], YEAR)).toEqual({ pmid: "9", title: "Undated", year: null });
  });
});

describe("rankMethodExemplarList — top-N (rep-papers disclosure)", () => {
  it("returns [] on an empty candidate set", () => {
    expect(rankMethodExemplarList([], YEAR)).toEqual([]);
  });

  it("returns up to `limit` papers, default 3, in the SAME ranked order as the single pick", () => {
    // Four candidates; recency is the only differentiating signal here.
    const c = [
      cand({ pmid: "a", year: 2018, title: "Oldest" }),
      cand({ pmid: "b", year: 2024, title: "Newest" }),
      cand({ pmid: "c", year: 2021, title: "Middle" }),
      cand({ pmid: "d", year: 2020, title: "Older" }),
    ];
    const top = rankMethodExemplarList(c, YEAR);
    expect(top).toHaveLength(3);
    expect(top.map((p) => p.pmid)).toEqual(["b", "c", "d"]); // 2024 ▸ 2021 ▸ 2020
    // The single-pick helper agrees with the head of the list.
    expect(rankMethodExemplar(c, YEAR)?.pmid).toBe("b");
  });

  it("honors a custom `limit`", () => {
    const c = [
      cand({ pmid: "b", year: 2024 }),
      cand({ pmid: "c", year: 2021 }),
      cand({ pmid: "d", year: 2020 }),
    ];
    expect(rankMethodExemplarList(c, YEAR, 1).map((p) => p.pmid)).toEqual(["b"]);
    expect(rankMethodExemplarList(c, YEAR, 2).map((p) => p.pmid)).toEqual(["b", "c"]);
    // limit ≥ pool size returns the whole sorted pool.
    expect(rankMethodExemplarList(c, YEAR, 10)).toHaveLength(3);
  });

  it("limit ≤ 0 ⇒ []", () => {
    const c = [cand({ pmid: "b", year: 2024 })];
    expect(rankMethodExemplarList(c, YEAR, 0)).toEqual([]);
  });

  it("applies the same hard-drop (Retraction/Erratum) + blank-title filter before slicing", () => {
    const c = [
      cand({ pmid: "ret", publicationType: "Retraction", year: 2025, isFirstOrSenior: true }),
      cand({ pmid: "blank", title: "  ", year: 2025 }),
      cand({ pmid: "ok1", year: 2024, title: "Good 1" }),
      cand({ pmid: "ok2", year: 2023, title: "Good 2" }),
    ];
    expect(rankMethodExemplarList(c, YEAR).map((p) => p.pmid)).toEqual(["ok1", "ok2"]);
  });

  it("maps each entry to {pmid,title,year}, normalizing an undated year to null", () => {
    const undated = cand({ pmid: "9", year: null, title: "Undated", publicationType: "Review" });
    expect(rankMethodExemplarList([undated], YEAR)).toEqual([{ pmid: "9", title: "Undated", year: null }]);
  });
});

describe("rankMethodExemplarList — query relevance ('Key papers' must match the search)", () => {
  it("surfaces a title-matching paper FIRST, above a higher-impact non-match", () => {
    const hiImpactNoMatch = cand({ pmid: "imp", title: "Unrelated work", impactScore: 99, isFirstOrSenior: true });
    const titleMatch = cand({ pmid: "hit", title: "Stem cell self-renewal", impactScore: 1 });
    const top = rankMethodExemplarList([hiImpactNoMatch, titleMatch], YEAR, 3, "stem cells");
    expect(top[0].pmid).toBe("hit");
  });

  it("marks the matched term in the returned titleHtml (whole-word, case-insensitive)", () => {
    const top = rankMethodExemplarList([cand({ pmid: "1", title: "Stem Cell biology" })], YEAR, 3, "stem cells");
    expect(top[0].titleHtml).toBe("<mark>Stem</mark> Cell biology");
  });

  it("leaves titleHtml unset for a non-matching paper (renders plain)", () => {
    const top = rankMethodExemplarList([cand({ pmid: "1", title: "Cardiac fibrosis" })], YEAR, 3, "stem cells");
    expect(top[0].titleHtml).toBeUndefined();
  });

  it("no query ⇒ pure impact ranking, no titleHtml (back-compat)", () => {
    const top = rankMethodExemplarList([cand({ pmid: "1", title: "Stem cell work" })], YEAR);
    expect(top[0].titleHtml).toBeUndefined();
  });
});

describe("queryTitleTokens / markTitleQueryTerms (pure title-relevance helpers)", () => {
  it("tokenizes lowercased, ≥2 chars, deduped", () => {
    expect(queryTitleTokens("Stem Cells")).toEqual(["stem", "cells"]);
    expect(queryTitleTokens("a 16S-rna a")).toEqual(["16s", "rna"]);
  });

  it("wraps whole-word matches only — 'stem' does not highlight 'system'", () => {
    const { html, matched } = markTitleQueryTerms("Immune system mapping", queryTitleTokens("stem"));
    expect(matched).toBe(false);
    expect(html).toBe("Immune system mapping");
  });

  it("escapes regex metacharacters in a token (no ReDoS / no crash)", () => {
    const { html } = markTitleQueryTerms("c++ growth", ["c++"]);
    // '++' is escaped, so the literal token does not blow up the regex.
    expect(typeof html).toBe("string");
  });

  it("empty token set ⇒ unchanged title, matched false", () => {
    expect(markTitleQueryTerms("Anything", [])).toEqual({ html: "Anything", matched: false });
  });
});
