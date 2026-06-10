/**
 * Scholar-profile facet-filter redesign (PR-1) — pure, side-effect-free
 * contextual facet counting for the Topics and Methods (family) facets.
 *
 * The profile publication list is filtered by three composable facets:
 *   1. author-position (caller-supplied predicate),
 *   2. Topics (MeSH descriptorUi selection), and
 *   3. Methods (method-family selection).
 *
 * Each facet's displayed per-option count uses the standard "exclude-own-facet"
 * faceting rule: an option's count reflects every OTHER active facet but NOT the
 * facet it belongs to. This keeps a facet's selected option in agreement with the
 * filtered bar total (the classic "6 of 27 / 6 of 10 both converge on 6"
 * property), while still letting the user see how many in-context publications
 * each unselected option would add.
 *
 * This module is intentionally free of React, Prisma, and any I/O — it operates
 * purely over in-memory shapes so it can be exercised exhaustively in unit tests
 * and reused on both the server and the client.
 */

import type { ProfilePublication } from "@/lib/api/profile";

/**
 * Contextual counts for a single facet-filter state.
 *
 * - `topic`  — descriptorUi -> in-context publication count (Topics facet,
 *   computed with the Topics selection EXCLUDED).
 * - `family` — familyId -> in-context publication count (Methods facet,
 *   computed with the Methods selection EXCLUDED).
 * - `barTotal` — number of publications passing ALL active facets; the
 *   selected option of either facet converges on this value.
 */
export type FacetCounts = {
  topic: Map<string, number>;
  family: Map<string, number>;
  barTotal: number;
};

export type ComputeFacetCountsArgs = {
  /** The scholar's confirmed publications (already loaded; no I/O here). */
  publications: ProfilePublication[];
  /** Selected topic descriptorUis. Empty = Topics facet inactive. */
  selectedUis: string[];
  /** Selected method-family ids. Empty = Methods facet inactive. */
  selectedFamilyIds: string[];
  /** Family id -> its member pmids (the membership sets). */
  familyPmids: Map<string, string[]>;
  /**
   * Author-position predicate supplied by the caller. Pass `() => true` when no
   * position filter is active. Keeps this util decoupled from position logic.
   */
  matchesPosition: (pub: ProfilePublication) => boolean;
  /** Profile-wide pubCount per descriptorUi, used to clamp the numerator. */
  topicTotals?: Map<string, number>;
  /** Profile-wide pubCount per familyId, used to clamp the numerator. */
  familyTotals?: Map<string, number>;
  /**
   * Called when a live in-memory numerator exceeds the precomputed aggregate
   * denominator (the "7 of 6" edge case). Defaults to `console.warn`.
   */
  onClampMismatch?: (
    kind: "topic" | "family",
    id: string,
    numerator: number,
    denominator: number,
  ) => void;
};

