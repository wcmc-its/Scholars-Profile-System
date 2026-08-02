/**
 * #2166 — keyed prune plan for the `topic` catalog (Block 1, TAXONOMY# -> topic).
 *
 * The upsert loop only adds/updates rows; a topic ReciterAI retired from
 * TAXONOMY#, or flagged in the hierarchy artifact's `excluded_topics` (see
 * ./excluded-topics.ts), was never removed -- so a retired/excluded topic
 * (and its 0 publications) stayed listed on the home page's
 * Browse-all-research-areas grid forever. Deleting a `topic` row cascades
 * onto its `PublicationTopic`/`Subtopic` rows (Prisma onDelete: Cascade) and
 * SETs NULL any `Publication.topTopicId` pointing at it, so no orphan FK is
 * left behind.
 *
 * Gated by the SAME guardedReplace floor the sibling `publication_topic`
 * prune uses (./publication-topic-prune.ts) so a partial/truncated TAXONOMY#
 * scan can never mass-delete a populated catalog.
 */
import { replaceFloor } from "./projection-replace";

export type TopicPrunePlan =
  | { prune: false; reason: string; stale: readonly string[] }
  | { prune: true; stale: string[] };

/**
 * `writtenIds` is the set of topic ids this run actually upserted (current
 * TAXONOMY# topics minus anything in the hierarchy exclusion list). Mirrors
 * `planPublicationTopicPrune`'s writeKeys/existingKeys shape.
 */
export function planTopicPrune(
  writtenIds: readonly string[],
  existingIds: readonly string[],
  liveCount: number,
): TopicPrunePlan {
  const floor = replaceFloor(liveCount);
  if (writtenIds.length < floor) {
    return {
      prune: false,
      reason: `incoming ${writtenIds.length} write-ids below floor ${floor} (live ${liveCount})`,
      stale: [],
    };
  }
  const keep = new Set(writtenIds);
  const stale = existingIds.filter((id) => !keep.has(id));
  return { prune: true, stale };
}
