/**
 * Per-person confirmed-paper counts for one core, and the arithmetic that reads
 * them back. The PURE half of `lib/api/core-clients.ts`, split out for exactly
 * the reason `lib/cores/cwid-block.ts` was: `components/edit/core-claim-queue.tsx`
 * is a `"use client"` component and needs `excludingOwnPaper` at RUNTIME, while
 * `lib/api/core-clients.ts` imports `@/lib/db` at module scope (a value import
 * cannot be tree-shaken away from its module's other top-level imports the way
 * a type-only import can) — the same `lib/edit/manageable-units.ts` /
 * `home-panel.tsx` trap this repo already hit once.
 *
 * No imports from `@/lib/db` or anything that constructs prisma.
 */

/** What this core already holds from one person, and how much of their work that
 *  is — "18 of their 29 publications are confirmed work with this core, 11 in the
 *  last three years". Plain numbers only: this crosses to a client component. */
export interface CoreClientPaperCount {
  /** Papers this core has CONFIRMED with them. Never 0 as the loader builds it —
   *  a person this core holds nothing from is dropped from the map entirely (see
   *  `loadCoreClientPaperCounts`). `excludingOwnPaper` CAN return 0, and there it
   *  means "no PREVIOUS occasion", which is a claim not to print at all. */
  papers: number;
  /** How many of those `papers` fall inside the `RECENT_PAPER_YEARS` window. */
  recent: number;
  /** Their confirmed authorships across ALL publications, this core's and
   *  everyone else's — the denominator in "18 of their 29". */
  total: number;
}

/** How many years back "N recent" counts. Three calendar years INCLUSIVE of the
 *  current one, so 2026 spans 2024-2026. */
export const RECENT_PAPER_YEARS = 3;

/** First publication year inside that window. One definition, so the loader that
 *  fills `recent` and the arithmetic that takes a paper back out of it cannot
 *  drift apart by a year. Pure. */
export function recentFloorYear(now: Date = new Date()): number {
  return now.getFullYear() - (RECENT_PAPER_YEARS - 1);
}

/**
 * The same counts with ONE paper of the person's own taken back out.
 *
 * `papers`/`recent` are counted over this core's CONFIRMED list, and the
 * Confirmed tab renders those very rows — so on a confirmed row the paper on
 * screen sits inside its own "previous occasions" number, and a person with
 * exactly one confirmed paper reads "1 previous occasion" ON that paper where
 * the truth is zero. Call this for a byline author of a row whose own paper is
 * inside the counted set (a row in `confirmed`), never for a candidate or a
 * rejected row, whose pmids the counts never saw.
 *
 * `total` loses the paper too, so every number in the sentence is about the
 * person's OTHER work and "17 previous occasions (out of 28 publications)" is
 * one consistent fact rather than a numerator and a denominator counting
 * different populations. (`total` has no DISTINCT behind it — see the loader —
 * so a byline listing someone twice leaves one copy of this paper in it. It is
 * printed as a denominator, never as a claim about a specific paper.)
 *
 * Pure. `now` is injected so the recency window is testable.
 */
export function excludingOwnPaper(
  counts: CoreClientPaperCount,
  year: number | null,
  now: Date = new Date(),
): CoreClientPaperCount {
  const wasRecent = year !== null && year >= recentFloorYear(now);
  return {
    papers: Math.max(0, counts.papers - 1),
    recent: Math.max(0, counts.recent - (wasRecent ? 1 : 0)),
    total: Math.max(0, counts.total - 1),
  };
}
