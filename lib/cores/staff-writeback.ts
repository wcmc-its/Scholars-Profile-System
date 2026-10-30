/**
 * Mirror a core's SPS-curated staff list to the ReciterAI engine's DynamoDB so
 * the next nightly cores run treats them as likely co-authors when matching
 * publications to the core (ReciterAI `pipeline_cores/persist.py`
 * `get_curated_staff`). The authoritative store is SPS's `core_staff`
 * (`lib/api/core-staff.ts`); this writeback only FEEDS the engine.
 *
 * The twin of `lib/cores/client-writeback.ts`, same contract and same gate:
 * `CORE_CLAIM_WRITEBACK` ({@link isCoreClaimWritebackEnabled}), because both are
 * the one "SPS may write to the shared `reciterai` table yet" switch and the IAM
 * grant behind it is table-wide.
 *
 * DORMANT-SAFE: best-effort, never throws to the caller, 5s timeout,
 * injectable DynamoDB client for tests.
 *
 * The item key is ONE item per core at `PK: CORE#{coreId}`, `SK: "STAFF"`, with
 * the list in `staff_cwids`. Like `CLIENTS`, the `SK` deliberately does NOT
 * begin with `"CORE#"` (the SPS ETL and the engine select core rows with
 * `begins_with(SK, "CORE#")`), and it is not `STAFF_DICT`, the engine-written
 * dictionary count the SPS ETL reads (`etl/dynamodb/partition.ts` leaves the
 * bare `STAFF` item unmatched on purpose, so this is never read back in).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { isCoreClaimWritebackEnabled, type CoreClaimDdbClient } from "@/lib/cores/claim-writeback";

/** The shared ReciterAI table the cores ETL reads (same default as the ETL). */
const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
/** ReciterAI's DynamoDB lives in us-east-1 regardless of the SPS region. */
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
/** Short, best-effort timeout: a staff add/remove must not block on the writeback. */
const WRITEBACK_TIMEOUT_MS = 5_000;

export type CoreStaffWritebackResult =
  | { ok: true; skipped: false }
  | { ok: false; skipped: true; reason: "disabled" | "not_prod" }
  | { ok: false; skipped: false };

export interface CoreStaffWriteback {
  coreId: string;
  /** The core's FULL staff list (any casing in, sorted+lowercased out). */
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
 * `UpdateItem` (upsert) the `(CORE#{coreId}, STAFF)` item's full staff list.
 * Always writes the WHOLE list, never a delta, so a dropped write is corrected
 * by the next add/remove. Never throws.
 */
export async function writeBackCoreStaff(
  input: CoreStaffWriteback,
  opts: { ddb?: CoreClaimDdbClient; env?: Record<string, string | undefined> } = {},
): Promise<CoreStaffWritebackResult> {
  if (!isCoreClaimWritebackEnabled()) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  // Staging and prod share ONE `reciterai` table and this item is a full-list
  // replace, so a staging edit would overwrite prod's staff list in the engine.
  // Only prod feeds it; staging edits stay in staging's `core_staff`.
  if ((opts.env ?? process.env).SPS_ENV !== "prod") {
    return { ok: false, skipped: true, reason: "not_prod" };
  }
  const ddb = opts.ddb ?? defaultDdb();
  const sortedCwids = [...new Set(input.cwids.map((c) => c.toLowerCase()))].sort();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CORE#${input.coreId}`, SK: "STAFF" },
        UpdateExpression:
          "SET core_id = :core, staff_cwids = :cwids, staff_count = :n, staff_source = :src, staff_updated_at = :ts",
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
