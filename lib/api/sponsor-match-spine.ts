/**
 * Sponsor-match spine — pure composition helpers for the compose-`searchPeople`
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
  /** fusion weight for this cluster/term = centrality × dampedIdf (≥ 0). */
  weight: number;
  /** scholar cwids in `searchPeople` rank order (rank = index + 1). */
  ranked: string[];
};

/**
 * Weighted Reciprocal Rank Fusion across per-term rankings (§4 spine):
 *   score(s) = Σ_c  weight_c / (K + rank_{s,c})
 * The per-term `searchPeople` scores are NOT cross-comparable, so we fuse on rank.
 * K damps the head so one term's #1 can't dominate. A scholar absent from a term
 * contributes nothing for it. Returns cwids sorted by fused score desc, ties broken
 * by earliest first appearance (stable).
 */
export function rrfFuse(rankings: TermRanking[], K = 60): { cwid: string; score: number }[] {
  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const { weight, ranked } of rankings) {
    for (let rank = 1; rank <= ranked.length; rank++) {
      const cwid = ranked[rank - 1];
      score.set(cwid, (score.get(cwid) ?? 0) + weight / (K + rank));
      if (!firstSeen.has(cwid)) firstSeen.set(cwid, order++);
    }
  }
  return [...score.entries()]
    .map(([cwid, s]) => ({ cwid, score: s }))
    .sort((a, b) => b.score - a.score || firstSeen.get(a.cwid)! - firstSeen.get(b.cwid)!);
}
