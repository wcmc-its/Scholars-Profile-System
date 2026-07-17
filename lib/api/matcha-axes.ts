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

/**
 * Choose which extracted concepts survive the fan-out cap (#1780). The cap `max` bounds
 * server load (per-concept `searchPeople` fan-out) and MUST NOT be raised here. The
 * extractor's rubric scores methods 0.3–0.5 ("supporting detail"), so a plain top-`max`
 * cut parks them in the culled tail — measured at 50% of all method concepts across the 15
 * eval fixtures, and every method dropped on 8 of 15 disease-primary asks.
 *
 * The fix is a FLOOR, not a raised cap: guarantee up to `methodFloor` methods scoring
 * `>= methodThreshold` survive, displacing only the lowest-centrality *concepts* — never a
 * method, and never more than `max` total. So a method-primary ask whose methods already
 * fill the top-`max` (e.g. gene therapy) is untouched; only method-STARVED asks get the
 * guarantee. The displaced concept is the marginal `max`-th one the reserved method
 * outranked in the cut — the intended trade (method representation over the 8th concept).
 *
 * Also fixes an order bug in the old `slice(0, max)`: it trusted the model's return order,
 * which is not strictly its own centrality numbers. Selection here is by an EXPLICIT
 * centrality sort, ties broken by input order so the result stays deterministic (the
 * bake-off compares runs).
 */
export function selectWithMethodFloor<T extends { kind: ConceptKind; centrality: number }>(
  concepts: readonly T[],
  opts: { max: number; methodFloor: number; methodThreshold: number },
): T[] {
  const idx = new Map<T, number>(concepts.map((c, i) => [c, i]));
  const byCentralityDesc = (a: T, b: T) =>
    b.centrality - a.centrality || idx.get(a)! - idx.get(b)!;
  const sorted = [...concepts].sort(byCentralityDesc);
  const natural = sorted.slice(0, opts.max);

  const methodsIn = natural.filter((c) => c.kind === "method").length;
  const qualifying = sorted.filter(
    (c) => c.kind === "method" && c.centrality >= opts.methodThreshold,
  );
  // How many qualifying methods to force in over the natural cut. <= 0 ⇒ already enough
  // methods present (incl. every method-primary ask, and any ask with < `max` concepts,
  // where nothing was cut) ⇒ return the natural top-`max` unchanged.
  const need = Math.min(opts.methodFloor, qualifying.length) - methodsIn;
  if (need <= 0) return natural;

  const inNatural = new Set(natural);
  const add = qualifying.filter((c) => !inNatural.has(c)).slice(0, need);
  // Drop the `need` lowest-centrality CONCEPTS from the natural cut (never a method). A
  // cut that bit (natural.length === max, need > 0 ⇒ methodsIn < max) always leaves enough.
  const drop = new Set(
    natural
      .filter((c) => c.kind === "concept")
      .sort((a, b) => a.centrality - b.centrality || idx.get(b)! - idx.get(a)!)
      .slice(0, need),
  );
  return [...natural.filter((c) => !drop.has(c)), ...add].sort(byCentralityDesc);
}
