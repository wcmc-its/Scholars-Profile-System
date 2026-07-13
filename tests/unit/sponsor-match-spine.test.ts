/**
 * Pure spine composition helpers (handoff §4/§6): dictionary term extraction and
 * weighted RRF. No db/network.
 */
import { describe, expect, it } from "vitest";
import { extractTerms, rrfFuse } from "@/lib/api/sponsor-match-spine";
import { DEFAULT_K } from "@/lib/api/sponsor-match-contract";

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
    const out = rrfFuse([{ term: "t1", weight: 2, ranked: ["x", "y", "z"] }]);
    expect(out.map((r) => r.cwid)).toEqual(["x", "y", "z"]);
    // Derived from DEFAULT_K, not hardcoded — this assertion pinned 2/61 and went stale the
    // moment K moved 60 → 8. The invariant is `weight / (K + rank)`, not the literal.
    expect(out[0].score).toBeCloseTo(2 / (DEFAULT_K + 1));
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it("fuses across terms — a scholar present in two terms outranks single-term peers", () => {
    const out = rrfFuse([
      { term: "t1", weight: 1, ranked: ["A", "B", "C"] },
      { term: "t2", weight: 1, ranked: ["B"] },
    ]);
    expect(out[0].cwid).toBe("B"); // 1/62 + 1/61 beats A's 1/61
  });

  it("weight scales a term's contribution", () => {
    const out = rrfFuse([
      { term: "t1", weight: 10, ranked: ["X"] },
      { term: "t2", weight: 1, ranked: ["Y"] },
    ]);
    expect(out.map((r) => r.cwid)).toEqual(["X", "Y"]); // 10/61 > 1/61
  });

  it("zero-weight term (ubiquitous concept) contributes no score", () => {
    const out = rrfFuse([
      { term: "t1", weight: 0, ranked: ["A", "B"] },
      { term: "t2", weight: 1, ranked: ["B"] },
    ]);
    expect(out[0].cwid).toBe("B");
    expect(out.find((r) => r.cwid === "A")!.score).toBe(0);
  });

  it("breaks ties by earliest first appearance (stable)", () => {
    // A and B tie (each ranked #1 in one equal-weight term); A seen first.
    const out = rrfFuse([
      { term: "t1", weight: 1, ranked: ["A"] },
      { term: "t2", weight: 1, ranked: ["B"] },
    ]);
    expect(out.map((r) => r.cwid)).toEqual(["A", "B"]);
    expect(out[0].score).toBeCloseTo(out[1].score);
  });

  it("K flattens the head — larger K shrinks the top scholar's score", () => {
    const small = rrfFuse([{ term: "t", weight: 1, ranked: ["a"] }], 10)[0].score;
    const large = rrfFuse([{ term: "t", weight: 1, ranked: ["a"] }], 1000)[0].score;
    expect(small).toBeGreaterThan(large);
  });

  it("returns [] for no rankings or all-empty rankings", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([{ term: "t", weight: 1, ranked: [] }])).toEqual([]);
  });

  // The UI contract's hinge, at its source. These ranks are what let the console re-rank
  // in the browser; drop them and the sliders have to re-query on every drag.
  it("reports every (term, rank) a scholar appeared under — including weak ones", () => {
    const out = rrfFuse([
      { term: "cancer", weight: 1, ranked: ["A", "B"] },
      { term: "fibrosis", weight: 1, ranked: ["C", "B"] },
    ]);
    const b = out.find((r) => r.cwid === "B")!;
    expect(b.contributions).toEqual([
      { term: "cancer", rank: 2 },
      { term: "fibrosis", rank: 2 },
    ]);
    expect(out.find((r) => r.cwid === "A")!.contributions).toEqual([
      { term: "cancer", rank: 1 },
    ]);
  });

  it("keeps a zero-weight term's contributions (a slider can revive it)", () => {
    // Weight 0 today, but the concept is still in the rail: slide its centrality up and
    // A must be able to climb. That is only possible if its rank survived the response.
    const out = rrfFuse([
      { term: "muted", weight: 0, ranked: ["A"] },
      { term: "live", weight: 1, ranked: ["B"] },
    ]);
    expect(out.find((r) => r.cwid === "A")!.contributions).toEqual([
      { term: "muted", rank: 1 },
    ]);
  });
});
