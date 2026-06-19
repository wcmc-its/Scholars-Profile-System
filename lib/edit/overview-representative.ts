/**
 * §5.1 of the overview-generator selection spec — how the **Recommended**
 * publication set is computed. Pure + deterministic so the scoring and the
 * coverage pass are unit-testable without a DB or a clock (the caller passes
 * `nowYear`); the data-loading lives in `overview-facts.ts`.
 *
 * Two stages, exactly as the spec lays them out:
 *
 *   Stage 1 — per-paper score (the ORDER):
 *       score = impact_tier × recency_weight(year) × author_position_weight
 *     - impact_tier: a coarse 3-tier weight (core / supporting / minor), derived
 *       from where the paper sits in THIS scholar's own scored-impact distribution
 *       (quantiles) rather than an absolute cut — the raw ReciterAI impact scale is
 *       not fixed across cohorts, and "central vs minor" is meaningful relative to
 *       the scholar's own corpus (§4.2 "this is central, these are minor").
 *     - recency_weight: a GENTLE decay toward older work with a LANDMARK FLOOR — a
 *       paper in the scholar's top impact quantile is pinned to weight 1.0 and is
 *       never dropped by the coverage pass, so a 2015 landmark never falls below a
 *       2024 minor paper.
 *     - author_position_weight: first/last (work you DROVE) outweighs middle.
 *
 *   Stage 2 — coverage pass (the REPRESENTATIVENESS): walk the score-ordered list
 *     greedily, building the featured set, applying topic spread (a soft per-area
 *     cap so the set spans the scholar's areas instead of stacking the hottest
 *     cluster), near-duplicate dedup (one paper stands in for a study/program
 *     cluster), and a landmark guarantee (a landmark is featured even if its area
 *     is already covered).
 *
 * The raw score and the tier are BACKEND-ONLY (§4.3): they produce the order and a
 * weight the generator consumes, never a number the user sees. The per-record
 * `reason` is the only user-facing artifact here, and it is deliberately
 * numberless (§3.2 — reveals show reasons, never figures).
 */

/** The coarse 3-tier weight (§4.2). Backend-only — never a user-facing label. */
export type RepresentativeTier = "core" | "supporting" | "minor";

/** Author position relative to the byline — drives the centrality weight. */
export type RepresentativeAuthorPosition = "first" | "last" | "middle";

/** One candidate publication, as the facts loader projects it for ranking. */
export type RepresentativeCandidate = {
  pmid: string;
  /** Raw ReciterAI impact score (0–100-ish); `null` when unscored. */
  impact: number | null;
  /** Publication year; `null` when unknown (treated as oldest for decay). */
  year: number | null;
  /** Byline position; `null` when the authorship row is missing a flag. */
  authorPosition: RepresentativeAuthorPosition | null;
  /** Primary research-area id, for topic spread + per-area dedup. `null` ⇒ the
   *  paper participates in no area cap (it can always be featured on score). */
  topicAreaId: string | null;
  /** Near-duplicate cluster key (same study / program — e.g. a trial's main +
   *  companion papers). Candidates sharing a non-null key collapse to one in the
   *  featured set. `null`/absent ⇒ the paper is its own cluster. */
  clusterKey?: string | null;
};

/** A ranked candidate: its order, its backend tier, and the user-facing reason. */
export type RepresentativeRanked = {
  pmid: string;
  /** 0-based position in the full score-descending order (the Recommended sort). */
  rank: number;
  /** Coarse weight for the generator (§4.2) — NOT shown to the user. */
  tier: RepresentativeTier;
  /** Top impact-quantile work, protected from recency decay + coverage drop. */
  isLandmark: boolean;
  /** Chosen into the auto-set (Feedstock) by the coverage pass; the rest are the
   *  Available tail, reachable but not in by default. */
  featured: boolean;
  /** Numberless "why this?" string (§3.2 / §7) — safe to render. */
  reason: string;
  /** The Stage-1 score. BACKEND-ONLY — exposed for ordering/tests, never UI. */
  score: number;
};