function defaultClampWarn(
  kind: "topic" | "family",
  id: string,
  numerator: number,
  denominator: number,
): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[facet-counts] ${kind} ${id}: live count ${numerator} exceeds aggregate ${denominator}; clamping.`,
  );
}

/**
 * Clamp `numerator` to at most `denominator` from `totals` (when provided),
 * firing `onMismatch` on the "7 of 6" inversion. Returns the value to store.
 */
function clampToTotal(
  kind: "topic" | "family",
  id: string,
  numerator: number,
  totals: Map<string, number> | undefined,
  onMismatch: NonNullable<ComputeFacetCountsArgs["onClampMismatch"]>,
): number {
  if (!totals) return numerator;
  const denominator = totals.get(id);
  if (denominator === undefined) return numerator;
  if (numerator > denominator) {
    onMismatch(kind, id, numerator, denominator);
    return denominator;
  }
  return numerator;
}

/**
 * Compute exclude-own-facet contextual counts for the Topics and Methods facets,
 * plus the all-facets bar total, in O(pubs) per facet.
 */
export function computeFacetCounts(args: ComputeFacetCountsArgs): FacetCounts {
  const {
    publications,
    selectedUis,
    selectedFamilyIds,
    familyPmids,
    matchesPosition,
    topicTotals,
    familyTotals,
    onClampMismatch = defaultClampWarn,
  } = args;

  const selectedUiSet = new Set(selectedUis);

  // (1) Build the family union pmid set ONCE. CRITICAL: union across the
  // selected families (a single Set), never a per-family sum — a multi-family
  // scholar shares pmids across families and would otherwise double-count.
  const familyUnion = new Set<string>();
  for (const id of selectedFamilyIds) {
    const pmids = familyPmids.get(id);
    if (!pmids) continue;
    for (const pmid of pmids) familyUnion.add(pmid);
  }

  const topicsActive = selectedUis.length > 0;
  const familiesActive = selectedFamilyIds.length > 0;

  // (3) The two exclude-own-facet pub subsets, built from the same per-pub pass
  // booleans so they cannot disagree with the bar total below.
  const pmidsForTopicCounts: ProfilePublication[] = []; // passesPosition && passesFamilies
  const pmidsForMethodCounts = new Set<string>(); // passesPosition && passesTopics
  let barTotal = 0;

  for (const pub of publications) {
    // (2) Three booleans per publication.
    const passesPosition = matchesPosition(pub);
    if (!passesPosition) continue; // position composes as an "other facet" for both

    const passesTopics =
      !topicsActive || pub.meshTerms.some((t) => t.ui !== null && selectedUiSet.has(t.ui));
    const passesFamilies = !familiesActive || familyUnion.has(pub.pmid);

    // (3) Topic counts EXCLUDE the Topics selection; Method counts EXCLUDE the
    // Methods selection. Position already enforced above.
    if (passesFamilies) pmidsForTopicCounts.push(pub);
    if (passesTopics) pmidsForMethodCounts.add(pub.pmid);

    // (6) barTotal derives from the SAME booleans — never the aggregates.
    if (passesTopics && passesFamilies) barTotal += 1;
  }

  // (4) Topic map: for every in-(other-facet)-context pub, increment each of its
  // non-null mesh uis. Dedupe within a pub so a malformed double-entry can't
  // double-count. Works for both selected and unselected topics; the selected
  // topic converges on barTotal.
  const topic = new Map<string, number>();
  for (const pub of pmidsForTopicCounts) {
    const seenOnThisPub = new Set<string>();
    for (const term of pub.meshTerms) {
      if (term.ui === null) continue;
      if (seenOnThisPub.has(term.ui)) continue;
      seenOnThisPub.add(term.ui);
      topic.set(term.ui, (topic.get(term.ui) ?? 0) + 1);
    }
  }

  // (5) Family map: family[id] = |familyPmids.get(id) ∩ pmidsForMethodCounts|.
  // Iterate the smaller of the two sets for efficiency. Every family present in
  // familyPmids appears in the map (zero-count families stay at 0).
  const family = new Map<string, number>();
  for (const [id, pmids] of familyPmids) {
    let intersection = 0;
    if (pmids.length <= pmidsForMethodCounts.size) {
      const seen = new Set<string>(); // dedupe membership-list repeats
      for (const pmid of pmids) {
        if (seen.has(pmid)) continue;
        seen.add(pmid);
        if (pmidsForMethodCounts.has(pmid)) intersection += 1;
      }
    } else {
      const memberSet = new Set(pmids);
      for (const pmid of pmidsForMethodCounts) {
        if (memberSet.has(pmid)) intersection += 1;
      }
    }
    family.set(id, intersection);
  }

  // (7) Clamp numerators to their precomputed aggregate denominators (guards the
  // "7 of 6" inversion) and report any mismatch.
  if (topicTotals) {
    for (const [id, numerator] of topic) {
      topic.set(id, clampToTotal("topic", id, numerator, topicTotals, onClampMismatch));
    }
  }
  if (familyTotals) {
    for (const [id, numerator] of family) {
      family.set(id, clampToTotal("family", id, numerator, familyTotals, onClampMismatch));
    }
  }

  return { topic, family, barTotal };
}
