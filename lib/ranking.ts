/**
 * Publication ranking formulas per spec lines 70-95.
 *
 * Two parallel rankings on the profile page:
 *
 *   highlight_score = authorship_points + type_points + impact_points
 *     - authorship_points: 5 (first or last) | 2 (second or penultimate) | 0 (middle)
 *     - type_points (table at spec line 100):
 *         Academic Article 4, Review 2, Case Report 2, Preprint 1,
 *         Letter 0, Editorial Article 0, Erratum 0
 *     - impact_points: log10(citation_count + 1) × 2, capped at 6
 *     Sort: highlight_score desc; tiebreak by citation_count desc, then
 *     date_added_to_entrez desc. Display top 3.
 *     Filter: errata never appear (spec line 118).
 *
 *   recent_score = recency_score + authorship_points + type_points + impact_points
 *     - recency_score: 8 × exp(-age_years / 5), capped at 8
 *       (smooth exponential decay, no bucket cliffs)
 *     - age_years measured from date_added_to_entrez
 *     Sort: recent_score desc; tiebreak by date_added_to_entrez desc.
 *     Display 10 by default with "Show all" expander.
 *
 * Both lists filter to ReCiter-confirmed authorships (spec line 118).
 */

const TYPE_POINTS: Record<string, number> = {
  "Academic Article": 4,
  Review: 2,
  "Case Report": 2,
  Preprint: 1,
  Letter: 0,
  "Editorial Article": 0,
  Erratum: 0,
};

const IMPACT_CAP = 6;
const RECENCY_CAP = 8;
const RECENCY_DECAY_YEARS = 5;
const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365.25;

export type AuthorshipPosition = {
  isFirst: boolean;
  isLast: boolean;
  isPenultimate: boolean;
};

export function authorshipPoints(pos: AuthorshipPosition): number {
  if (pos.isFirst || pos.isLast) return 5;
  if (pos.isPenultimate) return 2;
  return 0;
}

export function typePoints(publicationType: string | null | undefined): number {
  if (!publicationType) return 0;
  return TYPE_POINTS[publicationType] ?? 0;
}

export function impactPoints(citationCount: number): number {
  if (citationCount <= 0) return 0;
  return Math.min(IMPACT_CAP, Math.log10(citationCount + 1) * 2);
}

export function recencyScore(dateAddedToEntrez: Date | null | undefined, now: Date = new Date()): number {
  if (!dateAddedToEntrez) return 0;
  const ageMs = now.getTime() - dateAddedToEntrez.getTime();
  if (ageMs < 0) return RECENCY_CAP; // future dates pin to max
  const ageYears = ageMs / MS_PER_YEAR;
  return Math.min(RECENCY_CAP, RECENCY_CAP * Math.exp(-ageYears / RECENCY_DECAY_YEARS));
}

export type RankablePublication = {
  pmid: string;
  publicationType: string | null;
  citationCount: number;
  dateAddedToEntrez: Date | null;
  authorship: AuthorshipPosition;
  isConfirmed: boolean;
};

export type ScoredPublication<T extends RankablePublication = RankablePublication> = T & {
  authorshipPoints: number;
  typePoints: number;
  impactPoints: number;
  highlightScore: number;
  recencyScore: number;
  recentScore: number;
};

function score<T extends RankablePublication>(p: T, now: Date): ScoredPublication<T> {
  const ap = authorshipPoints(p.authorship);
  const tp = typePoints(p.publicationType);
  const ip = impactPoints(p.citationCount);
  const rs = recencyScore(p.dateAddedToEntrez, now);
  return {
    ...p,
    authorshipPoints: ap,
    typePoints: tp,
    impactPoints: ip,
    highlightScore: ap + tp + ip,
    recencyScore: rs,
    recentScore: rs + ap + tp + ip,
  };
}

/**
 * Score and rank for the "Selected highlights" section.
 * Filters: confirmed authorships only; errata never appear.
 * Sort: highlight_score desc, citation_count desc, dateAddedToEntrez desc.
 * Caller slices `.slice(0, 3)` for the top-3 display.
 */
export function rankForHighlights<T extends RankablePublication>(
  pubs: readonly T[],
  now: Date = new Date(),
): ScoredPublication<T>[] {
  return pubs
    .filter((p) => p.isConfirmed && p.publicationType !== "Erratum")
    .map((p) => score(p, now))
    .sort(
      (a, b) =>
        b.highlightScore - a.highlightScore ||
        b.citationCount - a.citationCount ||
        timeOf(b.dateAddedToEntrez) - timeOf(a.dateAddedToEntrez),
    );
}

/**
 * Score and rank for the "Recent publications" section.
 * Filters: confirmed authorships only.
 * Sort: recent_score desc, dateAddedToEntrez desc.
 * Caller slices `.slice(0, 10)` for the default display; "Show all" reveals the rest.
 */
export function rankForRecent<T extends RankablePublication>(
  pubs: readonly T[],
  now: Date = new Date(),
): ScoredPublication<T>[] {
  return pubs
    .filter((p) => p.isConfirmed)
    .map((p) => score(p, now))
    .sort(
      (a, b) =>
        b.recentScore - a.recentScore ||
        timeOf(b.dateAddedToEntrez) - timeOf(a.dateAddedToEntrez),
    );
}

function timeOf(d: Date | null | undefined): number {
  return d ? d.getTime() : 0;
}
