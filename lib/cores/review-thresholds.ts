/**
 * The likelihood cuts the core review surfaces share: the `/edit/core` index,
 * the core editor's banner (`/edit/core/[coreId]`) and the review queue
 * (`/edit/core/[coreId]/review`). One module so the three can never disagree.
 *
 * PURE and import-free on purpose: `components/edit/core-claim-queue.tsx` and
 * `components/edit/core-facilities-index.tsx` are `"use client"` components
 * that read these at RUNTIME, and `lib/api/core-console-index.ts` constructs
 * prisma at module scope (same trap as `lib/cores/paper-counts.ts`).
 */

/** Likelihood at or above which an open candidate counts as high confidence. */
export const HIGH_CONFIDENCE_LIKELIHOOD = 0.8;

/**
 * Open ENGINE candidates below this likelihood are hidden by default: left out
 * of the queue's list, rail, facets and bulk actions (a "N lower-confidence
 * candidates hidden · Show" line reveals them) and out of the index/editor
 * "To review" counts. Nothing is deleted or written — display only.
 *
 * The engine's own triage bar is 0.30, and on core 14 ~98% of open candidates
 * sit at 0.30-0.40 while human claims start at 0.40.
 *
 * ponytail: single global floor. Add a per-core override when cores 1-13 are
 * rescored onto the nightly scale — their June batch_screen likelihoods are on
 * a different, higher scale, so the floor hides none of them today (none are
 * below 0.40), but one number will not fit both scales once they mix.
 */
export const CANDIDATE_DISPLAY_FLOOR = 0.4;

/** The floor as a whole percent, for copy ("likelihood below 40%"). */
export const CANDIDATE_DISPLAY_FLOOR_PCT = Math.round(CANDIDATE_DISPLAY_FLOOR * 100);

/**
 * True for an open engine candidate the floor hides by default. Exempt: a pmid
 * sent to review by hand (`queued`, unscored), a manual add (`isManual`), and
 * anything a claim backs (`claimed`) — a person put those there, and their
 * likelihood is a placeholder 0, not an engine verdict. Only `status:
 * "candidate"` rows are engine candidates at all. Pure.
 */
export function isBelowDisplayFloor(row: {
  likelihood: number;
  status: string;
  queued?: boolean;
  isManual?: boolean;
  claimed?: boolean;
}): boolean {
  if (row.status !== "candidate" || row.queued || row.isManual || row.claimed) return false;
  return row.likelihood < CANDIDATE_DISPLAY_FLOOR;
}
