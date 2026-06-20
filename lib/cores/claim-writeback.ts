/**
 * Mirror a core-usage claim/rejection to the ReciterAI engine's DynamoDB so the
 * NEXT cores run reads it back as a repeat-user prior
 * (`pipeline_cores.persist.scan_prior_core_usage` scans `CORE#` rows with
 * `status ∈ {confirmed, claimed}`). The authoritative store is always SPS's
 * `core_claim` (read-merged at display time); this writeback only FEEDS the engine.
 *
 * DORMANT-SAFE (mirrors `lib/reciter/client.ts`). Gated behind `CORE_CLAIM_WRITEBACK`
 * (default off). SPS only READS DynamoDB today — this is its first write, and it
 * needs a DynamoDB write IAM grant on the `reciterai` table. Until that grant is
 * provisioned AND the flag flips, the claim still lands in MySQL and this is
 * skipped. Best-effort + never throws to the caller (the route treats the result
 * as advisory); the engine's nightly re-derivation is the backstop.
 *
 * Lifecycle note (engine-side follow-up, out of scope here): the engine writes
 * `CORE#` items with `batch_write` (PutItem = full replace). It reads prior claims
 * via `scan_prior_core_usage` BEFORE it re-writes, so a claim seeds the very next
 * run's affinity prior and is then superseded by that run's fresh status. The
 * durable human decision lives in `core_claim`, not DynamoDB, so this round-trip
 * being lossy across runs is fine.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/** The shared ReciterAI table the cores ETL reads (same default as the ETL). */
const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
/** ReciterAI's DynamoDB lives in us-east-1 regardless of the SPS region. */
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
/** Short, best-effort timeout — a claim must not block on the writeback. */
const WRITEBACK_TIMEOUT_MS = 5_000;

/** Master switch (default off). Gates the single DynamoDB write SPS makes. */
export function isCoreClaimWritebackEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CORE_CLAIM_WRITEBACK === "on";
}

export type CoreClaimWritebackResult =
  | { ok: true; skipped: false }
  | { ok: false; skipped: true; reason: "disabled" }
  | { ok: false; skipped: false };

export interface CoreClaimWriteback {
  pmid: string;
  coreId: string;
  /** The human decision — mirrored verbatim to DynamoDB `status`. */
  status: "claimed" | "rejected";
}

/** The minimal `.send()` surface this module uses; injectable for tests. */
export interface CoreClaimDdbClient {
  send(command: UpdateCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
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
 * `UpdateItem` (upsert) the `(PUB#{pmid}, CORE#{coreId})` item's `status` to the
 * human decision. UpdateItem preserves the engine-written `likelihood`/signals
 * when the item already exists and creates a minimal item (key + the `pmid` /
 * `core_id` attributes `scan_prior_core_usage` projects) when it doesn't. Never
 * throws — returns a result the caller logs as advisory.
 */
export async function writeBackCoreClaim(
  input: CoreClaimWriteback,
  opts: { ddb?: CoreClaimDdbClient } = {},
): Promise<CoreClaimWritebackResult> {
  if (!isCoreClaimWritebackEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  const ddb = opts.ddb ?? defaultDdb();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `PUB#${input.pmid}`, SK: `CORE#${input.coreId}` },
        UpdateExpression:
          "SET pmid = :pmid, core_id = :core, #st = :st, claim_source = :src, claim_updated_at = :ts",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":pmid": input.pmid,
          ":core": input.coreId,
          ":st": input.status,
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
