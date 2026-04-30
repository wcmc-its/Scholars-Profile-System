/**
 * Variant B publication-ranking math.
 *
 * Multiplicative formula:
 *   score = reciterai_impact × authorship_weight × pub_type_weight × recency_weight
 *
 * Four surface-keyed recency curves; per-publication scoring fn parameterized
 * by curve. Per-scholar aggregation for the Top scholars chip row sums
 * per-publication scores with first-or-senior author filtering.
 *
 * Sources:
 *   - design-spec-v1.7.1.md:1062-1180 — formula, recency curves, worked examples
 *   - 02-CONTEXT.md D-06: Phase 2 retrofits profile pages to Variant B (no shim)
 *   - 02-CONTEXT.md D-07: recency curves transcribed verbatim from spec
 *   - 02-CONTEXT.md D-08: reciterai_impact sourced from publication_score.score
 *   - 02-CONTEXT.md D-13: per-scholar aggregation = SUM over first-or-senior papers
 *   - 02-CONTEXT.md D-14: Top scholars uses compressed top_scholars curve, FT-faculty-only carve
 *   - design-spec-v1.7.1.md:1150-1173 — three worked examples (unit-test fixtures)
 *
 * Calibration: weights reviewed six months post-launch by ReCiter lead +
 * methodology page owner per spec lines 1175-1180.
 */

export type RecencyCurve =
  | "selected_highlights"
  | "recent_highlights"
  | "recent_contributions"
  | "top_scholars";

export type AuthorshipPosition = {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
};

export type RankablePublication = {
  pmid: string;
  publicationType: string | null;
  reciteraiImpact: number;
  dateAddedToEntrez: Date | null;
  authorship: AuthorshipPosition;
  isConfirmed: boolean;
};

export type ScoredPublication<T extends RankablePublication = RankablePublication> = T & {
  score: number;
};

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * (365.25 / 12);

function monthsBetween(date: Date | null, now: Date): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const ageMs = now.getTime() - date.getTime();
  if (ageMs < 0) return 0; // future-dated rows pin to "today"
  return ageMs / MS_PER_MONTH;
}

/**
 * Pub-type weights — Letters / Editorial Articles / Errata = 0 (hard exclude
 * from highlight surfaces, locked by design spec v1.7.1 + CLAUDE.md constraint).
 */
const PUB_TYPE_WEIGHTS: Record<string, number> = {
  "Academic Article": 1.0,
  Review: 0.7,
  "Case Report": 0.5,
  Preprint: 0.7,
  Letter: 0,
  "Editorial Article": 0,
  Erratum: 0,
};

/**
 * Recency curves transcribed verbatim from design-spec-v1.7.1.md:1103-1145.
 *
 * top_scholars is the compressed Phase 2 D-14 curve (Option A, recency-preferring,
 * less dramatic spread) — NOT an alias of recent_highlights. Locking comment so
 * the divergence survives future curve edits.
 */
const RECENCY_CURVES: Record<RecencyCurve, (m: number) => number> = {
  // selected_highlights — design-spec-v1.7.1.md:1107-1113
  selected_highlights: (m) => {
    if (m < 6) return 0;
    if (m < 18) return 0.7;
    if (m < 120) return 1.0; // 18mo–10yr peak
    if (m < 240) return 0.7; // 10–20yr
    return 0.5; // 20+yr
  },
  // recent_highlights — design-spec-v1.7.1.md:1115-1123
  recent_highlights: (m) => {
    if (m < 3) return 0.4;
    if (m < 6) return 0.7;
    if (m < 18) return 1.0; // 6–18mo peak
    if (m < 36) return 0.8; // 18–36mo
    return 0.4; // 3yr+
  },
  // recent_contributions — same shape as recent_highlights per design-spec-v1.7.1.md:1125
  recent_contributions: (m) => {
    if (m < 3) return 0.4;
    if (m < 6) return 0.7;
    if (m < 18) return 1.0;
    if (m < 36) return 0.8;
    return 0.4;
  },
  // top_scholars — 02-CONTEXT.md D-14 (Phase 2 compressed Option A; distinct curve, NOT aliased)
  top_scholars: (m) => {
    if (m < 3) return 0.7;
    if (m < 36) return 1.0; // 3mo–3yr peak
    if (m < 72) return 0.85; // 3–6yr
    return 0.7; // 6yr+ (won't fire until 2027 given 2020+ ReCiterAI floor)
  },
};

/**
 * Authorship weight for the multiplicative formula.
 *
 * Scholar-centric surfaces (Selected highlights, Recent contributions,
 * profile most-recent-papers feed, Top scholars chip-row aggregation):
 *   first OR last → 1.0; everything else (2nd, penultimate, middle) → 0.
 *   This is a FILTER, not a down-weight, per CONTEXT.md D-13/D-14.
 *
 * Publication-centric surfaces (Topic Recent highlights):
 *   any authorship position → 1.0. The pool is publication-centric per
 *   CONTEXT.md D-13 — no first/senior filter at pool selection.
 */
