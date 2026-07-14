/**
 * Spine-agnostic term clustering for the sponsor-match spine (design
 * `docs/2026-07-10-sponsor-match-phase2-3-design.md` §5a). PURE — no db, no network.
 * Wired: `sponsor-match-spine-run.ts` clusters the LLM-extracted concepts here before
 * the per-cluster fan-out.
 *
 * This module used to also export `dampedIdf`, the §6 expertise-rarity axis. It is GONE,
 * not merely unwired: corpus rarity anti-correlates with topical centrality, so it ranked
 * a disease's own mechanisms above the disease. The fusion weight is a topicality claim
 * and rarity is not a topicality signal. See `sponsor-match-contract.ts` (`weightFactor`)
 * for the full argument, and `corpusCoverage` for where rarity legitimately survives
 * (display only). Do not reintroduce it without re-reading that comment.
 */

export type ConceptKind = "concept" | "method";

export type ClusterTerm = {
  term: string;
  descendantUis: string[];
  centrality: number;
  kind: ConceptKind;
};
export type TermCluster = {
  members: string[];
  descendantUis: string[];
  centrality: number;
  kind: ConceptKind;
};

/** Jaccard of two id sets. 0 when either is empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Two concepts are the same when one descriptor set SUBSUMES the other, or they
 *  OVERLAP past the Jaccard threshold τ. Empty sets never merge (no evidence). */
function related(a: Set<string>, b: Set<string>, tau: number): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const subset = [...a].every((x) => b.has(x)) || [...b].every((x) => a.has(x));
  return subset || jaccard(a, b) >= tau;
}

/**
 * Merge redundant terms into clusters (§5a) so redundant sponsor phrasing
 * ("cancer, oncology, leukemia") can't triple-weight one concept or double-credit
 * overlapping researchers. Equivalence is decided by the MeSH descriptor sets, NOT
 * the LLM — the tree catches over-merges and missed subsumptions the LLM would get
 * wrong. Connected components over pairwise `related`; each cluster unions the
 * descendant sets and takes the max member centrality. Stable by earliest member.
 * Terms with no resolved descriptors pass through as singletons.
 *
 * The cluster's `kind` is its FIRST member's — the same member that supplies the
 * representative term and the representative MeSH resolution, so the three stay
 * consistent. A mixed-kind cluster (a method and a disease sharing a descriptor set)
 * is possible in principle and follows the representative rather than a vote; a
 * majority rule here would let the rail's Concept/Method panel disagree with the name
 * the cluster is displayed under.
 */
export function mergeTermClusters(terms: ClusterTerm[], tau: number): TermCluster[] {
  const sets = terms.map((t) => new Set(t.descendantUis));
  // Union-find over the small term list (≤ ~12 terms).
  const parent = terms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < terms.length; i++)
    for (let j = i + 1; j < terms.length; j++)
      if (related(sets[i], sets[j], tau)) parent[find(i)] = find(j);

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < terms.length; i++) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(i);
    byRoot.set(r, arr);
  }
  return [...byRoot.values()]
    .sort((a, b) => Math.min(...a) - Math.min(...b))
    .map((idxs) => {
      const uni = new Set<string>();
      let centrality = 0;
      const members: string[] = [];
      for (const i of idxs) {
        members.push(terms[i].term);
        centrality = Math.max(centrality, terms[i].centrality);
        for (const u of terms[i].descendantUis) uni.add(u);
      }
      // `idxs` is ascending, so idxs[0] is the earliest member — the representative.
      return { members, descendantUis: [...uni], centrality, kind: terms[idxs[0]].kind };
    });
}
