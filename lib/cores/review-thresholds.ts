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
 * of the queue's list, rail, facets and bulk actions (a "N hidden: … · Show"
 * line reveals them) and out of the index/editor "To review" counts. Nothing is
 * deleted or written — display only.
 *
 * The engine's own triage bar is 0.30, and on core 14 ~98% of open candidates
 * sit at 0.30-0.40 while human claims start at 0.40.
 *
 * A prod probe of core 14 (2026-10) found every one of the 2,276 rows below the
 * floor at 0.35-0.40 carrying ONLY the repeat-user signal, plus at most a
 * method-family tier: 1,845 repeat-user only, 295 method weak, 78 method
 * moderate, 58 method strong. None had an acknowledgement, a staff co-author or
 * an LLM score. So a strong or moderate method tier — in-text evidence about
 * the paper itself — exempts a row from the floor (`FLOOR_EXEMPT_METHOD_TIERS`);
 * weak or no tier stays hidden (weak inverts to below background, see the
 * "method" facet in core-claim-queue.tsx).
 *
 * This is the DEFAULT floor; `CORE_DISPLAY_FLOOR_OVERRIDES` sets a core's own
 * (cores 1-13's June batch_screen likelihoods sit on a different, higher scale,
 * so the default hides none of them today). Always read a core's floor through
 * `displayFloorFor(coreId)`, never this constant directly.
 */
export const CANDIDATE_DISPLAY_FLOOR = 0.4;

/** The default floor as a whole percent, for copy ("likelihood below 40%"). */
export const CANDIDATE_DISPLAY_FLOOR_PCT = Math.round(CANDIDATE_DISPLAY_FLOOR * 100);

/**
 * Per-core display floors, keyed by core id (`Core.id`, a string). Display only:
 * the engine's triage bar is untouched, so nothing is dropped, and hidden rows
 * stay reachable via the queue's "Show".
 *
 * Core 14 (Research Informatics) = 0.50. Its engine triage stays 0.30. A
 * 2026-10-07 read-only analysis of the new engine (ReciterAI eae71dd) found open
 * candidates clustered at discrete values: 0.380 (39; LLM 6 + a repeat-user
 * trace), 0.401 (44; repeat-user only, mostly LLM-triaged away on the real run),
 * 0.423 (7; LLM 8 alone, and reviewers rejected 8/8), 0.445 (83; LLM 3 + repeat
 * user), then 0.547 and up. All 5 in-corpus claimed rows score 0.96-1.00. At
 * 0.50 the queue shows ~272 rows instead of ~400. Re-measure when core 14 has
 * >= 100 decided rows.
 */
export const CORE_DISPLAY_FLOOR_OVERRIDES: Readonly<Record<string, number>> = { "14": 0.5 };

/** The display floor for one core: its override, else the default. */
export function displayFloorFor(coreId: string): number {
  return Object.hasOwn(CORE_DISPLAY_FLOOR_OVERRIDES, coreId)
    ? CORE_DISPLAY_FLOOR_OVERRIDES[coreId]
    : CANDIDATE_DISPLAY_FLOOR;
}

/** `displayFloorFor` as a whole percent, for copy ("likelihood below 50%"). */
export function displayFloorPctFor(coreId: string): number {
  return Math.round(displayFloorFor(coreId) * 100);
}

/** Method-family tiers that exempt a row from the display floor. */
export const FLOOR_EXEMPT_METHOD_TIERS: readonly string[] = ["strong", "moderate"];

/**
 * True for an open engine candidate the floor hides by default. Exempt: a pmid
 * sent to review by hand (`queued`, unscored), a manual add (`isManual`), and
 * anything a claim backs (`claimed`) — a person put those there, and their
 * likelihood is a placeholder 0, not an engine verdict. Also exempt: a strong or
 * moderate `methodTier` (`FLOOR_EXEMPT_METHOD_TIERS`). Only `status:
 * "candidate"` rows are engine candidates at all. The cut is the row's core's
 * floor (`displayFloorFor`). Pure.
 */
export function isBelowDisplayFloor(
  row: {
    likelihood: number;
    status: string;
    methodTier: string | null;
    queued?: boolean;
    isManual?: boolean;
    claimed?: boolean;
  },
  coreId: string,
): boolean {
  if (row.status !== "candidate" || row.queued || row.isManual || row.claimed) return false;
  if (row.methodTier !== null && FLOOR_EXEMPT_METHOD_TIERS.includes(row.methodTier)) return false;
  return row.likelihood < displayFloorFor(coreId);
}

/**
 * True when a row's only evidence is the repeat-user signal and/or a weak method
 * tier (and it has at least one of them) — what the floor hides on core 14. The
 * hidden-rows line says so only when this holds for every row it counts;
 * otherwise it falls back to the likelihood wording rather than describe
 * evidence a row doesn't have. Pure.
 */
export function hasOnlyRepeatUserOrWeakMethod(row: {
  signalAck: boolean;
  ackAlias: string | null;
  coauthors: readonly string[];
  llmScore: number | null;
  authorAffinity: number | null;
  methodTier: string | null;
}): boolean {
  return (
    !row.signalAck &&
    row.ackAlias === null &&
    row.coauthors.length === 0 &&
    row.llmScore === null &&
    (row.methodTier === "weak" || (row.methodTier === null && row.authorAffinity !== null))
  );
}