export function authorshipWeight(pos: AuthorshipPosition, scholarCentric: boolean): number {
  if (!scholarCentric) return 1.0;
  if (pos.isFirst || pos.isLast) return 1.0;
  return 0;
}

export function pubTypeWeight(publicationType: string | null | undefined): number {
  if (!publicationType) return 0;
  return PUB_TYPE_WEIGHTS[publicationType] ?? 0;
}

export function recencyWeight(ageMonths: number, curve: RecencyCurve): number {
  return RECENCY_CURVES[curve](ageMonths);
}

/**
 * Per-publication score under the chosen surface curve.
 * scholarCentric=true applies the first/senior author filter (D-13/D-14);
 * scholarCentric=false treats every authorship position as 1.0 (Topic Recent highlights).
 *
 * Returns 0 for unconfirmed authorships, hard-excluded pub types, and rows
 * filtered out by authorship weight on scholar-centric surfaces.
 */
export function scorePublication(
  p: RankablePublication,
  curve: RecencyCurve,
  scholarCentric: boolean,
  now: Date = new Date(),
): number {
  if (!p.isConfirmed) return 0;
  const aw = authorshipWeight(p.authorship, scholarCentric);
  if (aw === 0) return 0;
  const tw = pubTypeWeight(p.publicationType);
  if (tw === 0) return 0;
  const ageMonths = monthsBetween(p.dateAddedToEntrez, now);
  const rw = recencyWeight(ageMonths, curve);
  return p.reciteraiImpact * aw * tw * rw;
}

/**
 * Per-scholar aggregation for the Top scholars chip row (CONTEXT.md D-13/D-14).
 *
 * Sums per-publication scores (scholar-centric, so first/senior filter applies).
 * Defaults to the top_scholars compressed recency curve. Plan 08 calls this
 * once per scholar within a topic's pub set; the FT-faculty-only carve happens
 * upstream in the consumer's eligibility filter, not here.
 */
export function aggregateScholarScore(
  pubs: readonly RankablePublication[],
  curve: RecencyCurve = "top_scholars",
  now: Date = new Date(),
): number {
  return pubs.reduce((sum, p) => sum + scorePublication(p, curve, true, now), 0);
}

/**
 * Generic "rank for surface" helper used by the surface-specific wrappers.
 * Scores every publication, drops zero-scored rows, sorts descending by score.
 */
function rankBy<T extends RankablePublication>(
  pubs: readonly T[],
  curve: RecencyCurve,
  scholarCentric: boolean,
  now: Date = new Date(),
): ScoredPublication<T>[] {
  return pubs
    .map((p) => ({ ...p, score: scorePublication(p, curve, scholarCentric, now) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Profile Selected highlights — scholar-centric (first/senior filter). */
export function rankForSelectedHighlights<T extends RankablePublication>(
  pubs: readonly T[],
  now?: Date,
): ScoredPublication<T>[] {
  return rankBy(pubs, "selected_highlights", true, now);
}

/**
 * Profile most-recent-papers feed — scholar-centric.
 *
 * Curve choice (deliberate): reuses the `recent_contributions` curve — same
 * shape as the home Recent contributions surface — because both are recent
 * scholar-attributed views of a person's first/senior-author work. The
 * 6–18 month peak matches the surface's intent (year-grouped, recency-sorted
 * display on the profile).
 *
 * Alternative considered and rejected: the `selected_highlights` curve peaks
 * at 18mo–10yr, which would over-weight older work in a feed meant to surface
 * the scholar's most recent contributions.
 *
 * Documented publicly on the methodology page footnote (Plan 06). This is a
 * fifth call site of the recent_contributions curve beyond the four spec-defined
 * surfaces; the choice is intentional.
 */
export function rankForRecentFeed<T extends RankablePublication>(
  pubs: readonly T[],
  now?: Date,
): ScoredPublication<T>[] {
  return rankBy(pubs, "recent_contributions", true, now);
}

/** Home Recent contributions — scholar-centric. */
export function rankForRecentContributions<T extends RankablePublication>(
  pubs: readonly T[],
  now?: Date,
): ScoredPublication<T>[] {
  return rankBy(pubs, "recent_contributions", true, now);
}

/** Topic Recent highlights — publication-centric (no authorship filter). */
export function rankForRecentHighlights<T extends RankablePublication>(
  pubs: readonly T[],
  now?: Date,
): ScoredPublication<T>[] {
  return rankBy(pubs, "recent_highlights", false, now);
}
