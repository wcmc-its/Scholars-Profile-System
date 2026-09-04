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
// The floor is the SHARED whole-table one (MIN_FLOOR 50 / 50% max shrink),
// exactly as the publication_topic sibling does it -- but a whole-table floor
// cannot see a PER-CORE outage, and that is the failure mode with teeth here.
// The write set is dominated by the big cores (core 5 alone holds ~4,400 rows
// of ~16,600): if the engine emits nothing at all for ONE core, the global set
// still clears the floor and every row of that core is deleted in a single run,
// silently emptying a queue nobody is watching. So a coreId with ZERO writes
// this run is HELD BACK rather than pruned, and the caller logs it loudly --
// the same shape planTopicPrune uses to hold back a topic that still has live
// TOPIC# entries. A core going quiet is a producer question, not something to
// paper over by deleting real data.
//
// ponytail: "zero writes" is the whole per-core rule; there is no per-core
// floor. A core that emits 1 row instead of its usual 4,400 still prunes the
// other 4,399. If that ever happens, the upgrade is replaceFloor per coreId --
// not loosening the shared constants.
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
  | { prune: false; reason: string; stale: readonly PubCoreKey[]; held: readonly PubCoreKey[] }
  | { prune: true; stale: PubCoreKey[]; held: PubCoreKey[] };

/**
 * Decide the publication_core prune. When this run's write set is below the
 * guardedReplace floor for the live table it is treated as a likely partial
 * scan: `prune=false`, no key returned (stale rows retained this run). Otherwise
 * `prune=true` with the existing keys that were NOT written this run — EXCEPT
 * those belonging to a core that got no writes at all, which come back in `held`
 * for the caller to log rather than delete (see the per-core note above).
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
      held: [],
    };
  }
  const keep = new Set(writeKeys.map(keyOf));
  const writtenCores = new Set(writeKeys.map((k) => k.coreId));
  const stale: PubCoreKey[] = [];
  const held: PubCoreKey[] = [];
  for (const k of existingKeys) {
    if (keep.has(keyOf(k))) continue;
    (writtenCores.has(k.coreId) ? stale : held).push(k);
  }
  return { prune: true, stale, held };
}
