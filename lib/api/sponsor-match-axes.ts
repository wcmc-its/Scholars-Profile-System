/**
 * Spine-agnostic scoring helpers for the sponsor-match Stage-2 axes (design
 * `docs/2026-07-10-sponsor-match-phase2-3-design.md` §5a, §6). PURE — no db, no
 * network. Consumed by the Phase-2 LLM front-end, which supplies the extracted
 * terms + their resolved MeSH descendant-UI sets; built ahead so the bake-off and
 * Phase 2 compose them. Not yet wired (no term inputs until the Bedrock front-end).
 */

/** Expertise IDF (§6). `coverage` ∈ (0,1] = fraction of the corpus carrying the
 *  concept (topics: `mesh_descriptor.local_pub_coverage`; tools: scholars_using/N).
 *  idf = -ln(coverage), damped to `cap` so a 1-in-corpus concept can't dominate the
 *  fusion. coverage ≥ 1 ⇒ 0 (ubiquitous, no signal); coverage ≤ 0 / NaN ⇒ cap
 *  (treat as maximally rare). */
export function dampedIdf(coverage: number, cap: number): number {
  if (!Number.isFinite(coverage) || coverage <= 0) return cap;
  if (coverage >= 1) return 0;
  return Math.min(-Math.log(coverage), cap);
}

export type ClusterTerm = { term: string; descendantUis: string[]; centrality: number };
export type TermCluster = { members: string[]; descendantUis: string[]; centrality: number };

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
      return { members, descendantUis: [...uni], centrality };
    });
}
