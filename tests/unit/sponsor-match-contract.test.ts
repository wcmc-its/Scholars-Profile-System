/**
 * The UI ⇄ ranker contract. These tests exist because PR #1673 broke the seam and prose
 * could not fail CI.
 *
 * The load-bearing one is "reproduces the server's order at default weights": it fuses a
 * candidate set with the SERVER's `rrfFuse` and re-ranks the same set with the CLIENT's
 * `rerankCandidates`, and asserts the orders match. If anyone changes K on one side, or
 * drops `contributions` back to a scalar score, or re-derives the weight differently, that
 * test goes red — which is the whole point of the file.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_K,
  conceptWeight,
  fitTier,
  fusedScore,
  matchedConcepts,
  rareTerms,
  rerankCandidates,
  type SponsorCandidate,
  type SponsorConcept,
} from "@/lib/api/sponsor-match-contract";
import { rrfFuse, type TermRanking } from "@/lib/api/sponsor-match-spine";

function concept(term: string, centrality: number, weightFactor: number): SponsorConcept {
  return { term, kind: "concept", members: [term], centrality, weightFactor };
}

function candidate(
  cwid: string,
  contributions: { term: string; rank: number }[],
  fused = 0,
): SponsorCandidate {
  return {
    cwid,
    name: cwid,
    profileSlug: cwid,
    title: null,
    department: null,
    fusedScore: fused,
    contributions,
    technologyCount: 0,
  };
}

describe("fusedScore", () => {
  it("sums weight/(K + rank) over the candidate's contributions", () => {
    const c = candidate("a", [
      { term: "sclerosis", rank: 1 },
      { term: "fibrosis", rank: 10 },
    ]);
    const weights = new Map([
      ["sclerosis", 2],
      ["fibrosis", 1],
    ]);
    expect(fusedScore(c, weights)).toBeCloseTo(
      2 / (DEFAULT_K + 1) + 1 / (DEFAULT_K + 10),
      12,
    );
  });

  it("scores a contribution whose concept left the rail as zero, not NaN", () => {
    const c = candidate("a", [{ term: "dropped", rank: 1 }]);
    expect(fusedScore(c, new Map())).toBe(0);
  });

  it("leaves the preference term inert when no prefBoost is supplied", () => {
    const c = candidate("a", [{ term: "t", rank: 1 }]);
    const weights = new Map([["t", 1]]);
    expect(fusedScore(c, weights)).toBe(fusedScore(c, weights, { lambda: 99 }));
  });

  it("applies (1 + λ·prefBoost) when a prefBoost is supplied", () => {
    const c = candidate("a", [{ term: "t", rank: 1 }]);
    const weights = new Map([["t", 1]]);
    const base = 1 / (DEFAULT_K + 1);
    expect(fusedScore(c, weights, { prefBoost: () => 1, lambda: 0.5 })).toBeCloseTo(
      base * 1.5,
      12,
    );
  });
});

describe("rerankCandidates", () => {
  /**
   * THE CONTRACT. The server fuses; the client re-ranks the fetched candidates at the
   * same (default) weights; the orders must be identical. This is what lets the rail
   * promise "sliders re-rank live over the already-fetched candidates — no new search".
   */
  it("reproduces the server's fused order at default weights", () => {
    const concepts = [concept("sclerosis", 1, 4), concept("fibrosis", 0.5, 2)];

    // The server side: per-concept searchPeople rankings, fused on rank.
    const rankings: TermRanking[] = [
      { term: "sclerosis", weight: conceptWeight(concepts[0]), ranked: ["a", "b", "c"] },
      { term: "fibrosis", weight: conceptWeight(concepts[1]), ranked: ["c", "a", "d"] },
    ];
    const fused = rrfFuse(rankings);

    // The wire shape the route ships, built from that same fusion.
    const candidates = fused.map((f) =>
      candidate(f.cwid, f.contributions, f.score),
    );

    // The client side: recompute from the decomposed inputs alone.
    const reranked = rerankCandidates(candidates, concepts);

    expect(reranked.map((c) => c.cwid)).toEqual(fused.map((f) => f.cwid));
    for (const [i, c] of reranked.entries()) {
      expect(c.fusedScore).toBeCloseTo(fused[i].score, 12);
    }
  });

  it("reorders when a slider moves — without any new data", () => {
    // `b` only ranks under "fibrosis"; `a` only under "sclerosis". Boosting fibrosis and
    // sinking sclerosis must flip them, using nothing but the already-fetched payload.
    const candidates = [
      candidate("a", [{ term: "sclerosis", rank: 1 }]),
      candidate("b", [{ term: "fibrosis", rank: 1 }]),
    ];
    const before = [concept("sclerosis", 1, 4), concept("fibrosis", 0.1, 4)];
    const after = [concept("sclerosis", 0.05, 4), concept("fibrosis", 1, 4)];

    expect(rerankCandidates(candidates, before).map((c) => c.cwid)).toEqual(["a", "b"]);
    expect(rerankCandidates(candidates, after).map((c) => c.cwid)).toEqual(["b", "a"]);
  });

  it("breaks ties on the incoming order (preserving the ranker's tie-break)", () => {
    const concepts = [concept("t", 1, 1)];
    const candidates = [
      candidate("first", [{ term: "t", rank: 5 }]),
      candidate("second", [{ term: "t", rank: 5 }]),
    ];
    expect(rerankCandidates(candidates, concepts).map((c) => c.cwid)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not mutate the candidates it was given", () => {
    const candidates = [candidate("a", [{ term: "t", rank: 1 }], 0)];
    rerankCandidates(candidates, [concept("t", 1, 1)]);
    expect(candidates[0].fusedScore).toBe(0);
  });

  /**
   * An engine with no concept decomposition (the bespoke ranker, which the route falls back
   * to whenever SPONSOR_MATCH_SPINE is off) ships `concepts: []` and `contributions: []`,
   * carrying its real BM25 score in `fusedScore`. Applying the formula to that sums an empty
   * contributions list to 0 for EVERY candidate and overwrites the server's score with it.
   * The order survives (everything ties, and ties keep the incoming order), so the list looks
   * perfectly correct — while `fitTier` sees topScore 0 and badges every row, top hit
   * included, "Weak fit". Silent, and exactly the kind of bug a green test suite hides.
   */
  it("is a NO-OP on an empty concept set — it must not wipe the engine's own score", () => {
    const bespoke = [candidate("a", [], 0.91), candidate("b", [], 0.42)];
    const out = rerankCandidates(bespoke, []);

    expect(out.map((c) => c.fusedScore)).toEqual([0.91, 0.42]);
    expect(out.map((c) => c.cwid)).toEqual(["a", "b"]);
    // …and therefore the tier still discriminates, instead of collapsing to all-weak.
    expect(fitTier(out[0].fusedScore, out[0].fusedScore)).toBe("strong");
    expect(fitTier(out[1].fusedScore, out[0].fusedScore)).toBe("good");
  });
});

