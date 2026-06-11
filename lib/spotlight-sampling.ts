/**
 * Seeded publication sampling AND card-level near-duplicate guarding for the
 * home-page Spotlight (#286).
 *
 * Two concerns, two halves:
 *   1. `sampleSpotlightPapers` — which 3 papers a single spotlight renders.
 *   2. `sampleDistinctCards` — which spotlights a page load shows, avoiding two
 *      paper-level near-duplicate cards side by side (ReciterAI 25-card bump).
 *
 * Each home-page spotlight ships a pool of representative WCM publications in
 * the ReciterAI artifact — up to 7 per spotlight since ReciterAI #49. The
 * Spotlight section renders 3. `sampleSpotlightPapers` decides which 3,
 * deterministically per publish cycle, seeded on `<artifactVersion>:<subtopicId>`.
 *
 * Why seeded rather than `Math.random()`: a per-cycle-stable choice keeps CDN /
 * runtime caches, screenshot QA, and per-position CTR attribution coherent —
 * every visitor in a publish cycle sees the same 3 — while the choice still
 * rotates when the next artifact publishes. A deterministic result is also
 * identical on server and client, so the sample runs server-side in
 * `getSpotlights()` with no risk of a hydration mismatch.
 *
 * Soft re-roll: if a drawn triple repeats a lead or senior WCM author across
 * two cards, re-draw — up to 3 times — so one prolific scholar does not front
 * the whole section. The final draw is accepted as-is, which bounds the work
 * when a scholar genuinely dominates the pool.
 */

/** Papers shown per spotlight. */
const SAMPLE_SIZE = 3;
/** Re-roll attempts after the initial draw before accepting a colliding triple. */
const MAX_REROLLS = 3;

/**
 * xmur3 string hash → uint32. Folds an arbitrary seed key into a single
 * 32-bit integer suitable for seeding `mulberry32`.
 */
