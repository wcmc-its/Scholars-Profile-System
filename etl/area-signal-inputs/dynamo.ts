/**
 * The `AREAINPUT` queue writes for `etl:area-signal-inputs`. Injectable client
 * so tests drive it with a recording fake, as lib/edit/opportunity-submission.ts.
 *
 * Idempotent: the queue is read once (keys only) and only keys it does not hold
 * are put, each under `attribute_not_exists(SK)`, so an item the drain already
 * marked `scored` or `failed` is never reset to `pending`. Both envs' ETLs share
 * the one `reciterai` table and build the same keys from the same sources, so
 * whichever runs first writes an item and the other finds it present.
 */
import type { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { AREA_INPUT_PK, type AreaInputItem } from "./plan";

export interface AreaInputDdbClient {
  send(
    command: PutCommand | QueryCommand,
  ): Promise<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>;
}

export type CommandCtors = {
  Put: typeof PutCommand;
  Query: typeof QueryCommand;
};

/** Every SK already queued under `AREAINPUT`, paginated, keys only. */
export async function listQueuedInputKeys(
  ddb: AreaInputDdbClient,
  table: string,
  cmd: CommandCtors,
): Promise<Set<string>> {
  const out = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(
      new cmd.Query({
        TableName: table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": AREA_INPUT_PK },
        ProjectionExpression: "SK",
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const it of resp.Items ?? []) if (typeof it.SK === "string") out.add(it.SK);
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

export type PutResult = { put: number; alreadyQueued: number };

/** Put each item the queue does not hold yet. Throws on any failure but a lost race. */
export async function putNewInputs(
  ddb: AreaInputDdbClient,
  table: string,
  cmd: CommandCtors,
  items: Iterable<AreaInputItem>,
  queued: ReadonlySet<string>,
): Promise<PutResult> {
  let put = 0;
  let alreadyQueued = 0;
  for (const item of items) {
    if (queued.has(item.SK)) {
      alreadyQueued += 1;
      continue;
    }
    try {
      await ddb.send(
        new cmd.Put({
          TableName: table,
          Item: item,
          ConditionExpression: "attribute_not_exists(SK)",
        }),
      );
      put += 1;
    } catch (err) {
      // The other env's nightly put it between our read and this write.
      if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
        alreadyQueued += 1;
        continue;
      }
      throw err;
    }
  }
  return { put, alreadyQueued };
}
