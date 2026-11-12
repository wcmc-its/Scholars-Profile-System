/**
 * Matcha spine — pure composition helpers for the compose-`searchPeople`
 * ranking (handoff `docs/2026-07-11-sponsor-match-searchpeople-pivot-handoff.md`
 * §4/§6). No db, no network: the impure per-term `searchPeople` retrieval and the
 * term→MeSH resolution (`matchQueryToTaxonomy`) live in the caller; these two
 * functions are the parts that unit-test in isolation.
 *
 *   extractTerms — v1 dictionary match of a paste against the tool/term vocab
 *                  (§6 item-3). The Bedrock recall upgrade (§7-Q1) is a drop-in.
 *   rrfFuse      — weighted Reciprocal Rank Fusion across the per-cluster
 *                  `searchPeople` rankings (§4: score(s) = Σ_c weight_c / (K + rank)).
 */

import { DEFAULT_K } from "@/lib/api/matcha-contract";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * v1 term extraction: the vocab entries that occur in `paste` as whole
 * words/phrases (case-insensitive), returned in vocab order, deduped. No Bedrock —
 * paraphrase recall + rubric centrality are the LLM upgrade (§7-Q1). Centrality is
 * uniform here; the caller resolves each term's MeSH set + centrality before
 * `mergeTermClusters`.
 *
 * ponytail: `\b` word-boundary match — good enough for the alphanumeric tool/term
 * vocab (won't match "cell" inside "excellent"); a term whose edge char is
 * non-word (e.g. "C++") won't boundary-match. Swap for the LLM extractor when the
 * eval shows paraphrase recall matters.
 */
export function extractTerms(paste: string, vocab: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of vocab) {
    const key = term.toLowerCase();
    if (term.trim() === "" || seen.has(key)) continue;
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(paste)) {
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

export type TermRanking = {
  /** The cluster's representative term. Joins to `MatchaConcept.term` on the wire, so
   *  the client can attribute each contribution back to the slider that drives it. */
  term: string;
  /** fusion weight for this cluster/term = centrality^γ × kindPrior (≥ 0). Corpus rarity is
   *  NOT a factor — see `sponsor-match-contract.ts` (`weightFactor`). */
  weight: number;
  /** scholar cwids in `searchPeople` rank order (rank = index + 1). */
  ranked: string[];
};

/** One fused scholar, WITH the decomposed inputs that produced its score. */
export type FusedScholar = {
  cwid: string;
  score: number;
  /** Every (term, rank) this scholar appeared under — the UI contract's hinge. The
   *  client recomputes `score` from these as sliders move, so a re-rank needs no new
   *  search. Ordered by the ranking order the caller passed in. */
  contributions: { term: string; rank: number }[];
};

/**
 * Weighted Reciprocal Rank Fusion across per-term rankings (§4 spine):
 *   score(s) = Σ_c  weight_c / (K + rank_{s,c})
 * The per-term `searchPeople` scores are NOT cross-comparable, so we fuse on rank.
 * K damps the head so one term's #1 can't dominate. A scholar absent from a term
 * contributes nothing for it. Returns cwids sorted by fused score desc, ties broken
 * by earliest first appearance (stable).
 *
 * Also returns each scholar's `contributions` — the per-term ranks the sum was built
 * from. They are NOT extra work: this loop already visits every (term, scholar, rank)
 * triple, and previously discarded the rank after folding it into the scalar. Keeping
 * them is what lets the console re-rank live over the already-fetched candidates
 * instead of re-querying on every slider drag (`sponsor-match-contract.ts`). Weak
 * contributions are kept deliberately — a concept the user slides UP must be able to
 * lift a scholar who only ranked #80 under it, and that is impossible if the response
 * pruned the row.
 *
 * `K` defaults to the contract's `DEFAULT_K`; the client re-ranks with the same
 * constant, and `sponsor-match-contract.test.ts` pins the two together.
 */
export function rrfFuse(
  rankings: TermRanking[],
  K = DEFAULT_K,
  // D1 — optional per-scholar recency multiplier (cwid → weight in [FLOOR,1], from `recencyWeight`).
  // Applied to the SUMMED score so the server's order AND its top-N cut are recency-aware, and so
  // the client's `fusedScore()` (which applies the identical factor) reproduces this order at
  // default weights. Absent (flag off / other callers) ⇒ every scholar multiplies by 1 — the
  // fusion is byte-identical to before.
  recencyWeightByCwid?: ReadonlyMap<string, number>,
): FusedScholar[] {
  const score = new Map<string, number>();
  const contributions = new Map<string, { term: string; rank: number }[]>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const { term, weight, ranked } of rankings) {
    for (let rank = 1; rank <= ranked.length; rank++) {
      const cwid = ranked[rank - 1];
      score.set(cwid, (score.get(cwid) ?? 0) + weight / (K + rank));
      const rows = contributions.get(cwid);
      if (rows) rows.push({ term, rank });
      else contributions.set(cwid, [{ term, rank }]);
      if (!firstSeen.has(cwid)) firstSeen.set(cwid, order++);
    }
  }
  return [...score.entries()]
    .map(([cwid, s]) => ({
      cwid,
      score: s * (recencyWeightByCwid?.get(cwid) ?? 1),
      contributions: contributions.get(cwid)!,
    }))
    .sort((a, b) => b.score - a.score || firstSeen.get(a.cwid)! - firstSeen.get(b.cwid)!);
}