/** Tunable knobs for the ranking. Defaults encode the spec's intent; every value
 *  is overridable so the thresholds can be calibrated without a code change. */
export type RepresentativeOptions = {
  /** Year the decay is measured against (pass the request clock; defaults to the
   *  current UTC year). Explicit ⇒ deterministic tests. */
  nowYear?: number;
  /** Size of the featured (Feedstock) set. */
  featuredLimit?: number;
  /** Impact quantile at/above which a paper is a LANDMARK (recency floor + never
   *  dropped). 0.9 ⇒ the scholar's top ~10% by impact. */
  landmarkQuantile?: number;
  /** Quantile cut points for the core / supporting / minor impact tiers. */
  coreQuantile?: number;
  supportingQuantile?: number;
  /** Per-year multiplicative decay and its floor (gentle — it breaks ties, it
   *  does not dominate; pubs are whole-career, §2.4). */
  recencyDecayPerYear?: number;
  recencyFloor?: number;
  /** A paper this many years old or newer reads as "recent" in the reason copy. */
  recentWithinYears?: number;
  /** Soft per-area cap in the coverage pass — a dominant area may take this many
   *  before further papers in it defer to the Available tail (landmarks exempt). */
  maxPerArea?: number;
};

const DEFAULTS = {
  landmarkQuantile: 0.9,
  coreQuantile: 0.66,
  supportingQuantile: 0.33,
  recencyDecayPerYear: 0.02,
  recencyFloor: 0.5,
  recentWithinYears: 5,
  maxPerArea: 2,
  featuredLimit: 12,
} as const;

/** The multiplicative weight each impact tier contributes to the Stage-1 score. */
const TIER_WEIGHT: Record<RepresentativeTier, number> = {
  core: 1,
  supporting: 0.66,
  minor: 0.4,
};

/** Centrality weight by byline position — first/last (drove it) > middle. */
const AUTHOR_WEIGHT: Record<RepresentativeAuthorPosition | "none", number> = {
  first: 1,
  last: 1,
  middle: 0.6,
  none: 0.8,
};

/**
 * The impact value at quantile `q` of a sorted-ascending list (linear
 * interpolation). Used to turn the scholar's own impact distribution into tier
 * and landmark cut points. Returns `null` for an empty list.
 */
function quantile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function authorWeight(p: RepresentativeAuthorPosition | null): number {
  return AUTHOR_WEIGHT[p ?? "none"];
}

/** A numberless reason for why a paper is (or could be) featured. The dominant
 *  factor wins; never mentions a score, count, or year value (§3.2). */
function reasonFor(
  c: RepresentativeCandidate,
  tier: RepresentativeTier,
  isLandmark: boolean,
  isRecent: boolean,
): string {
  const led = c.authorPosition === "first" || c.authorPosition === "last";
  if (isLandmark) return led ? "A landmark you led" : "A landmark in your field";
  if (led && isRecent) return "Recent work you led";
  if (led) return "Senior-author work";
  if (tier === "core") return isRecent ? "Recent high-impact work" : "High-impact work";
  if (isRecent) return "Recent work";
  return "Part of your published record";
}

/**
 * Rank a scholar's candidate publications into the Recommended order (§5.1) and
 * mark the featured (auto-set) subset. Returns EVERY candidate, score-descending,
 * each tagged with its tier, landmark flag, featured flag, and reason — the
 * caller renders the featured ones as Feedstock and the rest as the Available
 * tail. Pure; input order is irrelevant.
 */
