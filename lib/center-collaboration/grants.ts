/**
 * Pure helpers for the grant co-investigator axis (#1137 Phase 2).
 *
 * DB-free and deterministic — shared by the client component, the standalone-HTML
 * export, and the unit tests, exactly like `graph.ts`. The server emits the
 * gated `CollabAward[]` (already suppression-filtered); the browser applies the
 * umbrella / active / year filters here and feeds the survivors to the SAME
 * group-agnostic edge builders in `graph.ts`.
 *
 * See `docs/grant-coinvestigator-axis-handoff.md` §4, §6–§7.
 */
import type { CollabAward } from "./types";

/**
 * NIH center / training / instrument mechanisms whose shared awards reflect
 * institutional infrastructure, NOT co-investigation (handoff §4 — a CTSA `UL1`,
 * a cancer-center `P30`, a SPORE `P50`, a `U54` lists many members who share
 * funding but do not co-investigate). Excluded from edge-building by default.
 * Compared case-insensitively against the NIH-derived `Grant.mechanism`.
 */
export const UMBRELLA_MECHANISMS: ReadonlySet<string> = new Set([
  "P30",
  "P50",
  "U54",
  "UL1",
  "S10",
  "KL2",
  "TL1",
]);

/**
 * Member-count floor at/above which a shared award is treated as umbrella
 * regardless of mechanism. Catches null-mechanism foundation / consortium
 * umbrellas the mechanism list alone misses (e.g. the handoff's PICI award, 15
 * members). Set above any plausible real co-investigation group so it only trips
 * on genuine institutional awards.
 */
export const UMBRELLA_MEMBER_FLOOR = 12;

/**
 * Whether a shared award is an umbrella / infrastructure award: a center/training
 * mechanism, OR a member count at/above {@link UMBRELLA_MEMBER_FLOOR}. Computed
 * server-side per award over the gated member set; the boolean rides in the
 * payload so the client filter stays a cheap predicate.
 */
export function isUmbrellaAward(
  mechanisms: ReadonlyArray<string | null>,
  memberCount: number,
): boolean {
  if (memberCount >= UMBRELLA_MEMBER_FLOOR) return true;
  for (const m of mechanisms) {
    if (m && UMBRELLA_MECHANISMS.has(m.toUpperCase())) return true;
  }
  return false;
}

/**
 * Inclusive overlap of an award's `[year, endYear]` span with a year range.
 * Unlike a paper (a single point in time), a grant spans years, so the year
 * filter is an OVERLAP test — an award active across the window is kept even if
 * it started before it. A `null` bound is open; a fully-undated award is dropped
 * once a bound is set (it cannot be placed), mirroring `paperInYear`.
 */
export function awardInYearRange(
  a: CollabAward,
  range?: [number | null, number | null],
): boolean {
  if (!range) return true;
  const [lo, hi] = range;
  if (lo == null && hi == null) return true;
  const start = a.year ?? a.endYear;
  const end = a.endYear ?? a.year;
  if (start == null || end == null) return false; // fully undated under a filter
  const s = Math.min(start, end);
  const e = Math.max(start, end);
  if (hi != null && s > hi) return false;
  if (lo != null && e < lo) return false;
  return true;
}

export interface AwardFilterOptions {
  /** Drop umbrella/infrastructure awards (the §4 clique fix). Default off here;
   *  the component defaults the checkbox ON. */
  excludeUmbrella?: boolean;
  /** Keep only awards with ≥1 active (`endDate ≥ today`) grouped row. */
  activeOnly?: boolean;
  /** Inclusive year-overlap range `[min, max]`; a `null` bound is open. */
  yearRange?: [number | null, number | null];
}

/**
 * Apply the grant-axis filters (umbrella / active / year-overlap) to the award
 * set before edge-building. Pure + deterministic; the survivors are `CollabGroup`s
 * fed straight to the group-agnostic builders in `graph.ts`.
 */
export function filterAwards(
  awards: readonly CollabAward[],
  opts: AwardFilterOptions = {},
): CollabAward[] {
  return awards.filter((a) => {
    if (opts.excludeUmbrella && a.umbrella) return false;
    if (opts.activeOnly && !a.active) return false;
    if (!awardInYearRange(a, opts.yearRange)) return false;
    return true;
  });
}

