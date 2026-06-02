/**
 * Issue #688 — People-search MeSH match provenance.
 *
 * When a topic/unclassified People search resolves to a MeSH descriptor, the
 * §6.1.3 attribution boost (`terms { publicationMeshUi: descendantUis }`, ×1.5,
 * `lib/api/search.ts`) ranks up scholars whose publications are tagged with a
 * *narrower* (descendant) descriptor than the one the user typed — e.g.
 * `Microbiome` (Microbiota, D064307) surfacing a scholar tagged only with
 * `Mycobiome` (D000072761). The query-keyed highlighter never marks anything in
 * that case (the typed term isn't in the scholar's text), so the match looks
 * unexplained. This computes the human-readable "why" — the narrower term(s)
 * the scholar actually carries — for the UI to surface.
 *
 * Pure and side-effect-free so it unit-tests without OpenSearch/Prisma. The
 * label lookup is resolved upstream (`descriptorLabelsForUis`) and passed in.
 */

export type MatchProvenance = {
  /** The resolved descriptor's display name — the term the user effectively searched. */
  parentTerm: string;
  /**
   * Display labels of the *narrower* descendant descriptors this scholar is
   * tagged with, in tree-walk order (the order of `descendantUis`). Never
   * includes the parent itself. Always non-empty when this object is present.
   */
  descendantTerms: string[];
};

/**
 * Compute the narrower-term provenance for a single hit, or `undefined` when
 * there is nothing to explain.
 *
 * Returns `undefined` when:
 *   - the scholar carries no MeSH UIs, or
 *   - the scholar matched only the resolved descriptor itself (no narrower
 *     term) — that case is already covered by ordinary label highlighting and
 *     needs no "narrower term of …" framing.
 *
 * @param publicationMeshUi  the scholar's descriptor UIs (`_source.publicationMeshUi`)
 * @param descendantUis      resolved descriptor's `[self, ...descendants]` (invariant: `[0]` is the parent)
 * @param parentTerm         resolved descriptor's display name
 * @param labels             descendant-UI → display-name map (parent may be absent)
 */
export function computeMatchProvenance(opts: {
  publicationMeshUi: string[] | undefined;
  descendantUis: string[];
  parentTerm: string;
  labels: Map<string, string>;
}): MatchProvenance | undefined {
  const { publicationMeshUi, descendantUis, parentTerm, labels } = opts;
  if (!publicationMeshUi || publicationMeshUi.length === 0) return undefined;
  if (descendantUis.length <= 1) return undefined; // no narrower terms exist

  const have = new Set(publicationMeshUi);
  // Skip index 0 (the resolved descriptor itself) — we only explain *narrower*
  // matches. Preserving `descendantUis` order keeps the output deterministic
  // (tree-walk order) and already-deduped.
  const matchedUis = descendantUis.slice(1).filter((ui) => have.has(ui));
  if (matchedUis.length === 0) return undefined;

  const descendantTerms = matchedUis.map((ui) => labels.get(ui) ?? ui);
  return { parentTerm, descendantTerms };
}
