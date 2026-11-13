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
  conceptCoverage,
  conceptWeight,
  evidenceMatchCount,
  latestEvidenceYear,
  evidenceProvenance,
  candidateFitTier,
  fitTier,
  fusedScore,
  recencyWeight,
  staleBefore,
  hiddenBefore,
  RECENCY_FLOOR,
  RECENCY_HALF_LIFE_YEARS,
  hasMatchEvidence,
  matchedConcepts,
  matchedEvidence,
  rareTerms,
  rerankCandidates,
  askTitleFrom,
  researcherTypeFrom,
  isMedicalDegree,
  matchaMeasuresFrom,
  assessMatchSignal,
  sanitizeIncludeTerms,
  INCLUDE_MAX,
  INCLUDE_TERM_MAXLEN,
  type MatchaCandidate,
  type MatchaConcept,
  type MatchaPreference,
  type MatchaSearchEvidence,
} from "@/lib/api/matcha-contract";
import type { ResultEvidence } from "@/lib/api/result-evidence";
import { rrfFuse, type TermRanking } from "@/lib/api/matcha-spine";

function concept(term: string, centrality: number, weightFactor: number): MatchaConcept {
  return { term, kind: "concept", members: [term], centrality, weightFactor };
}

function candidate(
  cwid: string,
  contributions: { term: string; rank: number }[],
  fused = 0,
): MatchaCandidate {
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
   * to whenever MATCHA_SPINE is off) ships `concepts: []` and `contributions: []`,
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
  function ev(term: string): MatchaSearchEvidence {
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
    const c: MatchaCandidate = {
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
    const c: MatchaCandidate = {
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
    const c: MatchaCandidate = {
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

describe("conceptCoverage", () => {
  function ev(term: string): MatchaSearchEvidence {
    return {
      term,
      evidence: { kind: "publications", strength: "tagged", text: "t", term, count: 1 },
      pubCount: 10,
      keyPaper: { descriptorUis: [`D_${term}`], contentQuery: term },
    };
  }

  const ASK = [concept("target", 1, 1), concept("mech", 0.8, 1), concept("gap", 0.5, 1)];

  it("reports the GAP — an asked concept the candidate never ranked under", () => {
    const c: MatchaCandidate = {
      ...candidate("a", [{ term: "target", rank: 1 }]),
      searchEvidence: [ev("target")],
    };
    // The whole point: three concepts asked, one answered. `matchedConcepts` can only ever
    // return the one, so nothing on the card could say the other two are missing.
    expect(conceptCoverage(c, ASK).map((s) => [s.concept.term, s.state])).toEqual([
      ["target", "evidence"],
      ["mech", "none"],
      ["gap", "none"],
    ]);
  });

  it("distinguishes 'ranked, no block shipped' from 'no evidence' — they are NOT a ramp", () => {
    // `mech` ranked but the spine shipped no block for it (it caps at MAX_EVIDENCE_CONCEPTS by
    // strength at DEFAULT weights). That is reachable by dragging a slider, and it must never
    // collapse into the same state as `gap`, which the candidate simply does not have.
    const c: MatchaCandidate = {
      ...candidate("a", [
        { term: "target", rank: 1 },
        { term: "mech", rank: 2 },
      ]),
      searchEvidence: [ev("target")],
    };
    const byTerm = new Map(conceptCoverage(c, ASK).map((s) => [s.concept.term, s.state]));
    expect(byTerm.get("target")).toBe("evidence");
    expect(byTerm.get("mech")).toBe("ranked");
    expect(byTerm.get("gap")).toBe("none");
  });

  it("`evidence` means a block RENDERS — evidence for a concept never ranked under is not one", () => {
    // Guards the strip against promising a block that `matchedEvidence` will not produce: it
    // derives from `matchedConcepts` (contributions), so wire evidence alone is not enough.
    const c: MatchaCandidate = {
      ...candidate("a", [{ term: "target", rank: 1 }]),
      searchEvidence: [ev("target"), ev("gap")],
    };
    expect(matchedEvidence(c, ASK).map((b) => b.concept.term)).toEqual(["target"]);
    const byTerm = new Map(conceptCoverage(c, ASK).map((s) => [s.concept.term, s.state]));
    expect(byTerm.get("gap")).toBe("none");
  });

  it("drops muted concepts entirely — absent, not a gap", () => {
    // An officer who slid a concept to zero has said they do not care about it. Reporting that
    // this person lacks it would be the card arguing with the rail.
    const c = candidate("a", [{ term: "target", rank: 1 }]);
    const muted = [concept("target", 1, 1), concept("gap", 0, 1)];
    expect(conceptCoverage(c, muted).map((s) => s.concept.term)).toEqual(["target"]);
  });

  it("orders by ask weight, so the strip re-draws as the sliders move", () => {
    const c = candidate("a", []);
    const before = conceptCoverage(c, ASK).map((s) => s.concept.term);
    expect(before).toEqual(["target", "mech", "gap"]);

    // Slide `gap` to the top of the ask; the segment order must follow it.
    const after = conceptCoverage(c, [ASK[0], ASK[1], concept("gap", 1, 3)]);
    expect(after[0].concept.term).toBe("gap");
    expect(after[0].weight).toBeCloseTo(conceptWeight(concept("gap", 1, 3)));
  });

  it("a candidate with no searchEvidence at all yields no `evidence` state", () => {
    // `searchEvidence` is ABSENT, never []. Gate on the term's presence, not the array's.
    const c = candidate("a", [{ term: "target", rank: 1 }]);
    expect(conceptCoverage(c, ASK)[0]).toMatchObject({ state: "ranked" });
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
  function covered(term: string, corpusCoverage: number): MatchaConcept {
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
    const a: MatchaConcept[] = [
      { term: "x", kind: "concept", members: ["x"], centrality: 1, weightFactor: 1, corpusCoverage: 1e-5 },
      { term: "y", kind: "concept", members: ["y"], centrality: 1, weightFactor: 1, corpusCoverage: 1e-3 },
    ];
    const b: MatchaConcept[] = a.map((c) => ({ ...c, weightFactor: 999, centrality: 0.01 }));
    expect(rareTerms(b)).toEqual(rareTerms(a));
  });
});

/**
 * `askTitleFrom` — the search's handle.
 *
 * These exist to pin a DESIGN decision, not just behaviour: the title PREFERS the essence
 * handle the extractor wrote in the SAME call that read the concepts (`titleSummary`), and
 * falls back to the concept list when it is absent — but this function itself makes NO LLM
 * call. The spec asked for a "cheap Bedrock call" to write a title; the task role's IAM grant
 * admits only Opus and Sonnet (Haiku is excluded on purpose), so "cheap" was not on offer — a
 * SEPARATE title call would be a second Sonnet call on an unmetered route. If a future change
 * reintroduces a separate call, these tests should be deleted deliberately, not quietly made
 * to pass.
 */
describe("askTitleFrom", () => {
  const prefs: MatchaPreference[] = [
    {
      label: "Early career",
      evidence: "…reserved for early-career investigators…",
      importance: 1,
      measure: "careerStage",
      stages: ["early"],
    },
  ];

  it("names the search after its top concepts", () => {
    const ask = askTitleFrom([
      concept("cardiac fibrosis", 0.9, 1),
      concept("myofibroblast differentiation", 0.8, 1),
    ]);
    expect(ask?.title).toBe("Cardiac fibrosis, myofibroblast differentiation");
  });

  it("stops at two concepts — more is a list, not a handle", () => {
    const ask = askTitleFrom([
      concept("a", 0.9, 1),
      concept("b", 0.8, 1),
      concept("c", 0.7, 1),
      concept("d", 0.6, 1),
    ]);
    expect(ask?.title).toBe("A, b");
  });

  it("appends the non-topical ask when the sponsor stated one", () => {
    const ask = askTitleFrom([concept("cardiac fibrosis", 0.9, 1)], prefs);
    expect(ask?.title).toBe("Cardiac fibrosis · Early career");
  });

  it("is ABSENT when there are no concepts — never an empty-string title", () => {
    // Absent ≠ empty, the contract's rule. The bespoke engine returns `concepts: []`, so this
    // is the live path, not a hypothetical: it must yield no header at all.
    expect(askTitleFrom([], prefs)).toBeUndefined();
  });

  it("prefers the extractor's titleSummary over the derived concept list", () => {
    const ask = askTitleFrom(
      [concept("cardiac fibrosis", 0.9, 1), concept("myofibroblast differentiation", 0.8, 1)],
      [],
      "Acme Bio — cardiac fibrosis reversal",
    );
    expect(ask?.title).toBe("Acme Bio — cardiac fibrosis reversal");
  });

  it("appends preference chips to the titleSummary base, same as the concept-list base", () => {
    const ask = askTitleFrom([concept("cardiac fibrosis", 0.9, 1)], prefs, "Acme Bio — cardiac fibrosis");
    expect(ask?.title).toBe("Acme Bio — cardiac fibrosis · Early career");
  });

  it("falls back to the concept list when titleSummary is blank, and titles even a zero-concept search when the extractor named one", () => {
    // A whitespace-only summary is not a title — derive from concepts instead.
    expect(askTitleFrom([concept("cardiac fibrosis", 0.9, 1)], [], "   ")?.title).toBe(
      "Cardiac fibrosis",
    );
    // The bespoke path has no title; but if a summary is present with no concepts, name it.
    expect(askTitleFrom([], [], "Acme Bio — rare disease")?.title).toBe("Acme Bio — rare disease");
  });

  it('prefixes the requester as "{requester} — {focus}"', () => {
    const ask = askTitleFrom(
      [concept("obesity", 0.9, 1)],
      prefs,
      "Metabolic disease and obesity",
      "Northlake Therapeutics",
    );
    expect(ask?.title).toBe(
      "Northlake Therapeutics — Metabolic disease and obesity · Early career",
    );
  });

  it("without a requester the title is the focus alone", () => {
    expect(askTitleFrom([], [], "CAR-T persistence in solid tumors", null)?.title).toBe(
      "CAR-T persistence in solid tumors",
    );
    expect(askTitleFrom([], [], "CAR-T persistence in solid tumors", "  ")?.title).toBe(
      "CAR-T persistence in solid tumors",
    );
  });

  it("prefixes the requester onto the concept-list fallback; a mixed-case first word (mRNA) is not re-cased", () => {
    const ask = askTitleFrom(
      [concept("mRNA vaccines", 0.9, 1), concept("HER2-low breast cancer", 0.8, 1)],
      [],
      undefined,
      "Harborview Foundation",
    );
    expect(ask?.title).toBe("Harborview Foundation — mRNA vaccines, HER2-low breast cancer");
  });

  it("never double-prefixes an OLD stored titleSummary that already carries an org", () => {
    // Pre-requester results wrote "{Org} — {focus}" into titleSummary. A requester replaces it.
    expect(askTitleFrom([], [], "Acme Bio — cardiac fibrosis reversal", "Acme Bio")?.title).toBe(
      "Acme Bio — cardiac fibrosis reversal",
    );
    expect(
      askTitleFrom([], [], "Acme Bio — cardiac fibrosis reversal", "Quillfin Bio")?.title,
    ).toBe("Quillfin Bio — cardiac fibrosis reversal");
  });
});

/**
 * `assessMatchSignal` — self-awareness for a thin extraction.
 *
 * Fixtures are the real staging opportunities that motivated this (2026-08-19/20 sweep,
 * `docs/grant-matcha-challenging-cases.md`): a single "neoplasms" concept (200 descendants,
 * hit the cap) produced a scattered top-8; a single "drug discovery" concept (4 descendants —
 * genuinely narrow, NOT broad) also produced a scattered top-8, because it's a bare method
 * with nothing to narrow it; a single "colorectal cancer" (10 descendants, concept-kind) did
 * NOT show the same scatter — it's a real, specific single-concept match and must NOT be
 * flagged. The rule has to clear that bar, not just react to "one concept".
 */
describe("assessMatchSignal", () => {
  it("flags a single concept whose MeSH scope hit the descendant cap", () => {
    const signal = assessMatchSignal([
      { term: "neoplasms", kind: "concept", members: ["neoplasms"], centrality: 1, weightFactor: 1, meshDescendantCount: 200 },
    ]);
    expect(signal).toEqual({ thin: true, reason: "single-broad-concept" });
  });

  it("flags a single bare METHOD even when its MeSH scope is narrow", () => {
    const signal = assessMatchSignal([
      { term: "drug discovery", kind: "method", members: ["drug discovery"], centrality: 1, weightFactor: 1, meshDescendantCount: 4 },
    ]);
    expect(signal).toEqual({ thin: true, reason: "single-bare-method" });
  });

  it("does NOT flag a single, specific, narrow concept — the false-positive guard", () => {
    const signal = assessMatchSignal([
      { term: "colorectal cancer", kind: "concept", members: ["colorectal cancer"], centrality: 1, weightFactor: 1, meshDescendantCount: 10 },
    ]);
    expect(signal).toEqual({ thin: false });
  });

  it("does not flag a broad concept once a second concept is present — the others narrow it", () => {
    const signal = assessMatchSignal([
      concept("neoplasms", 1, 1),
      concept("cancer prevention", 0.5, 1),
    ]);
    expect(signal).toEqual({ thin: false });
  });

  it("treats an absent meshDescendantCount as 0, not broad — no MeSH resolution is not evidence of breadth", () => {
    const signal = assessMatchSignal([concept("some rare term", 1, 1)]);
    expect(signal).toEqual({ thin: false });
  });

  it("does not flag zero concepts — that's the separate empty-state case, not a thin match", () => {
    expect(assessMatchSignal([])).toEqual({ thin: false });
  });
});

describe("hasMatchEvidence — the zero-evidence exclusion", () => {
  const ev: MatchaSearchEvidence = {
    term: "t",
    evidence: { kind: "publications", strength: "tagged", text: "1 of 10 tagged t", term: "t", count: 1 },
    pubCount: 10,
    keyPaper: { descriptorUis: ["D_t"], contentQuery: "t" },
  };

  it("keeps a candidate the spine shipped a research-match block for", () => {
    expect(hasMatchEvidence({ ...candidate("a", []), searchEvidence: [ev] })).toBe(true);
  });

  it("excludes an empty searchEvidence array (matched nothing real)", () => {
    expect(hasMatchEvidence({ ...candidate("a", []), searchEvidence: [] })).toBe(false);
  });

  it("excludes an absent searchEvidence — absent is not zero, but it is not a match either", () => {
    // Pugh: ranked into a concept's top-100 on an identity-tail hit, no research evidence.
    expect(hasMatchEvidence(candidate("pugh", [{ term: "topo", rank: 231 }]))).toBe(false);
  });
});

describe("evidenceProvenance — structured tag vs bare keyword", () => {
  it("publications: mention is keyword-only, tagged/concept are structured", () => {
    const pub = (strength: "tagged" | "mention" | "concept"): ResultEvidence => ({
      kind: "publications",
      strength,
      text: "x",
    });
    expect(evidenceProvenance(pub("mention"))).toBe("keyword");
    expect(evidenceProvenance(pub("tagged"))).toBe("tagged");
    expect(evidenceProvenance(pub("concept"))).toBe("tagged");
  });

  it("curated method/clinical/topic are structured; a bio sentence is bare text", () => {
    expect(evidenceProvenance({ kind: "method", family: "scRNA-seq", tools: [] })).toBe("tagged");
    expect(evidenceProvenance({ kind: "clinical", specialty: "Cardiology", boardCertified: true })).toBe(
      "tagged",
    );
    expect(evidenceProvenance({ kind: "topic", label: "Immunology", id: "immuno" })).toBe("tagged");
    expect(evidenceProvenance({ kind: "selfDescription", html: "…" })).toBe("keyword");
  });

  it("no chip for the identity tail (backstop — the spine already filters these out)", () => {
    expect(evidenceProvenance({ kind: "none" })).toBeNull();
    expect(evidenceProvenance({ kind: "areas", labels: [], total: 0 })).toBeNull();
    expect(evidenceProvenance({ kind: "name", html: "…" })).toBeNull();
  });
});

describe("evidenceMatchCount — the matched N, never the total M", () => {
  it("reads the count-bearing kinds' own count", () => {
    expect(
      evidenceMatchCount({ kind: "publications", strength: "tagged", text: "11 of 480", count: 11 }),
    ).toBe(11);
    expect(evidenceMatchCount({ kind: "method", family: "x", tools: [], count: 4 })).toBe(4);
    expect(evidenceMatchCount({ kind: "topic", label: "x", id: "x", count: 7 })).toBe(7);
  });

  it("is null when the kind carries no count — the caller renders nothing, never the total", () => {
    expect(evidenceMatchCount({ kind: "publications", strength: "mention", text: "x" })).toBeNull();
    expect(evidenceMatchCount({ kind: "clinical", specialty: "Cardiology", boardCertified: false })).toBeNull();
    expect(evidenceMatchCount({ kind: "selfDescription", html: "…" })).toBeNull();
  });

  // Contract O9 — the supporting blocks on a Matcha card are DIFFERENT concepts from
  // different `searchPeople` calls, rendered into one shared `tabular-nums` column.
  // `publications` spans three strengths, so a strength-blind read puts a free-text
  // keyword count beside a curated MeSH count, unlabelled and visually commensurable.
  it("O9 — a COUNTED mention is still null: only `tagged` earns the shared column", () => {
    // The hazard case: a mention line that DOES carry a count. Strength-blind code
    // returns 6 here and prints it next to a tagged 2.
    expect(
      evidenceMatchCount({ kind: "publications", strength: "mention", text: "6 papers", count: 6 }),
    ).toBeNull();
    // `concept` carries no count at all — unknown, and never 0.
    const conceptCount = evidenceMatchCount({
      kind: "publications",
      strength: "concept",
      text: "neoplasms",
    });
    expect(conceptCount).toBeNull();
    expect(conceptCount).not.toBe(0);
    // The one strength that is comparable across candidates still reads through.
    expect(
      evidenceMatchCount({ kind: "publications", strength: "tagged", text: "2 of 40", count: 2 }),
    ).toBe(2);
    // A genuine measured zero is preserved — measured-and-found-none is not unknown.
    expect(
      evidenceMatchCount({ kind: "publications", strength: "tagged", text: "0 of 40", count: 0 }),
    ).toBe(0);
  });
});

describe("latestEvidenceYear — D8 compact-row 'latest YYYY'", () => {
  it("reads the spine path's `mostRecentYear` (D1) first", () => {
    expect(
      latestEvidenceYear({ ...candidate("a", [{ term: "t", rank: 1 }]), mostRecentYear: 2023 }),
    ).toBe(2023);
  });

  it("prefers `mostRecentYear` over the bespoke papers when both are present", () => {
    const c = {
      ...candidate("a", [{ term: "t", rank: 1 }]),
      mostRecentYear: 2025,
      evidence: { papers: [{ pmid: "1", title: "x", year: 2019, journal: null }] },
    };
    expect(latestEvidenceYear(c)).toBe(2025);
  });

  it("falls back to the max year across the bespoke path's papers, ignoring null years", () => {
    const c = {
      ...candidate("a", [{ term: "t", rank: 1 }]),
      evidence: { papers: [{ pmid: "1", title: "x", year: 2019, journal: null }, { pmid: "2", title: "y", year: 2024, journal: null }, { pmid: "3", title: "z", year: null, journal: null }] },
    };
    expect(latestEvidenceYear(c)).toBe(2024);
  });

  it("is null when neither a `mostRecentYear` nor dated papers are present (flag off)", () => {
    expect(latestEvidenceYear(candidate("a", [{ term: "t", rank: 1 }]))).toBeNull();
    expect(latestEvidenceYear({ ...candidate("a", [{ term: "t", rank: 1 }]), evidence: { papers: [] } })).toBeNull();
  });
});

describe("recencyWeight — D1 recency curve", () => {
  it("is neutral (1) when the candidate has no known year", () => {
    expect(recencyWeight(null, 2026)).toBe(1);
    expect(recencyWeight(undefined, 2026)).toBe(1);
  });

  it("is 1 at age 0 and floored below, monotonically decreasing with age", () => {
    expect(recencyWeight(2026, 2026)).toBeCloseTo(1, 12);
    // one half-life of age → FLOOR + (1-FLOOR)/2
    expect(recencyWeight(2026 - RECENCY_HALF_LIFE_YEARS, 2026)).toBeCloseTo(
      RECENCY_FLOOR + (1 - RECENCY_FLOOR) / 2,
      12,
    );
    // strictly decreasing, and never below the floor
    const w2 = recencyWeight(2020, 2026);
    const w20 = recencyWeight(2000, 2026);
    expect(w2).toBeGreaterThan(w20);
    expect(w20).toBeGreaterThan(RECENCY_FLOOR);
    expect(w20).toBeLessThan(1);
  });

  it("clamps a future year to age 0 (no boost above 1)", () => {
    expect(recencyWeight(2030, 2026)).toBe(1);
  });
});

describe("recencyWeight — D3 modes", () => {
  it('defaults to "recent" — the server\'s curve, so an untouched control reproduces its order', () => {
    expect(recencyWeight(2000, 2026)).toBe(recencyWeight(2000, 2026, "recent"));
  });

  it('"any" turns recency off — ×1 for everyone, however old', () => {
    expect(recencyWeight(1975, 2026, "any")).toBe(1);
    expect(recencyWeight(2026, 2026, "any")).toBe(1);
  });

  it('"since" is a SOFT step, not a filter: at/after the cutoff full weight, older floored', () => {
    expect(recencyWeight(2021, 2026, { since: 2020 })).toBe(1);
    expect(recencyWeight(2020, 2026, { since: 2020 })).toBe(1); // inclusive
    expect(recencyWeight(2019, 2026, { since: 2020 })).toBe(RECENCY_FLOOR);
    // floored, never zeroed — an older match still ranks (D4 is what hides)
    expect(recencyWeight(1975, 2026, { since: 2020 })).toBeGreaterThan(0);
  });

  it("a candidate with no year is neutral in every mode", () => {
    for (const m of ["any", "recent", { since: 2020 }] as const) {
      expect(recencyWeight(null, 2026, m)).toBe(1);
    }
  });
});

describe("staleBefore — D8's flag boundary, derived from the active mode", () => {
  it('"recent" → one half-life back (no second definition of "old")', () => {
    expect(staleBefore("recent", 2026)).toBe(2026 - RECENCY_HALF_LIFE_YEARS);
  });

  it('"since" → the officer\'s own cutoff', () => {
    expect(staleBefore({ since: 2015 }, 2026)).toBe(2015);
  });

  it('"any" → null: nothing weighs recency, so nothing may claim stale', () => {
    expect(staleBefore("any", 2026)).toBeNull();
  });
});

describe("hiddenBefore — D4's hard cutoff, and why it is NOT staleBefore", () => {
  it('"since" → the officer\'s cutoff: the one mode that may remove people', () => {
    expect(hiddenBefore({ since: 2020 })).toBe(2020);
  });

  it('"recent" → null: a SOFT preference must never delete', () => {
    // The trap this exists to prevent: staleBefore("recent") is a real year (currentYear−8), so a
    // filter keyed on staleBefore would make the DEFAULT dial position silently remove every
    // scholar 8 years out. Reading as old and being deleted are different questions.
    expect(hiddenBefore("recent")).toBeNull();
    expect(staleBefore("recent", 2026)).toBe(2018); // ← non-null, and deliberately not a cutoff
  });

  it('"any" → null: nothing weighs recency, so nothing is removed', () => {
    expect(hiddenBefore("any")).toBeNull();
  });

  it("the two agree ONLY under { since }, where the officer answered both questions at once", () => {
    expect(hiddenBefore({ since: 2015 })).toBe(staleBefore({ since: 2015 }, 2026));
  });
});

describe("rerankCandidates — D3 re-ranks live on the officer's dial", () => {
  it('"any" drops recency, restoring the pure topical order', () => {
    const concepts = [concept("t", 1, 1)];
    // "old" has the better topical rank; under the default curve recency sinks it below "recent".
    const oldC = { ...candidate("old", [{ term: "t", rank: 1 }]), mostRecentYear: 1999 };
    const recentC = { ...candidate("recent", [{ term: "t", rank: 6 }]), mostRecentYear: 2025 };

    expect(
      rerankCandidates([oldC, recentC], concepts, { currentYear: 2026 }).map((c) => c.cwid),
    ).toEqual(["recent", "old"]);
    // Dial to Any → topical fit alone → the better-ranked "old" leads again.
    expect(
      rerankCandidates([oldC, recentC], concepts, { currentYear: 2026, recency: "any" }).map(
        (c) => c.cwid,
      ),
    ).toEqual(["old", "recent"]);
  });

  it('"since" sinks everything below the cutoff to the floor', () => {
    const concepts = [concept("t", 1, 1)];
    const a = { ...candidate("a", [{ term: "t", rank: 1 }]), mostRecentYear: 2019 };
    const b = { ...candidate("b", [{ term: "t", rank: 3 }]), mostRecentYear: 2021 };
    const ranked = rerankCandidates([a, b], concepts, { currentYear: 2026, recency: { since: 2020 } });
    // `a` outranks `b` topically, but falls under the cutoff and is floored; `b` keeps full weight.
    expect(ranked.map((c) => c.cwid)).toEqual(["b", "a"]);
  });
});

describe("fusedScore — D1 recency factor", () => {
  it("multiplies the summed score by the per-scholar recency weight", () => {
    const weights = new Map([["t", 1]]);
    const base = candidate("a", [{ term: "t", rank: 1 }]);
    const old = { ...base, mostRecentYear: 2000 };
    expect(fusedScore(old, weights, { currentYear: 2026 })).toBeCloseTo(
      fusedScore(base, weights, { currentYear: 2026 }) * recencyWeight(2000, 2026),
      12,
    );
  });

  it("leaves a candidate with no year unchanged (byte-identical, flag off)", () => {
    const weights = new Map([["t", 1]]);
    const c = candidate("a", [{ term: "t", rank: 1 }]);
    expect(fusedScore(c, weights, { currentYear: 2026 })).toBeCloseTo(1 / (DEFAULT_K + 1), 12);
  });
});

describe("D1+D2 — recency re-ranks AND re-tiers (regression AC)", () => {
  /**
   * The handoff's D2 AC in mechanism form: an old-only candidate that would tier "Good" on its
   * topical base alone drops to "Weak" once recency is folded in, and a recent peer leads. Bases
   * are constructed so the old candidate sits at exactly half the recent one's score (share 0.5,
   * "good") BEFORE recency; the year is the only thing that pushes it under the 0.33 boundary.
   */
  it("an old-only candidate tiers Weak where a recent peer tiers Strong", () => {
    const concepts = [concept("t", 1, 1)]; // conceptWeight = 1^3 × 1 = 1
    // rank 1 vs rank 32 under K=30 → base share (K+1)/(K+32) = 31/62 = 0.5.
    const recentC = { ...candidate("recent", [{ term: "t", rank: 1 }]), mostRecentYear: 2024 };
    const oldC = { ...candidate("old", [{ term: "t", rank: 32 }]), mostRecentYear: 1999 };

    // Baseline (no years): the old candidate is "good", not "weak".
    const baseline = rerankCandidates(
      [candidate("recent", [{ term: "t", rank: 1 }]), candidate("old", [{ term: "t", rank: 32 }])],
      concepts,
      { currentYear: 2026 },
    );
    expect(fitTier(baseline[1].fusedScore, baseline[0].fusedScore)).toBe("good");

    // With recency: recent leads, and the old-only candidate falls to "weak".
    const ranked = rerankCandidates([oldC, recentC], concepts, { currentYear: 2026 });
    expect(ranked.map((c) => c.cwid)).toEqual(["recent", "old"]);
    const topScore = ranked[0].fusedScore;
    expect(fitTier(ranked[0].fusedScore, topScore)).toBe("strong");
    expect(fitTier(ranked[1].fusedScore, topScore)).toBe("weak");
  });
});

describe("sanitizeIncludeTerms (#1780 Phase 2 — the include[] trust boundary)", () => {
  it("returns [] for non-array / junk input", () => {
    expect(sanitizeIncludeTerms(undefined)).toEqual([]);
    expect(sanitizeIncludeTerms(null)).toEqual([]);
    expect(sanitizeIncludeTerms("iPSC")).toEqual([]);
    expect(sanitizeIncludeTerms({ 0: "iPSC" })).toEqual([]);
  });

  it("trims, drops empties and non-strings, and keeps real terms (sorted)", () => {
    expect(sanitizeIncludeTerms(["  iPSC  ", "", "   ", 42, null, "organoids"])).toEqual([
      "iPSC",
      "organoids",
    ]);
  });

  it("de-dups case-insensitively, keeping the first casing", () => {
    expect(sanitizeIncludeTerms(["iPSC", "IPSC", "ipsc"])).toEqual(["iPSC"]);
  });

  it("drops a term longer than INCLUDE_TERM_MAXLEN", () => {
    const long = "x".repeat(INCLUDE_TERM_MAXLEN + 1);
    expect(sanitizeIncludeTerms([long, "ok"])).toEqual(["ok"]);
  });

  it("caps the array at INCLUDE_MAX", () => {
    const many = Array.from({ length: INCLUDE_MAX + 5 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    expect(sanitizeIncludeTerms(many)).toHaveLength(INCLUDE_MAX);
  });
});

describe("researcherTypeFrom", () => {
  const NOW = new Date(Date.UTC(2026, 9, 30));
  const g = (mechanism: string | null, role: string, endYear: number) => ({
    mechanism,
    role,
    endDate: new Date(Date.UTC(endYear, 5, 30)),
  });
  const r01 = [g("R01", "PI", 2028)];
  const deg = (...degrees: string[]) => degrees.map((degree) => ({ degree }));

  // Every branch of the archetype decision, in the order it is decided.
  it.each([
    // Trainee roles without a qualifying PI award, whatever their papers say.
    ["doctoral student", { roleCategory: "doctoral_student_phd", labPubs5y: 5 }, "trainee"],
    ["postdoc", { roleCategory: "postdoc", educations: deg("PhD") }, "trainee"],
    ["fellow, physician", { roleCategory: "fellow", educations: deg("MD"), hasClinicalProfile: true }, "trainee"],
    // ...but a PI award lifts them out of "trainee" into the ordinary decision.
    ["postdoc with a PI award and lab papers", { roleCategory: "postdoc", grants: r01, labPubs5y: 3, educations: deg("PhD") }, "basic_scientist"],
    ["fellow with a PI award, no papers", { roleCategory: "fellow", grants: r01, educations: deg("MD") }, "funded_investigator"],
    // A research kind: physician or not.
    ["physician, lab", { educations: deg("M.D."), labPubs5y: 3 }, "physician_scientist"],
    ["physician, clinical only", { educations: deg("MBBS"), clinicalPubs5y: 3 }, "physician_scientist"],
    ["physician, both kinds", { educations: deg("PhD", "MD-PhD"), labPubs5y: 4, clinicalPubs5y: 9 }, "physician_scientist"],
    ["non-physician, lab", { educations: deg("PhD"), labPubs5y: 3 }, "basic_scientist"],
    ["non-physician, both kinds", { educations: deg("PhD"), labPubs5y: 3, clinicalPubs5y: 30 }, "basic_scientist"],
    ["non-physician, clinical only", { educations: deg("PhD"), clinicalPubs5y: 3 }, "clinical_researcher"],
    ["dentist with lab papers is not a physician", { educations: deg("DDS"), labPubs5y: 6 }, "basic_scientist"],
    // No kind, a qualifying PI award.
    ["funded, no kind", { educations: deg("PhD"), grants: r01 }, "funded_investigator"],
    ["funded physician, no kind", { educations: deg("D.O."), grants: r01, labPubs5y: 2 }, "funded_investigator"],
    // No kind, no award.
    ["physician by degree", { educations: deg("D.O.") }, "clinician"],
    ["clinical profile, non-medical degree", { educations: deg("DDS"), hasClinicalProfile: true }, "clinician"],
    ["no education rows: the clinical profile stands in", { hasClinicalProfile: true }, "clinician"],
    ["affiliated faculty with a clinical profile", { hasClinicalProfile: true, roleCategory: "affiliated_faculty" }, "clinician"],
    ["part-time faculty physician", { educations: deg("MD"), roleCategory: "part_time_faculty" }, "clinician"],
    ["non-faculty academic", { educations: deg("PhD"), roleCategory: "non_faculty_academic" }, "research_staff"],
    ["non-faculty academic physician is a clinician first", { educations: deg("MD"), roleCategory: "non_faculty_academic" }, "clinician"],
    ["nothing on file", { roleCategory: "full_time_faculty" }, "unclassified"],
    ["papers under the threshold", { educations: deg("PhD"), labPubs5y: 2, clinicalPubs5y: 2 }, "unclassified"],
  ] as const)("archetype: %s", (_name, over, expected) => {
    expect(researcherTypeFrom({ hasClinicalProfile: false, grants: [], ...over }, NOW).type).toBe(expected);
  });

  it("normalises the degree string and matches medical degrees only", () => {
    for (const d of ["M.D.", "md", "MD-PhD", "M.D./Ph.D.", "MBBS", "M.B.B.S.", "MBChB", "MB BCh", "MB BChir", "MB BCh BAO", "BMBS", "D.O."])
      expect(isMedicalDegree(d), d).toBe(true);
    for (const d of ["DDS", "DMD", "DPM", "PsyD", "DNP", "PharmD", "PhD", "MPH", "", null, undefined])
      expect(isMedicalDegree(d), String(d)).toBe(false);
  });

  it("falls back to the clinical profile ONLY when there are no education rows at all", () => {
    const t = (educations: { degree: string | null }[] | undefined) =>
      researcherTypeFrom({ hasClinicalProfile: true, grants: [], labPubs5y: 3, educations }, NOW);
    expect(t(undefined)).toMatchObject({ type: "physician_scientist", isPhysician: true });
    expect(t([])).toMatchObject({ type: "physician_scientist", isPhysician: true });
    // Degrees on file and none medical: not a physician, clinical profile or not.
    expect(t(deg("PhD"))).toMatchObject({ type: "basic_scientist", isPhysician: false });
  });

  it("returns the two facts alongside the archetype", () => {
    expect(
      researcherTypeFrom({ hasClinicalProfile: false, grants: [], educations: deg("MD"), labPubs5y: 3, clinicalPubs5y: 7 }, NOW),
    ).toEqual({ type: "physician_scientist", kinds: ["lab", "clinical"], isPhysician: true });
    expect(researcherTypeFrom({ hasClinicalProfile: false, grants: [] }, NOW)).toEqual({
      type: "unclassified",
      kinds: [],
      isPhysician: false,
    });
  });

  it("counts PI and MPI roles only: a Co-I on a trial is still a clinician", () => {
    expect(researcherTypeFrom({ hasClinicalProfile: true, grants: [g("U01", "Co-I", 2028)] }, NOW).type).toBe("clinician");
    expect(researcherTypeFrom({ hasClinicalProfile: true, grants: [g("U01", "Co-PI", 2028)] }, NOW).type).toBe("funded_investigator");
  });

  it("counts mentored K awards (the clinician-scientist's first lab) but not training, conference or education awards", () => {
    const md = (mech: string) =>
      researcherTypeFrom({ hasClinicalProfile: true, grants: [g(mech, "PI", 2028)] }, NOW).type;
    expect(md("K08")).toBe("funded_investigator");
    expect(md("K23")).toBe("funded_investigator");
    for (const mech of ["T32", "F32", "L30", "S10", "R13", "R25", "K12", "KL2"]) expect(md(mech)).toBe("clinician");
  });

  it("counts non-NIH research awards from any sponsor, but not service, MTA, trial or training rows", () => {
    const other = (o: Record<string, string>) =>
      researcherTypeFrom({ hasClinicalProfile: true, grants: [{ ...g(null, "PI", 2028), ...o }] }, NOW).type;
    expect(other({ programType: "Grant", intakeType: "Grant", primeSponsor: "DOD" })).toBe("funded_investigator");
    expect(other({ programType: "Contract with funding", intakeType: "Sponsored Research Agreement" })).toBe("funded_investigator");
    expect(other({ programType: "BioPharma Alliance Agreement", intakeType: "BioPharma" })).toBe("funded_investigator");
    expect(other({ programType: "Contract with funding", intakeType: "Service Agreement (WCM)" })).toBe("clinician");
    expect(other({ programType: "Grant", intakeType: "Incoming Material Transfer Agreement" })).toBe("clinician");
    expect(other({ programType: "Grant", intakeType: "Clinical Trial Agreement" })).toBe("clinician");
    expect(other({ programType: "Fellowship", intakeType: "Grant" })).toBe("clinician");
  });

  it("labels the award by NIH mechanism, else sponsor", () => {
    const r = researcherTypeFrom(
      { hasClinicalProfile: false, grants: [{ ...g(null, "PI", 2027), programType: "Grant", primeSponsor: "NSF" }] },
      NOW,
    );
    expect(r.award).toEqual({ label: "NSF", endYear: 2027 });
  });

  it("paper volume alone gives an unfunded scholar a research kind", () => {
    const t = (labPubs5y: number, hasClinicalProfile: boolean) =>
      researcherTypeFrom({ hasClinicalProfile, grants: [], labPubs5y }, NOW).type;
    expect(t(3, false)).toBe("basic_scientist");
    expect(t(3, true)).toBe("physician_scientist");
    expect(t(2, true)).toBe("clinician");
    // Clinical-paper volume is a research kind too: a physician with it is a physician-scientist.
    expect(researcherTypeFrom({ hasClinicalProfile: true, grants: [], clinicalPubs5y: 40 }, NOW).type).toBe("physician_scientist");
  });

  it("ignores awards that ended more than 5 years ago", () => {
    expect(researcherTypeFrom({ hasClinicalProfile: true, grants: [g("R01", "PI", 2020)] }, NOW).type).toBe("clinician");
    // The window edge: ended in 2021 = within 5 years of 2026.
    expect(researcherTypeFrom({ hasClinicalProfile: true, grants: [g("R01", "PI", 2021)] }, NOW).type).toBe("funded_investigator");
  });

  it("returns the latest-ending qualifying award as the reason", () => {
    const r = researcherTypeFrom(
      { hasClinicalProfile: false, grants: [g("R21", "PI", 2024), g("r01", "PI", 2029), g("T32", "PI", 2030)] },
      NOW,
    );
    expect(r.award).toEqual({ label: "NIH R01", endYear: 2029 });
  });
});

describe("matchaMeasuresFrom: the researcher facts", () => {
  const NOW = new Date(Date.UTC(2026, 9, 30));
  const row = {
    roleCategory: "full_time_faculty",
    primaryTitle: "Professor",
    hasClinicalProfile: false,
    appointments: [],
    educations: [{ year: 2001, degree: "M.D." }],
  };

  it("emits researchKinds and isPhysician whenever the type is computed", () => {
    expect(matchaMeasuresFrom({ ...row, grants: [], labPubs5y: 4, clinicalPubs5y: 3 }, NOW)).toMatchObject({
      researcherType: "physician_scientist",
      researchKinds: ["lab", "clinical"],
      isPhysician: true,
    });
    // Computed and empty is an empty array, never absent.
    expect(matchaMeasuresFrom({ ...row, educations: [], grants: [] }, NOW)).toMatchObject({
      researcherType: "unclassified",
      researchKinds: [],
      isPhysician: false,
    });
  });

  it("emits none of them when grants were not read (absent is not none)", () => {
    const m = matchaMeasuresFrom(row, NOW);
    expect(m.researcherType).toBeUndefined();
    expect(m.researchKinds).toBeUndefined();
    expect(m.isPhysician).toBeUndefined();
  });
});

describe("candidateFitTier", () => {
  const award = { label: "NIH R01", endYear: 2028 };
  const c = (measures: Record<string, unknown> | undefined, technologyCount?: number) => ({
    fusedScore: 10,
    measures,
    technologyCount,
  });

  it("caps 'strong' at 'good' for computed measures with no award and no CTL technology", () => {
    expect(candidateFitTier(c({ researcherType: "basic_scientist", researchKinds: ["lab"] }, 0), 10)).toBe("good");
    expect(candidateFitTier(c({ researcherType: "clinician" }), 10)).toBe("good");
  });

  it("does not cap a candidate with a research award", () => {
    expect(candidateFitTier(c({ researcherType: "basic_scientist", researchAward: award }, 0), 10)).toBe("strong");
  });

  it("does not cap a candidate holding CTL technology", () => {
    expect(candidateFitTier(c({ researcherType: "basic_scientist" }, 2), 10)).toBe("strong");
  });

  it("does not cap a candidate whose measures were never computed", () => {
    expect(candidateFitTier(c(undefined, 0), 10)).toBe("strong");
    expect(candidateFitTier(c({ careerStage: "senior", isClinician: false }, 0), 10)).toBe("strong");
  });

  it("does not cap a funded investigator whose award is withheld (hidden Funding section)", () => {
    expect(candidateFitTier(c({ researcherType: "funded_investigator" }, 0), 10)).toBe("strong");
  });

  it("leaves the lower tiers exactly as fitTier has them", () => {
    const capped = { researcherType: "unclassified" };
    expect(candidateFitTier({ ...c(capped, 0), fusedScore: 5 }, 10)).toBe("good");
    expect(candidateFitTier({ ...c(capped, 0), fusedScore: 1 }, 10)).toBe("weak");
    expect(candidateFitTier({ ...c(capped, 0), fusedScore: 1 }, 0)).toBe("weak");
  });
});

describe("archetype follow-ups", () => {
  it("finds a medical degree inside a cell that holds several degrees", () => {
    for (const d of ["MD, MPH", "PhD, MD", "M.D./M.B.A.", "MD (Hons)", "MD-PhD"]) {
      expect(isMedicalDegree(d), d).toBe(true);
    }
    for (const d of ["MDiv", "DMD, MS", "PhD, MPH", "Residency"]) {
      expect(isMedicalDegree(d), d).toBe(false);
    }
  });

  it("does not cap a funded lab scientist who hides their Funding section", () => {
    const hidden = { fusedScore: 10, technologyCount: 0, measures: { researcherType: "basic_scientist", researchKinds: ["lab"], fundedAsPi: true } };
    expect(candidateFitTier(hidden as never, 10)).toBe("strong");
  });
});
