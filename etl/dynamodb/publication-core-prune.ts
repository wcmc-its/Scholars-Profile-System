/**
 * #2601 — keyed prune plan for the `publication_core` projection.
 *
 * `etl/dynamodb` Block 6 upserts (pmid, coreId) pairs but never removes one the
 * cores engine dropped this run. The mapper deliberately DROPS `below_threshold`
 * rows (tallied as `skippedBelowThreshold`), so a re-score that demotes a pair
 * simply omits it from the write set — the stale row survives forever in the
 * owner's claim queue at /edit/core/[coreId]. 148 such rows sat on core 14 and
 * were being deleted by hand after every re-score. This computes the rows to
 * delete -- existing keys absent from this run's write set -- gated by the SAME
 * guardedReplace floor the sibling projections use, so a partial/truncated scan
 * can never mass-delete a populated table.
 *
 * Deleting an engine row does NOT destroy a human decision: claims/rejections
 * live in the ETL-immune `core_claim` table (ADR-005 manual-override, no FK to
 * publication_core), and all three read surfaces — lib/api/core-queue.ts,
 * lib/api/cores.ts, lib/api/publication-detail.ts — already fold a CLAIMED pair
 * with no engine row back in via their manual-PMID-add path.
 *
 * Pure (no Prisma / I/O) so the gate + stale computation are unit-testable
 * without a DynamoDB scan -- the same split as ./publication-topic-prune.ts and
 * ./projection-replace.ts.
 */
// ponytail: the floor is the SHARED whole-table one (MIN_FLOOR 50 / 50% max
// shrink), not per-core, exactly as the publication_topic sibling does it. Two
// ceilings follow: a publication_core table under 50 rows can never be pruned
// (the floor exceeds any plausible write set), and a core the engine stops
// emitting entirely is pruned away as long as the OTHER cores keep the global
// write set above the floor. Both are fine at today's 14-core volume. The
// upgrade path, if a core ever legitimately goes quiet for a run, is to plan
// per-coreId with its own floor rather than to loosen the shared constants.
import { replaceFloor } from "./projection-replace";

export type PubCoreKey = {
  pmid: string;
  coreId: string;
};

// Encode the composite key unambiguously: JSON.stringify of the fixed 2-tuple
// can't collide across different (pmid, coreId) pairs regardless of what
// characters an id carries (a plain-string delimiter could).
const keyOf = (k: PubCoreKey): string => JSON.stringify([k.pmid, k.coreId]);

export type PubCorePrunePlan =
  | { prune: false; reason: string; stale: readonly PubCoreKey[] }
  | { prune: true; stale: PubCoreKey[] };

/**
 * Decide the publication_core prune. When this run's write set is below the
 * guardedReplace floor for the live table it is treated as a likely partial
 * scan: `prune=false`, no key returned (stale rows retained this run). Otherwise
 * `prune=true` with the existing keys that were NOT written this run.
 */
export function planPublicationCorePrune(
  writeKeys: readonly PubCoreKey[],
  existingKeys: readonly PubCoreKey[],
  liveCount: number,
): PubCorePrunePlan {
  const floor = replaceFloor(liveCount);
  if (writeKeys.length < floor) {
    return {
      prune: false,
      reason: `incoming ${writeKeys.length} write-keys below floor ${floor} (live ${liveCount})`,
      stale: [],
    };
  }
  const keep = new Set(writeKeys.map(keyOf));
  const stale = existingKeys.filter((k) => !keep.has(keyOf(k)));
  return { prune: true, stale };
}
