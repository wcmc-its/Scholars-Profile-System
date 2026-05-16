/**
 * Seeded, deterministic publication sampling for the home-page Spotlight (#286).
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