export function hashSeed(key: string): number {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * mulberry32 PRNG. Returns a generator of deterministic floats in [0, 1) —
 * the same `seed` always yields the same sequence.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `k` distinct items from `pool` with a partial Fisher–Yates shuffle
 * driven by `rng`. Consumes exactly `min(k, pool.length)` values from `rng`,
 * so successive calls on the same generator produce genuinely different draws.
 */
export function seededSample<T>(
  pool: readonly T[],
  k: number,
  rng: () => number,
): T[] {
  const arr = pool.slice();
  const take = Math.min(k, arr.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, take);
}

/** Minimal shape the sampler needs: a byline-position-ordered author list. */
type AuthoredPaper = { authors: ReadonlyArray<{ cwid: string }> };

/**
 * Lead + senior WCM author cwids for a paper. `getSpotlights()` resolves and
 * orders `authors` by byline position, so `authors[0]` is the lead-most WCM
 * author and the last entry is the senior-most — the SPS-resolved analogue of
 * the issue's "first / last WCM author". A single-author paper yields one cwid.
 */
function keyAuthorCwids(paper: AuthoredPaper): string[] {
  const a = paper.authors;
  if (a.length === 0) return [];
  if (a.length === 1) return [a[0].cwid];
  return [a[0].cwid, a[a.length - 1].cwid];
}

/** True when two papers in the set share a lead or senior WCM author. */
export function hasKeyAuthorCollision(
  papers: readonly AuthoredPaper[],
): boolean {
  const seen = new Set<string>();
  for (const paper of papers) {
    const keys = new Set(keyAuthorCwids(paper));
    for (const cwid of keys) {
      if (seen.has(cwid)) return true;
    }
    for (const cwid of keys) seen.add(cwid);
  }
  return false;
}

/**
 * Choose the (up to 3) papers a spotlight renders, seeded on `seedKey` so the
 * choice is stable for every visitor within a publish cycle and rotates across
 * cycles. `papers` must already be the qualifying pool — the caller
 * (`getSpotlights()`) drops papers with zero WCM-resolved authors first.
 *
 * Pools of 3 or fewer render in full; there is nothing to sample. Larger pools
 * draw 3, re-rolling up to `MAX_REROLLS` times to avoid repeating a lead or
 * senior WCM author across cards; the final draw is accepted unconditionally.
 */
export function sampleSpotlightPapers<T extends AuthoredPaper>(
  papers: readonly T[],
  seedKey: string,
): T[] {
  if (papers.length <= SAMPLE_SIZE) return papers.slice();
  const rng = mulberry32(hashSeed(seedKey));
  let triple: T[] = [];
  for (let attempt = 0; attempt <= MAX_REROLLS; attempt++) {
    triple = seededSample(papers, SAMPLE_SIZE, rng);
    if (!hasKeyAuthorCollision(triple)) break;
  }
  return triple;
}

// ---------------------------------------------------------------------------
// Card-level near-duplicate guard (ReciterAI 25-card spotlight bump)
// ---------------------------------------------------------------------------
//
// The producer used to pre-truncate the spotlight artifact to a top-9; it now
// publishes every cleared candidate — up to 25 cards, one per parent topic. The
// home-page section random-samples DISPLAY_LIMIT_SPOTLIGHTS (8) of those per
// page load. Across the 25-card set cross-card paper overlap is low (~88% of
// candidate pairs share no papers), but a couple of parent topics are
// containment-nested near-duplicates the producer's clone gate intentionally
// exempts — e.g. "Cancer Genomics & Molecular Oncology" vs "Genomics &
// Multi-Omic Profiling" share ~78% of their papers. At top-9 these rarely
// co-occurred; drawing 8 of 25 can surface both, which reads as a duplicate.
//
// This is the card-level analogue of `hasKeyAuthorCollision`: if a drawn set
// contains two cards whose displayed papers overlap by at least
// CARD_OVERLAP_THRESHOLD (min-cardinality / overlap coefficient over
// papers[].pmid), re-draw — up to MAX_CARD_REDRAWS times — then accept the
// final draw. The signal is article (PMID) overlap, not author overlap: author
// overlap stays low across the set, while the near-dup pairs collide at the
// paper level. The component injects the (unseeded, per-page-load) shuffle so
// the selection still rotates on every visit.

/** Overlap coefficient at/above which two drawn cards read as near-duplicates. */
const CARD_OVERLAP_THRESHOLD = 0.4;
/** Re-draw attempts after the initial draw before accepting a colliding set. */
const MAX_CARD_REDRAWS = 3;

/** Minimal shape the card guard needs: a card's displayed papers, by PMID. */
type PaperedCard = { papers: ReadonlyArray<{ pmid: string }> };

/**
 * Min-cardinality (overlap) coefficient of two cards' displayed PMIDs:
 * `|A ∩ B| / min(|A|, |B|)`. 1.0 means one card's papers are a subset of the
 * other's; 0 means disjoint. A card with no papers yields 0 (nothing to
 * compare). Min-cardinality, not Jaccard, so a small card fully contained in a
 * larger one still scores 1.0 and is caught.
 */
export function cardPaperOverlap(a: PaperedCard, b: PaperedCard): number {
  const aPmids = new Set(a.papers.map((p) => p.pmid));
  const bPmids = new Set(b.papers.map((p) => p.pmid));
  if (aPmids.size === 0 || bPmids.size === 0) return 0;
  let shared = 0;
  for (const pmid of aPmids) if (bPmids.has(pmid)) shared++;
  return shared / Math.min(aPmids.size, bPmids.size);
}

/**
 * True when any two cards in the set share at least `threshold` of their
 * displayed papers — i.e. the set contains a near-duplicate pair the visitor
 * would read as the same work surfaced under two near-identical topics.
 */
export function hasNearDuplicateCardPair(
  cards: readonly PaperedCard[],
  threshold: number = CARD_OVERLAP_THRESHOLD,
): boolean {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (cardPaperOverlap(cards[i], cards[j]) >= threshold) return true;
    }
  }
  return false;
}

/**
 * Draw `count` cards from `pool` using the supplied `shuffle`, re-drawing up to
 * `MAX_CARD_REDRAWS` times if the drawn set contains a near-duplicate pair (two
 * cards overlapping by ≥ `CARD_OVERLAP_THRESHOLD` of their displayed PMIDs). The
 * final draw is accepted unconditionally, so the work is bounded when the pool
 * is small or genuinely dup-dense.
 *
 * `shuffle` is injected — the home component passes an unseeded Math.random
 * shuffle so the selection re-rotates per page load; passing a seeded shuffle
 * makes the guard deterministically testable.
 */
export function sampleDistinctCards<T extends PaperedCard>(
  pool: readonly T[],
  count: number,
  shuffle: (arr: readonly T[]) => T[],
): T[] {
  let draw: T[] = [];
  for (let attempt = 0; attempt <= MAX_CARD_REDRAWS; attempt++) {
    draw = shuffle(pool).slice(0, count);
    if (!hasNearDuplicateCardPair(draw)) break;
  }
  return draw;
}
