/**
 * Pure helper extracted from `etl/dynamodb/index.ts` Block 2b (issue #325)
 * so the per-pmid `top_topic_id` collapse can be unit-tested without a
 * DynamoDB scan.
 *
 * ReciterAI #68 lands `top_topic_id` on every TOPIC# row — the value is
 * per-paper but denormalized across the N TOPIC# rows for one pmid. This
 * helper builds a `pmid → top_topic_id` map from those rows, enforces the
 * known-pmid + known-topic guards, and reports the per-pmid conflict
 * count (producer-side invariant says all rows for one pmid agree; we
 * count drift but still pick first-seen for determinism).
 */

export type TopTopicCandidate = {
  pmid?: string | number;
  top_topic_id?: string;
  // The full TopicRecord from index.ts has many more fields, but the
  // resolver only needs these two — leave the rest off the input type so
  // tests don't have to fabricate unrelated fixture data.
};

export type TopTopicResolution = {
  /** Pmid → resolved top_topic_id, with FK guard applied. */
  byPmid: Map<string, string>;
  /** Pmids whose top_topic_id referenced an unknown topic id (skipped). */
  skippedUnknownTopic: number;
  /** Per-pmid conflicts where two TOPIC# rows for the same pmid carried different values (first-seen wins). */
  perPmidConflicts: number;
};

export function resolveTopTopicByPmid(
  rows: ReadonlyArray<TopTopicCandidate>,
  knownPmidSet: ReadonlySet<string>,
  knownTopicIds: ReadonlySet<string>,
): TopTopicResolution {
  const firstSeen = new Map<string, string>();
  let perPmidConflicts = 0;

  for (const it of rows) {
    const tt = typeof it.top_topic_id === "string" && it.top_topic_id ? it.top_topic_id : "";
    if (!tt) continue;
    const pmidStr =
      typeof it.pmid === "number" && Number.isFinite(it.pmid)
        ? String(it.pmid)
        : typeof it.pmid === "string" && /^\d+$/.test(it.pmid.trim())
          ? it.pmid.trim()
          : "";
    if (!pmidStr || !knownPmidSet.has(pmidStr)) continue;
    const existing = firstSeen.get(pmidStr);
    if (existing === undefined) {
      firstSeen.set(pmidStr, tt);
    } else if (existing !== tt) {
      perPmidConflicts += 1;
    }
  }

  // FK guard: drop pmids whose resolved topic id isn't in the local catalog.
  const byPmid = new Map<string, string>();
  let skippedUnknownTopic = 0;
  for (const [pmid, tt] of firstSeen) {
    if (!knownTopicIds.has(tt)) {
      skippedUnknownTopic += 1;
      continue;
    }
    byPmid.set(pmid, tt);
  }

  return { byPmid, skippedUnknownTopic, perPmidConflicts };
}
