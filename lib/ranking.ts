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

// ---------------------------------------------------------------------------
// Research-area signals: PI grants and PI clinical trials (TOPIC_RANK_AREA_SIGNALS)
//
// Ported from the 2026-10-14 pilot builder, which passed Gate 2 as "option A":
// grants and trials add to the totals of scholars who ALREADY rank in an area
// on their first/last-author papers, and never add anyone (blind raters picked
// option A at W = 2 for 111 of 120 visible slots vs 87 for papers only). The
// consumer (lib/api/topics.ts) enforces "never add"; these functions only score.
// ---------------------------------------------------------------------------

/**
 * Paper-equivalents per grant project or trial, at full recency and an area
 * score of 1. The pilot tested W = 1 and W = 2 (W = 2 won in every area); a
 * weight above 2 was never tested, so tuning is a one-line change here.
 */
export const AREA_SIGNAL_WEIGHT = 2;

/**
 * W at SUBAREA grain (TOPIC_SUBAREA_RANK_AREA_SIGNALS, `getSubtopicScholars`).
 * Subarea paper totals are a fraction of area totals, so one grant weighs more
 * there. The V2 blind test (2026-10-19, 10 subareas) picked W = 1: it beat or
 * tied papers only in every subarea, and W = 2 made the same swaps plus three
 * that dropped rows raters liked. Cap and recency are the area-level ones.
 */
export const AREA_SIGNAL_SUBAREA_WEIGHT = 1;

/**
 * Grant projects and trials counted per scholar-area, each kind separately. The
 * pilot's backtest hit rate saturated at about three grants in an area (28% at
 * 1, 37% at 2, 56% at 3-4, 56% at 5+), so a fourth adds nothing but volume.
 */
export const AREA_SIGNAL_CAP = 3;

/**
 * Recency from START date (end dates move with no-cost extensions): full weight
 * for 36 months (the pilot's median lead of a grant over the papers it predicts
 * was 37 months), then 0.6 to 60 months, then 0.3. Newest is weightiest; no
 * under-3-month dip, unlike the publication curves.
 */
export function signalRecencyWeight(ageMonths: number): number {
  if (ageMonths < 36) return 1.0;
  if (ageMonths < 60) return 0.6;
  return 0.3;
}

export type AreaSignalItem = {
  kind: "grant" | "trial";
  /** The item's area score for this topic (0-1). */
  score: number;
  /** Start date (a grant project's earliest scored row). Null = oldest band. */
  start: Date | null;
};

/**
 * One scholar's signal points in one area: per kind, score x W x recency for
 * each item, the top `cap` summed. Papers are added by the caller, uncapped.
 */
export function scoreAreaSignals(
  items: readonly AreaSignalItem[],
  now: Date = new Date(),
  opts: { w?: number; cap?: number } = {},
): number {
  const w = opts.w ?? AREA_SIGNAL_WEIGHT;
  const cap = opts.cap ?? AREA_SIGNAL_CAP;
  let total = 0;
  for (const kind of ["grant", "trial"] as const) {
    const contributions = items
      .filter((i) => i.kind === kind && i.score > 0)
      .map((i) => i.score * w * signalRecencyWeight(monthsBetween(i.start, now)))
      .sort((a, b) => b - a)
      .slice(0, cap);
    for (const c of contributions) total += c;
  }
  return total;
}

/** NIH IC + serial (e.g. "CA246080" out of "1 R01 CA 246080-01A1"). */
const NIH_CORE = /[A-Z]{2}\s*0*(\d{6})/;

export type GrantProjectRow = {
  id: string;
  cwid: string;
  title: string;
  awardNumber: string | null;
  mechanism: string | null;
};

/** The keys that make two of one scholar's grant rows the same project. */
function projectKeys(g: GrantProjectRow): string[] {
  // Python's Unicode \W, which the pilot used: anything not a letter, digit or underscore.
  const keys = ["t:" + g.title.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").trim()];
  if (g.mechanism) {
    const m = NIH_CORE.exec((g.awardNumber ?? "").toUpperCase().replace(/-/g, " "));
    if (m) keys.push("n:" + m[0].replace(/ /g, ""));
  }
  return keys;
}

/**
 * Collapse grant rows into funding projects, per scholar: yearly foundation
 * renewals, NIH supplements, K99 -> R00 and re-issued award numbers are separate
 * rows that are one piece of work. Rows sharing a normalized title or an NIH
 * IC + serial are merged (union-find, so A~B by title and B~C by serial puts
 * A, B, C together). Never merges across scholars. Groups come back in the
 * order their first row appears.
 */
export function collapseGrantProjects<T extends GrantProjectRow>(rows: readonly T[]): T[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    if (!parent.has(r)) parent.set(r, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const scoped = (g: T) => projectKeys(g).map((k) => JSON.stringify([g.cwid, k]));
  for (const g of rows) {
    const ks = scoped(g);
    for (const k of ks.slice(1)) union(ks[0], k);
    find(ks[0]);
  }
  const groups = new Map<string, T[]>();
  for (const g of rows) {
    const root = find(scoped(g)[0]);
    groups.set(root, [...(groups.get(root) ?? []), g]);
  }
  return [...groups.values()];
}
