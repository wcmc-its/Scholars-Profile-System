import { db } from "@/lib/db";

/**
 * The reciter → dynamodb consistency window (#118 / B19).
 *
 * `etl/reciter` rewrites Publication rows; `etl/dynamodb` then rebuilds the
 * topic edges. Between them a profile's topic data is transiently incomplete,
 * so the profile Topics section shows a placeholder while the window is open.
 *
 * `etl_state.last_topic_rebuild_at` marks it: reciter sets it at run start,
 * dynamodb clears it on success. This cap auto-expires the window if dynamodb
 * never succeeds, so the placeholder cannot stick indefinitely.
 */
export const TOPIC_REBUILD_WINDOW_MS = 30 * 60 * 1000;

/** `EtlState` is a singleton row; this is its fixed primary key. */
const ETL_STATE_ID = 1;

/** etl/reciter — open the window at run start. */
export async function markTopicRebuildStarted(): Promise<void> {
  const now = new Date();
  await db.write.etlState.upsert({
    where: { id: ETL_STATE_ID },
    create: { id: ETL_STATE_ID, lastTopicRebuildAt: now },
    update: { lastTopicRebuildAt: now },
  });
}

/** etl/dynamodb — close the window on success. Safe no-op if the row is absent. */
export async function clearTopicRebuildWindow(): Promise<void> {
  await db.write.etlState.upsert({
    where: { id: ETL_STATE_ID },
    create: { id: ETL_STATE_ID, lastTopicRebuildAt: null },
    update: { lastTopicRebuildAt: null },
  });
}

/**
 * True when a topic rebuild started within `TOPIC_REBUILD_WINDOW_MS` and
 * dynamodb has not yet cleared it — i.e. profile topic data may be incomplete.
 */
export async function isTopicRebuildWindowOpen(now: Date = new Date()): Promise<boolean> {
  const row = await db.read.etlState.findUnique({ where: { id: ETL_STATE_ID } });
  if (!row?.lastTopicRebuildAt) return false;
  return now.getTime() - row.lastTopicRebuildAt.getTime() < TOPIC_REBUILD_WINDOW_MS;
}
