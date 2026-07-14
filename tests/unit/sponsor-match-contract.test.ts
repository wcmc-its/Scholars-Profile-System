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
  matchedEvidence,
  rareTerms,
  rerankCandidates,
  sponsorAskFrom,
  type SponsorCandidate,
  type SponsorConcept,
  type SponsorPreference,
  type SponsorSearchEvidence,
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

describe("matchedEvidence (#1696)", () => {
  /** The spine's per-concept evidence, reduced to what this join cares about. */
  function ev(term: string): SponsorSearchEvidence {
    return {
      term,
      evidence: {
        kind: "publications",
        strength: "tagged",
        text: `n of m publications tagged ${term}`,
        term,
        count: 1,
      },
      pubCount: 10,
      keyPaper: { descriptorUis: [`D_${term}`], contentQuery: term },
    };
  }

  const THREE = [concept("target", 1, 1), concept("mech", 0.5, 1), concept("aside", 0.2, 1)];

  it("renders one block per matched concept, ordered like the chips", () => {
    const c: SponsorCandidate = {
      ...candidate("a", [
        { term: "aside", rank: 1 },
        { term: "target", rank: 4 },
        { term: "mech", rank: 2 },
      ]),
      // Wire order is best-rank-first, as the spine ships it.
      searchEvidence: [ev("aside"), ev("mech"), ev("target")],
    };
    // …but the BLOCKS follow the live weighting, exactly as the chips do: "aside" is ranked #1
    // and still comes last, because at centrality 0.2 it is not why this person is here.
    expect(matchedEvidence(c, THREE).map((m) => m.concept.term)).toEqual([
      "target",
      "mech",
      "aside",
    ]);
    expect(matchedConcepts(c, THREE).map((m) => m.concept.term)).toEqual([
      "target",
      "mech",
      "aside",
    ]);
    // The evidence travels with its own concept — a block captioned "target" must not carry
    // "mech"'s key-paper config, or its disclosure would reveal papers about the wrong thing.
    expect(matchedEvidence(c, THREE)[0].evidence.keyPaper.descriptorUis).toEqual(["D_target"]);
  });

  it("emits NO block for a concept with no evidence — absent is not an empty block", () => {
    const c: SponsorCandidate = {
      ...candidate("a", [
        { term: "target", rank: 1 },
        { term: "mech", rank: 2 },
      ]),
      searchEvidence: [ev("target")], // "mech" produced none — no tagged count to read
    };
    expect(matchedEvidence(c, THREE).map((m) => m.concept.term)).toEqual(["target"]);
    // The CHIP survives (the candidate did rank under "mech" — that is a fact about the
    // retrieval); only the evidence BLOCK is absent. The two lists are allowed to differ in
    // exactly this direction, and never the other.
    expect(matchedConcepts(c, THREE).map((m) => m.concept.term)).toEqual(["target", "mech"]);
  });

  it("drops a muted concept's block along with its chip", () => {
    // The card must not go on captioning "mech" as a reason after the officer has said the
    // sponsor does not care about it — the block would contradict the ranking beside it.
    const muted = [concept("target", 1, 1), concept("mech", 0, 1)];
    const c: SponsorCandidate = {
      ...candidate("a", [
        { term: "target", rank: 1 },
        { term: "mech", rank: 2 },
      ]),
      searchEvidence: [ev("target"), ev("mech")],
    };
    expect(matchedEvidence(c, muted).map((m) => m.concept.term)).toEqual(["target"]);
  });

  it("is [] for a candidate the spine gave no evidence at all", () => {
    // Absent, not an empty block: the panel renders nothing rather than an empty disclosure,
    // which would read as "this match has no evidence" — a claim nobody made.
    const c = candidate("a", [{ term: "target", rank: 1 }]);
    expect(c.searchEvidence).toBeUndefined();
    expect(matchedEvidence(c, THREE)).toEqual([]);
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

/**
 * `sponsorAskFrom` — the search's handle.
 *
 * These exist to pin a DESIGN decision, not just behaviour: the title is derived from the
 * concepts the extractor already produced, NOT generated by a second LLM call. The spec asked
 * for a "cheap Bedrock call", but the task role's IAM grant admits only Opus and Sonnet
 * (Haiku is excluded on purpose), so "cheap" was not on offer — it would have been a second
 * Sonnet call, on an unmetered route, to name something the extractor had already told us.
 * If a future change reintroduces the call, these tests should be deleted deliberately, not
 * quietly made to pass.
 */
describe("sponsorAskFrom", () => {
  const prefs: SponsorPreference[] = [
    {
      label: "Early career",
      evidence: "…reserved for early-career investigators…",
      importance: 1,
      measure: "careerStage",
      stages: ["early"],
    },
  ];

  it("names the search after its top concepts", () => {
    const ask = sponsorAskFrom([
      concept("cardiac fibrosis", 0.9, 1),
      concept("myofibroblast differentiation", 0.8, 1),
    ]);
    expect(ask?.title).toBe("cardiac fibrosis, myofibroblast differentiation");
  });

  it("stops at two concepts — more is a list, not a handle", () => {
    const ask = sponsorAskFrom([
      concept("a", 0.9, 1),
      concept("b", 0.8, 1),
      concept("c", 0.7, 1),
      concept("d", 0.6, 1),
    ]);
    expect(ask?.title).toBe("a, b");
  });

  it("appends the non-topical ask when the sponsor stated one", () => {
    const ask = sponsorAskFrom([concept("cardiac fibrosis", 0.9, 1)], prefs);
    expect(ask?.title).toBe("cardiac fibrosis · Early career");
  });

  it("quotes the preference's OWN paste provenance rather than generating one", () => {
    const ask = sponsorAskFrom([concept("cardiac fibrosis", 0.9, 1)], prefs);
    expect(ask?.quote).toBe(prefs[0].evidence);
  });

  it("is ABSENT when there are no concepts — never an empty-string title", () => {
    // Absent ≠ empty, the contract's rule. The bespoke engine returns `concepts: []`, so this
    // is the live path, not a hypothetical: it must yield no header at all.
    expect(sponsorAskFrom([], prefs)).toBeUndefined();
  });
});