describe("matchedConcepts", () => {
  it("orders a candidate's chips by their real contribution to its score", () => {
    // "weak" is the better rank, but "strong" carries far more weight — weight wins.
    const concepts = [concept("strong", 1, 10), concept("weak", 0.1, 1)];
    const c = candidate("a", [
      { term: "weak", rank: 1 },
      { term: "strong", rank: 20 },
    ]);
    expect(matchedConcepts(c, concepts).map((m) => m.concept.term)).toEqual([
      "strong",
      "weak",
    ]);
  });

  it("omits a concept slid to zero weight", () => {
    const concepts = [concept("live", 1, 1), concept("zeroed", 0, 1)];
    const c = candidate("a", [
      { term: "live", rank: 1 },
      { term: "zeroed", rank: 1 },
    ]);
    expect(matchedConcepts(c, concepts).map((m) => m.concept.term)).toEqual(["live"]);
  });
});

describe("fitTier", () => {
  it("buckets relative to the top score", () => {
    expect(fitTier(10, 10)).toBe("strong");
    expect(fitTier(7, 10)).toBe("strong");
    expect(fitTier(5, 10)).toBe("good");
    expect(fitTier(1, 10)).toBe("weak");
  });

  it("calls everything weak when nothing matched", () => {
    expect(fitTier(0, 0)).toBe("weak");
  });
});

describe("rareTerms", () => {
  /** A concept carrying a measured corpus coverage (the display-only field). */
  function covered(term: string, corpusCoverage: number): SponsorConcept {
    return { term, kind: "concept", members: [term], centrality: 1, weightFactor: 1, corpusCoverage };
  }

  // The real scleroderma ask (FINDING 2026-07-12 §4). Every one of these is "rare" on any
  // absolute threshold — they span 4.9e-5 to 1.5e-3 — which is exactly why the badge is
  // computed RELATIVE to the ask. An absolute cutoff would badge all seven and say nothing.
  it("badges only the concepts that are scarce RELATIVE to the ask", () => {
    const scleroderma = [
      covered("Myofibroblasts", 4.85e-5),
      covered("Fibrosis", 2.21e-4),
      covered("Scleroderma, Systemic", 7.17e-4),
      covered("Lung Diseases, Interstitial", 7.65e-4),
      covered("Autoantibodies", 1.54e-3),
    ];
    // Only Myofibroblasts is ≥ an order of magnitude scarcer than the most-covered concept.
    expect([...rareTerms(scleroderma)]).toEqual(["Myofibroblasts"]);
  });

  it("never badges a concept whose coverage is unknown (absent ≠ common)", () => {
    const concepts = [
      concept("unknown coverage", 1, 1), // no corpusCoverage at all
      covered("common", 1e-3),
      covered("scarce", 1e-5),
    ];
    const rare = rareTerms(concepts);
    expect(rare.has("unknown coverage")).toBe(false);
    expect(rare.has("scarce")).toBe(true);
  });

  it("badges nothing when there is no peer to be relative to", () => {
    expect(rareTerms([covered("alone", 1e-9)]).size).toBe(0);
    expect(rareTerms([]).size).toBe(0);
  });

  // The structural guarantee: the badge is a claim about the LITERATURE, and the ranking
  // weight is a claim about the RANKING. Moving weightFactor must not move the badge —
  // otherwise we are back to the misleading badge the finding called out.
  it("is independent of weightFactor", () => {
    const a: SponsorConcept[] = [
      { term: "x", kind: "concept", members: ["x"], centrality: 1, weightFactor: 1, corpusCoverage: 1e-5 },
      { term: "y", kind: "concept", members: ["y"], centrality: 1, weightFactor: 1, corpusCoverage: 1e-3 },
    ];
    const b: SponsorConcept[] = a.map((c) => ({ ...c, weightFactor: 999, centrality: 0.01 }));
    expect(rareTerms(b)).toEqual(rareTerms(a));
  });
});
