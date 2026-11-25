/**
 * Pure helpers for the PubMed systematic review ETL: batching, the ESearch
 * term, the table diff and the write guards. Kept separate from index.ts and
 * fetcher.ts so they are unit-testable without a DB or network.
 */
import { assertSourceVolume } from "../../lib/etl-guard";

/** PMIDs per ESearch call. 100 `[uid]` clauses resolve fully in one POST. */
export const BATCH_SIZE = 100;

/** PubMed's own systematic review filter (the "Systematic Review" article-type subset). */
export const SYSTEMATIC_FILTER = "systematic[sb]";

/** Below this many existing rows the shrink guard does not apply. */
export const SHRINK_GUARD_MIN_EXISTING = 100;

export const SHRINK_GUARD = "pubmed-systematic-reviews:flagged";

/**
 * Keep the all-digit PMIDs, de-duplicated, and split them into ESearch batches.
 * Anything else in `publication.pmid` is not a PubMed uid and cannot be asked about.
 */
export function batchPmids(pmids: Iterable<string>, size: number = BATCH_SIZE): string[][] {
  const unique = [...new Set(pmids)].filter((p) => /^\d+$/.test(p));
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

/** `(1[uid] OR 2[uid]) AND systematic[sb]`: which of these PMIDs the filter matches. */
export function buildTerm(pmids: readonly string[]): string {
  return `(${pmids.map((p) => `${p}[uid]`).join(" OR ")}) AND ${SYSTEMATIC_FILTER}`;
}

export interface FlagDiff {
  /** Flagged now, not in the table: insert. */
  toAdd: string[];
  /** In the table, no longer flagged: delete. */
  toRemove: string[];
  /** In both: left alone, so `flagged_at` keeps the first-flagged time. */
  unchanged: number;
}

export function diffFlagged(existing: Iterable<string>, flagged: ReadonlySet<string>): FlagDiff {
  const held = new Set(existing);
  const toRemove = [...held].filter((p) => !flagged.has(p));
  const toAdd = [...flagged].filter((p) => !held.has(p));
  return { toAdd, toRemove, unchanged: held.size - toRemove.length };
}

/**
 * Refuse to write from an implausible answer. Throws when nothing is flagged
 * (a fetch fault, not a corpus with no systematic reviews), and when a table of
 * at least SHRINK_GUARD_MIN_EXISTING rows would shrink to less than half.
 * The shrink check can be bypassed with ETL_GUARD_BYPASS (lib/etl-guard.ts).
 */
export function assertFlaggedVolume(flagged: number, existing: number): void {
  if (flagged === 0) {
    throw new Error("PubMed flagged 0 corpus PMIDs as systematic reviews: aborting (likely a fetch fault).");
  }
  if (existing >= SHRINK_GUARD_MIN_EXISTING) {
    assertSourceVolume(SHRINK_GUARD, { incoming: flagged, existing, maxDropPct: 50 });
  }
}
