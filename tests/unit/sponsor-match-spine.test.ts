/**
 * Pure spine composition helpers (handoff §4/§6): dictionary term extraction and
 * weighted RRF. No db/network.
 */
import { describe, expect, it } from "vitest";
import { extractTerms, rrfFuse } from "@/lib/api/sponsor-match-spine";

describe("extractTerms (v1 dictionary match)", () => {
  const vocab = ["CRISPR", "machine learning", "PCR", "cell", "t-test", "a.b"];

  it("matches whole-word/phrase vocab entries, case-insensitively, in vocab order", () => {
    const paste = "We apply machine learning and crispr; PCR too.";
    expect(extractTerms(paste, vocab)).toEqual(["CRISPR", "machine learning", "PCR"]);
  });

  it("respects word boundaries — 'cell' does not match inside 'excellent'", () => {
    expect(extractTerms("excellent results", vocab)).toEqual([]);
    expect(extractTerms("single cell assay", vocab)).toEqual(["cell"]);
  });

  it("escapes regex metacharacters so a term matches literally, not as a pattern", () => {
    expect(extractTerms("value axb here", vocab)).toEqual([]); // 'a.b' must not match 'axb'
    expect(extractTerms("value a.b here", vocab)).toEqual(["a.b"]);
  });

  it("matches hyphenated terms and dedups repeated occurrences", () => {
    expect(extractTerms("a t-test, another t-test", vocab)).toEqual(["t-test"]);
  });

  it("returns [] for empty paste, empty vocab, or blank vocab entries", () => {
    expect(extractTerms("", vocab)).toEqual([]);
    expect(extractTerms("machine learning", [])).toEqual([]);
    expect(extractTerms("machine learning", ["", "  "])).toEqual([]);
  });
});

describe("rrfFuse (§4 weighted RRF)", () => {
  it("single term: preserves rank order, score decays with rank", () => {
    const out = rrfFuse([{ weight: 2, ranked: ["x", "y", "z"] }]);
    expect(out.map((r) => r.cwid)).toEqual(["x", "y", "z"]);
    expect(out[0].score).toBeCloseTo(2 / 61);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it("fuses across terms — a scholar present in two terms outranks single-term peers", () => {
    const out = rrfFuse([
      { weight: 1, ranked: ["A", "B", "C"] },
      { weight: 1, ranked: ["B"] },
    ]);
    expect(out[0].cwid).toBe("B"); // 1/62 + 1/61 beats A's 1/61
  });

  it("weight scales a term's contribution", () => {
    const out = rrfFuse([
      { weight: 10, ranked: ["X"] },
      { weight: 1, ranked: ["Y"] },
    ]);
    expect(out.map((r) => r.cwid)).toEqual(["X", "Y"]); // 10/61 > 1/61
  });

  it("zero-weight term (ubiquitous concept) contributes no score", () => {
    const out = rrfFuse([
      { weight: 0, ranked: ["A", "B"] },
      { weight: 1, ranked: ["B"] },
    ]);
    expect(out[0].cwid).toBe("B");
    expect(out.find((r) => r.cwid === "A")!.score).toBe(0);
  });

  it("breaks ties by earliest first appearance (stable)", () => {
    // A and B tie (each ranked #1 in one equal-weight term); A seen first.
    const out = rrfFuse([
      { weight: 1, ranked: ["A"] },
      { weight: 1, ranked: ["B"] },
    ]);
    expect(out.map((r) => r.cwid)).toEqual(["A", "B"]);
    expect(out[0].score).toBeCloseTo(out[1].score);
  });

  it("K flattens the head — larger K shrinks the top scholar's score", () => {
    const small = rrfFuse([{ weight: 1, ranked: ["a"] }], 10)[0].score;
    const large = rrfFuse([{ weight: 1, ranked: ["a"] }], 1000)[0].score;
    expect(small).toBeGreaterThan(large);
  });

  it("returns [] for no rankings or all-empty rankings", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([{ weight: 1, ranked: [] }])).toEqual([]);
  });
});