/**
 * Count the umbrella awards the filter DROPS for the umbrella reason specifically
 * (after the active / year filters) — for the never-silent "N umbrella awards
 * (P30/P50/UL1…) excluded" footer line, mirroring Phase 1's omitted-papers count.
 */
export function countUmbrellaExcluded(
  awards: readonly CollabAward[],
  opts: { activeOnly?: boolean; yearRange?: [number | null, number | null] } = {},
): number {
  let n = 0;
  for (const a of awards) {
    if (!a.umbrella) continue;
    if (opts.activeOnly && !a.active) continue;
    if (!awardInYearRange(a, opts.yearRange)) continue;
    n += 1;
  }
  return n;
}

/** Min/max year across award spans (start + end), for the grant-axis slider bounds. */
export function awardYearExtent(
  awards: readonly CollabAward[],
): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of awards) {
    for (const y of [a.year, a.endYear]) {
      if (y == null) continue;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// "Both" axis (handoff §6.2 option C) — one edge per pair, colored by the kind
// of relationship: pub-only, grant-only, or BOTH (the analytically strong ties).
// ---------------------------------------------------------------------------

export type Relationship = "pub" | "grant" | "both";

export interface MergedEdge<K extends number | string> {
  a: K;
  b: K;
  rel: Relationship;
  /** Raw shared-paper count (0 if no pub tie). */
  pubWeight: number;
  /** Raw shared-award count (0 if no grant tie). */
  grantWeight: number;
  /** Combined strength for edge width / physics (max of the two strengths). */
  strength: number;
}

type AxisEdge<K extends number | string> = {
  a: K;
  b: K;
  weight: number;
  strength?: number;
};

/**
 * Merge a (threshold-filtered) publication-edge set and a grant-edge set by member
 * pair into one relationship-colored edge set (option C). Generic over the node
 * key so it serves both the people rollup (numeric indices) and the program
 * rollup (string keys). Both inputs must already use the SAME canonical pair
 * ordering (`graph.ts` emits `a<b` for people, `a<=b` for programs), so the same
 * pair lands on the same map key.
 */
export function mergeAxisEdges<K extends number | string>(
  pub: ReadonlyArray<AxisEdge<K>>,
  grant: ReadonlyArray<AxisEdge<K>>,
): MergedEdge<K>[] {
  const map = new Map<string, MergedEdge<K>>();
  const keyOf = (a: K, b: K) => `${a}|${b}`;
  for (const e of pub) {
    map.set(keyOf(e.a, e.b), {
      a: e.a,
      b: e.b,
      rel: "pub",
      pubWeight: e.weight,
      grantWeight: 0,
      strength: e.strength ?? e.weight,
    });
  }
  for (const e of grant) {
    const k = keyOf(e.a, e.b);
    const ex = map.get(k);
    if (ex) {
      ex.rel = "both";
      ex.grantWeight = e.weight;
      ex.strength = Math.max(ex.strength, e.strength ?? e.weight);
    } else {
      map.set(k, {
        a: e.a,
        b: e.b,
        rel: "grant",
        pubWeight: 0,
        grantWeight: e.weight,
        strength: e.strength ?? e.weight,
      });
    }
  }
  return [...map.values()];
}

/**
 * Merge the two axes' RAW (unthresholded) edge sets, then keep the pairs whose
 * STRONGER tie meets `min`. The threshold must be applied AFTER the merge — not
 * per-axis before it — so a pair that publishes a lot but shares only one grant
 * (pub=3, grant=1, min=2) is still classified `both` (green), not silently
 * downgraded to a single-axis tie. Both the people and program "Both" overlays
 * call this, so the two views never disagree on an edge's color. Pass each axis'
 * UNFILTERED edge list (the single-axis paths keep their own per-axis threshold).
 */
export function mergeAxisEdgesThresholded<K extends number | string>(
  pub: ReadonlyArray<AxisEdge<K>>,
  grant: ReadonlyArray<AxisEdge<K>>,
  min: number,
): MergedEdge<K>[] {
  return mergeAxisEdges(pub, grant).filter(
    (e) => Math.max(e.pubWeight, e.grantWeight) >= min,
  );
}
