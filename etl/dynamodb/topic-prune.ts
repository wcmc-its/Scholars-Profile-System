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
 *
 * #2166 follow-up (found via the prod verification probe): TAXONOMY# (the
 * parent catalog) and the per-paper TOPIC# stream can drift out of sync --
 * `implementation_science` was absent from a TAXONOMY# scan (dropped from
 * the catalog) while DynamoDB still carried 4189 live TOPIC# entries scored
 * against it (a stale hierarchy_version, so ReciterAI's per-paper rescoring
 * hadn't caught up to the catalog change yet). A first cut of this prune
 * deleted it anyway, silently orphaning those papers' topic assignment.
 * `oral_craniofacial_health` is the opposite case: 93 live TOPIC# entries,
 * but on the hierarchy artifact's excluded_topics governance list -- that
 * IS supposed to prune regardless of live data (exclusion is a deliberate
 * "never show this" decision, not a sync-lag artifact).
 *
 * So the two prune reasons get different safety rules:
 *   - excluded (governance list): always prune, even with live TOPIC# data.
 *   - absent from TAXONOMY# (not excluded): prune ONLY if it also has zero
 *     TOPIC# entries this run. Otherwise it's held back and the caller logs
 *     it loudly -- a taxonomy/TOPIC# desync worth investigating upstream,
 *     not something to silently paper over by deleting real data.
 */
import { replaceFloor } from "./projection-replace";

export type TopicPrunePlan =
  | { prune: false; reason: string; stale: readonly string[]; held: readonly string[] }
  | { prune: true; stale: string[]; held: string[] };

/**
 * `writtenIds` is the set of topic ids this run actually upserted (current
 * TAXONOMY# topics minus anything in the hierarchy exclusion list). Mirrors
 * `planPublicationTopicPrune`'s writeKeys/existingKeys shape.
 *
 * `excludedIds` — ids on the hierarchy artifact's excluded_topics list this
 * run (always eligible for deletion). `liveActivityIds` — parent topic ids
 * this run's TOPIC# scan actually referenced (deletion is held back for a
 * non-excluded id in this set).
 */
export function planTopicPrune(
  writtenIds: readonly string[],
  existingIds: readonly string[],
  liveCount: number,
  opts: { excludedIds: ReadonlySet<string>; liveActivityIds: ReadonlySet<string> },
): TopicPrunePlan {
  const floor = replaceFloor(liveCount);
  if (writtenIds.length < floor) {
    return {
      prune: false,
      reason: `incoming ${writtenIds.length} write-ids below floor ${floor} (live ${liveCount})`,
      stale: [],
      held: [],
    };
  }
  const keep = new Set(writtenIds);
  const candidates = existingIds.filter((id) => !keep.has(id));
  const stale: string[] = [];
  const held: string[] = [];
  for (const id of candidates) {
    if (opts.excludedIds.has(id) || !opts.liveActivityIds.has(id)) {
      stale.push(id);
    } else {
      held.push(id);
    }
  }
  return { prune: true, stale, held };
}
