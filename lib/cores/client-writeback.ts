/**
 * Mirror a core's active "known clients" CWID list to the ReciterAI engine's
 * DynamoDB so the next cores run can fold it in as a curated-client signal
 * (ReciterAI #383 / SPS #2607, CWID-only pass). The authoritative store is
 * always SPS's `core_client` (read-merged at display time via
 * `lib/api/core-clients.ts`); this writeback only FEEDS the engine.
 *
 * Reuses `CORE_CLAIM_WRITEBACK` — {@link isCoreClaimWritebackEnabled} from
 * `lib/cores/claim-writeback.ts` — rather than minting a second flag: both
 * writebacks are the same "SPS may write to the shared `reciterai` table yet"
 * gate, and the IAM grant it depends on is table-wide, not per-item-kind.
 *
 * DORMANT-SAFE, same posture as `claim-writeback.ts`: best-effort, never
 * throws to the caller (the route treats the result as advisory), 5s timeout,
 * injectable DynamoDB client for tests.
 *
 * IMPORTANT — the item key. Unlike `claim-writeback.ts`'s per-(pmid,core)
 * items (`PK: PUB#{pmid}`, `SK: CORE#{coreId}`), this is ONE item per core at
 * `PK: CORE#{coreId}`, `SK: "CLIENTS"`. The `SK` deliberately does NOT begin
 * with `"CORE#"`: both the SPS ETL (`etl/dynamodb/partition.ts` Block 6) and
 * the engine select core rows with `begins_with(SK, "CORE#")`, so a `SK` that
 * matched that prefix would make this item visible to (and presumably
 * mis-parsed by) code that expects a core-metadata row, not a client list.
 * Keeping `SK` as the bare literal `"CLIENTS"` keeps this item invisible to
 * both scanners.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { isCoreClaimWritebackEnabled, type CoreClaimDdbClient } from "@/lib/cores/claim-writeback";

/** The shared ReciterAI table the cores ETL reads (same default as the ETL). */
const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
/** ReciterAI's DynamoDB lives in us-east-1 regardless of the SPS region. */
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
/** Short, best-effort timeout — a client add/remove must not block on the writeback. */
const WRITEBACK_TIMEOUT_MS = 5_000;

export type CoreClientWritebackResult =
  | { ok: true; skipped: false }
  | { ok: false; skipped: true; reason: "disabled" }
  | { ok: false; skipped: false };

export interface CoreClientWriteback {
  coreId: string;
  /** The full ACTIVE list for this core (any casing in, sorted+lowercased out). */
  cwids: string[];
}

let ddbSingleton: CoreClaimDdbClient | undefined;
function defaultDdb(): CoreClaimDdbClient {
  if (!ddbSingleton) {
    ddbSingleton = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
    ) as unknown as CoreClaimDdbClient;
  }
  return ddbSingleton;
}

/**
 * `UpdateItem` (upsert) the `(CORE#{coreId}, CLIENTS)` item's full client list.
 * Always writes the WHOLE active list (not a per-cwid delta) — the caller
 * (the route, after each add/remove commits) re-reads the active set and
 * mirrors it wholesale, so a dropped write is corrected by the very next
 * add/remove rather than compounding a delta gap. Never throws — returns a
 * result the caller logs as advisory.
 */
export async function writeBackCoreClients(
  input: CoreClientWriteback,
  opts: { ddb?: CoreClaimDdbClient } = {},
): Promise<CoreClientWritebackResult> {
  if (!isCoreClaimWritebackEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  const ddb = opts.ddb ?? defaultDdb();
  const sortedCwids = [...new Set(input.cwids.map((c) => c.toLowerCase()))].sort();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CORE#${input.coreId}`, SK: "CLIENTS" },
        UpdateExpression:
          "SET core_id = :core, client_cwids = :cwids, client_count = :n, client_source = :src, client_updated_at = :ts",
        ExpressionAttributeValues: {
          ":core": input.coreId,
          ":cwids": sortedCwids,
          ":n": sortedCwids.length,
          ":src": "sps",
          ":ts": new Date().toISOString(),
        },
      }),
      { abortSignal: AbortSignal.timeout(WRITEBACK_TIMEOUT_MS) },
    );
    return { ok: true, skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}