export function rankRepresentativePublications(
  candidates: RepresentativeCandidate[],
  options: RepresentativeOptions = {},
): RepresentativeRanked[] {
  const nowYear = options.nowYear ?? new Date().getUTCFullYear();
  const featuredLimit = options.featuredLimit ?? DEFAULTS.featuredLimit;
  const landmarkQ = options.landmarkQuantile ?? DEFAULTS.landmarkQuantile;
  const coreQ = options.coreQuantile ?? DEFAULTS.coreQuantile;
  const supportingQ = options.supportingQuantile ?? DEFAULTS.supportingQuantile;
  const decay = options.recencyDecayPerYear ?? DEFAULTS.recencyDecayPerYear;
  const floor = options.recencyFloor ?? DEFAULTS.recencyFloor;
  const recentWithin = options.recentWithinYears ?? DEFAULTS.recentWithinYears;
  const maxPerArea = options.maxPerArea ?? DEFAULTS.maxPerArea;

  if (candidates.length === 0) return [];

  // Tier + landmark cut points from THIS scholar's scored-impact distribution.
  const impacts = candidates
    .map((c) => c.impact)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const landmarkCut = quantile(impacts, landmarkQ);
  const coreCut = quantile(impacts, coreQ);
  const supportingCut = quantile(impacts, supportingQ);

  function tierOf(impact: number | null): RepresentativeTier {
    if (impact === null || coreCut === null) return "minor";
    if (coreCut !== null && impact >= coreCut) return "core";
    if (supportingCut !== null && impact >= supportingCut) return "supporting";
    return "minor";
  }
  function isLandmarkImpact(impact: number | null): boolean {
    // A landmark needs a real impact AND at least two scored papers to compare
    // against — a lone scored paper is not "the famous one", it is the only one.
    return impact !== null && landmarkCut !== null && impacts.length >= 2 && impact >= landmarkCut;
  }

  // Stage 1 — score every candidate.
  const scored = candidates.map((c) => {
    const tier = tierOf(c.impact);
    const landmark = isLandmarkImpact(c.impact);
    const age = c.year === null ? null : Math.max(0, nowYear - c.year);
    const recencyWeight = landmark ? 1 : age === null ? floor : Math.max(floor, 1 - decay * age);
    const isRecent = age !== null && age <= recentWithin;
    const score = TIER_WEIGHT[tier] * recencyWeight * authorWeight(c.authorPosition);
    return {
      c,
      tier,
      landmark,
      isRecent,
      score,
      reason: reasonFor(c, tier, landmark, isRecent),
    };
  });

  // Deterministic score-descending order: score, then newer year, then pmid.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ay = a.c.year ?? -Infinity;
    const by = b.c.year ?? -Infinity;
    if (by !== ay) return by - ay;
    return a.c.pmid < b.c.pmid ? -1 : a.c.pmid > b.c.pmid ? 1 : 0;
  });

  // Stage 2 — coverage pass. Landmarks are guaranteed in first (so they are never
  // crowded out of the budget), then the greedy spread/dedup fills the remainder.
  const featured = new Set<string>();
  const usedClusters = new Set<string>();
  const areaCount = new Map<string, number>();

  function take(s: (typeof scored)[number]): void {
    featured.add(s.c.pmid);
    if (s.c.clusterKey) usedClusters.add(s.c.clusterKey);
    if (s.c.topicAreaId) areaCount.set(s.c.topicAreaId, (areaCount.get(s.c.topicAreaId) ?? 0) + 1);
  }

  for (const s of scored) {
    if (s.landmark && featured.size < featuredLimit) take(s);
  }
  for (const s of scored) {
    if (featured.size >= featuredLimit) break;
    if (featured.has(s.c.pmid)) continue;
    // Dedup: a non-landmark sharing a cluster with an already-featured paper waits
    // in the Available tail (one paper stands in for the study/program).
    if (s.c.clusterKey && usedClusters.has(s.c.clusterKey)) continue;
    // Topic spread: a non-landmark whose area is already at the soft cap defers.
    if (s.c.topicAreaId && (areaCount.get(s.c.topicAreaId) ?? 0) >= maxPerArea) continue;
    take(s);
  }

  return scored.map((s, rank) => ({
    pmid: s.c.pmid,
    rank,
    tier: s.tier,
    isLandmark: s.landmark,
    featured: featured.has(s.c.pmid),
    // Single out the strongest paper so a corpus of landmarks doesn't read as one
    // repeated "A landmark you led" line. The top-ranked landmark is THE standout;
    // the rest keep their (recency / role / tier-graduated) reasons. Numberless.
    reason: rank === 0 && s.landmark && scored.length >= 2 ? "Your most influential paper" : s.reason,
    score: s.score,
  }));
}
