/**
 * #1511 — keyed prune plan for the `publication_topic` projection.
 *
 * `etl/dynamodb` Block 2 upserts (pmid, cwid, parentTopicId) triples but never
 * removes one that ReciterAI dropped this run (a paper that fell out of a
 * topic). Stale associations then persist indefinitely and keep a paper on a
 * subtopic page it no longer belongs to. This computes the rows to delete --
 * existing keys absent from this run's write set -- gated by the SAME
 * guardedReplace floor the sibling projections use, so a partial/truncated
 * TOPIC# scan can never mass-delete a populated table.
 *
 * Pure (no Prisma / I/O) so the gate + stale computation are unit-testable
 * without a DynamoDB scan -- the same split as ./publication-topic-guard.ts and
 * ./projection-replace.ts.
 */
import { replaceFloor } from "./projection-replace";

export type PubTopicKey = {
  pmid: string;
  cwid: string;
  parentTopicId: string;
};

// Encode the composite key unambiguously: JSON.stringify of the fixed 3-tuple
// can't collide across different (pmid, cwid, parentTopicId) triples regardless
// of what characters a slug carries (a plain-string delimiter could).
const keyOf = (k: PubTopicKey): string =>
  JSON.stringify([k.pmid, k.cwid, k.parentTopicId]);

export type PrunePlan =
  | { prune: false; reason: string; stale: readonly PubTopicKey[] }
  | { prune: true; stale: PubTopicKey[] };

/**
 * Decide the publication_topic prune. When this run's write set is below the
 * guardedReplace floor for the live table it is treated as a likely partial
 * scan: `prune=false`, no key returned (stale rows retained this run). Otherwise
 * `prune=true` with the existing keys that were NOT written this run.
 */
export function planPublicationTopicPrune(
  writeKeys: readonly PubTopicKey[],
  existingKeys: readonly PubTopicKey[],
  liveCount: number,
): PrunePlan {
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
