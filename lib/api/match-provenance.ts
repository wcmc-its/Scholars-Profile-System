/**
 * Issue #688 / #702 — People-search match provenance.
 *
 * When a topic/unclassified People search resolves to a MeSH descriptor, the
 * §6.1.3 attribution boost (`terms { publicationMeshUi: descendantUis }`, ×1.5,
 * `lib/api/search.ts`) ranks up scholars whose publications are tagged with the
 * resolved descriptor or a *narrower* (descendant) descriptor — e.g.
 * `Microbiome` (Microbiota, D064307) surfacing a scholar tagged only with
 * `Mycobiome` (D000072761), or one tagged with `Microbiota` itself. The
 * query-keyed highlighter never marks anything in that case (the typed term
 * isn't necessarily in the scholar's analyzed text), so the match looks
 * unexplained. This computes the human-readable "why":
 *
 *   - `narrower` — the narrower term(s) the scholar actually carries (#688), or
 *   - `concept`  — a direct match on the resolved descriptor itself (#702; the
 *     case #688 deliberately skipped, which is the most common topical match).
 *
 * The result drives the People-tab per-row `matchReason` (`buildMatchReason`,
 * `lib/api/search.ts`) and the Publications-tab "via related concept" note.
 *
 * Pure and side-effect-free so it unit-tests without OpenSearch/Prisma. The
 * label lookup is resolved upstream (`descriptorLabelsForUis`) and passed in.
 */

/**
 * Why a hit surfaced, in the user-facing framing the card renders.
 *
 *   - `narrower`: the scholar carries one or more *narrower* descendant
 *     descriptors than the one searched ("Mycobiome — a narrower term of
 *     Microbiota").
 *   - `concept`:  the scholar's publications are tagged with the resolved
 *     descriptor itself ("publications tagged Microbiota"). #702 — this was
 *     `undefined` under #688.
 */
export type MatchProvenance =
  | {
      kind: "narrower";
      /** The resolved descriptor's display name — the term the user effectively searched. */
      parentTerm: string;
      /**
       * Display labels of the *narrower* descendant descriptors this scholar is
       * tagged with, in tree-walk order (the order of `descendantUis`). Never
       * includes the parent itself. Always non-empty for this variant.
       */
      descendantTerms: string[];
      /**
       * #1955 — is the resolved parent descriptor ALSO present in the
       * `publicationMeshUi` set this call was given?
       *
       * It does NOT decide the branch. This variant is still preferred whenever a
       * descendant is present, because naming the narrower term is the more
       * specific display — that behaviour is unchanged. The field exists because
       * the branch fires on the scholar CARRYING a descendant, not on the match
       * having come THROUGH one, so a renderer that says "matched on narrower
       * term" asserts a route nobody computed for the scholar tagged with both.
       *
       * The two values are NOT symmetric. Read each as exactly what the predicate
       * computes:
       *   `true`  ⇒ the parent tag is PRESENT. Sound — membership in
       *             `publicationMeshUi` implies the tag exists.
       *   `false` ⇒ the parent tag is absent FROM THE INDEXED SET, which is weaker
       *             than absent. `publicationMeshUi` is min-evidence filtered when
       *             the people-doc is built (`lib/search-index-docs.ts` skips a
       *             descriptor unless `agg.distinctPubs >= 2 || agg.hasFirstOrLast`),
       *             so a scholar whose parent descriptor sits on exactly ONE
       *             middle-author publication carries the tag and is still missing
       *             from this input. Compounding it, the People lead line's N is
       *             served ungated FOR THIS COHORT — #1952's `countsFor` zeroes the
       *             tagged count only for a scholar carrying no in-subtree UI, and
       *             the narrower branch guarantees one — while `meshSubtreeCounts`
       *             itself counts every kept pub with no threshold. So that same
       *             below-threshold publication IS inside the "N of M publications
       *             tagged <parent>" it renders under. For that cohort
       *             the narrower-route wording remains an over-claim: bounded, named,
       *             and UNFIXED here. Closing it needs a second data source, which is
       *             a separate issue — not a change to this predicate.
       *
       * Consumers use it to pick copy that holds, not to re-rank.
       */
      alsoParent: boolean;
    }
  | {
      kind: "concept";
      /** The resolved descriptor's display name — the concept directly matched. */
      parentTerm: string;
    };

/**
 * Compute the MeSH match provenance for a single hit, or `undefined` when there
 * is nothing to explain.
 *
 * Returns `undefined` when:
 *   - the scholar carries no MeSH UIs, or
 *   - the resolved descriptor set is empty (no resolution), or
 *   - the scholar carries neither the resolved descriptor nor any of its
 *     descendants (so the MeSH attribution boost didn't explain this hit — it
 *     matched on analyzed text instead, which ordinary highlighting covers).
 *
 * Otherwise returns the more specific framing available: `narrower` when the
 * scholar carries a strictly-narrower descendant, else `concept` for a direct
 * descriptor match.
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
  if (descendantUis.length === 0) return undefined; // no descriptor resolved

  const have = new Set(publicationMeshUi);
  // Skip index 0 (the resolved descriptor itself) — narrower matches are the
  // more specific explanation. Preserving `descendantUis` order keeps the
  // output deterministic (tree-walk order) and already-deduped.
  const matchedUis = descendantUis.slice(1).filter((ui) => have.has(ui));
  if (matchedUis.length > 0) {
    const descendantTerms = matchedUis.map((ui) => labels.get(ui) ?? ui);
    // #1955 — the same parent test the `concept` branch runs below, evaluated here
    // as well. It settles the WORDING, never the branch: a scholar carrying both
    // still reads as `narrower`, exactly as before.
    return {
      kind: "narrower",
      parentTerm,
      descendantTerms,
      alsoParent: have.has(descendantUis[0]),
    };
  }

  // #702 — no narrower term, but the scholar is tagged with the resolved
  // descriptor itself: a direct concept match. #688 returned `undefined` here;
  // we now explain it so a topically-relevant card isn't left bare.
  if (have.has(descendantUis[0])) {
    return { kind: "concept", parentTerm };
  }

  return undefined;
}
