/**
 * Worked-example fixtures for Variant B ranking math.
 *
 * Source: design-spec-v1.7.1.md:1150-1173 (three worked examples) +
 *         02-CONTEXT.md D-14 (compressed top_scholars curve).
 *
 * Each fixture pairs a RankablePublication input with the expected score
 * computed by hand from the spec formula. Unit tests assert the
 * implementation matches these to two decimal places (toBeCloseTo, 2).
 */
import type { RankablePublication } from "@/lib/ranking";

/** Reference "now" used for all worked-example computations. */
export const NOW = new Date("2026-04-01T00:00:00Z");

/**
 * Worked example 1 — Whitcomb 2003 Annals as a Selected highlight.
 * Senior author (isLast=true), Academic Article, ~23 years old.
 * 0.92 (impact) × 1.0 (last) × 1.0 (Article) × 0.5 (20+yr selected curve) = 0.46
 */
export const whitcombSelected: { input: RankablePublication; expected: number } = {
  input: {
    pmid: "whitcomb-2003-annals",
    publicationType: "Academic Article",
    reciteraiImpact: 0.92,
    dateAddedToEntrez: new Date("2003-04-01T00:00:00Z"),
    authorship: { isFirst: false, isLast: true, isPenultimate: false },
    isConfirmed: true,
  },
  expected: 0.46,
};

/**
 * Worked example 2 — same paper as a Recent highlight (publication-centric;
 * the Topic Recent highlights surface does NOT apply the first/senior filter
 * at pool selection per CONTEXT.md D-13).
 * 0.92 × 1.0 (publication-centric authorship) × 1.0 (Article) × 0.4 (3yr+ recent_highlights) = 0.368 ≈ 0.37
 */
export const whitcombRecentHighlight: { input: RankablePublication; expected: number } = {
  input: { ...whitcombSelected.input },
  expected: 0.37,
};

/**
 * Worked example 3 — 14-month-old NEJM paper, postdoc first author, as a
 * Recent contribution.
 * 0.88 × 1.0 (first) × 1.0 (Article) × 1.0 (6mo–18mo peak bucket) = 0.88
 */
export const nejmPostdocRecentContribution: { input: RankablePublication; expected: number } = {
  input: {
    pmid: "nejm-2025-postdoc",
    publicationType: "Academic Article",
    reciteraiImpact: 0.88,
    dateAddedToEntrez: new Date("2025-02-01T00:00:00Z"), // ~14 months before NOW
    authorship: { isFirst: true, isLast: false, isPenultimate: false },
    isConfirmed: true,
  },
  expected: 0.88,
};

export const WORKED_EXAMPLES = {
  whitcombSelected,
  whitcombRecentHighlight,
  nejmPostdocRecentContribution,
} as const;
