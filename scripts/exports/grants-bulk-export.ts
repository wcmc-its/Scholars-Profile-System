/**
 * grants-bulk-export.ts — nightly NDJSON export of EVERY scholar's grant
 * history to S3, for the Research Informatics cross-account consumer.
 *
 * Why this exists
 * ----------------
 * Research Informatics originally asked for a live "bulk grants" API. Measured
 * full-cohort JSON response size (~58-67 MB) is too heavy for a synchronous
 * web-tier route, so this replaces that idea with a nightly batch export
 * instead: read the whole `Grant` table once, write one JSON object per line,
 * and drop it in S3 for the consumer to pull on their own schedule.
 *
 * Shares its field selection + row mapping with the Faculty Review Tool's
 * per-cwid API (app/api/faculty-review/[cwid]/grants/route.ts) via
 * lib/grants/faculty-review-grant-record.ts, so this export can never drift
 * from that contract — see that module's header comment. The one addition
 * here is `cwid` on every NDJSON line (the per-cwid route already has `cwid`
 * in its own response envelope and doesn't need it per-row; this export has
 * no per-request path param, so each line carries its own).
 *
 * NDJSON contract: one JSON object per line —
 *   { cwid, externalId, source, title, role, roleLabel, isPrincipalInvestigator,
 *     awardNumber, funder, primeSponsor, directSponsor, isSubaward, programType,
 *     mechanism, nihIc, applId, startDate, endDate, isActive }
 * See docs/grants-bulk-export.md for the full field table.
 *
 * Destination: a SINGLE persistent key, overwritten every run — no dated keys,
 * no version history to manage. Every run is a full snapshot, not a delta.
 *
 * Usage (in-VPC, on sps-etl-<env> — DATABASE_URL + GRANTS_EXPORT_BUCKET are
 * baked into the task env by EtlStack):
 *   npm run export:grants-bulk
 *
 * Env
 * ---
 *   DATABASE_URL          (required) — the cluster to read.
 *   GRANTS_EXPORT_BUCKET   S3 bucket for the upload (injected by EtlStack).
 *   GRANTS_EXPORT_KEY      object key (default "grants.ndjson").
 *   AWS_REGION / AWS_DEFAULT_REGION   (default "us-east-1").
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db, disconnect } from "../../lib/db";
import {
  FACULTY_REVIEW_GRANT_SELECT,
  toGrantRecord,
  type GrantRecord,
  type GrantRowForFacultyReview,
} from "../../lib/grants/faculty-review-grant-record";

const DEFAULT_KEY = "grants.ndjson";

/** A `Grant` row shaped like {@link GrantRowForFacultyReview} plus the owning `cwid`. */
export type GrantRowForBulkExport = GrantRowForFacultyReview & { cwid: string };

/** One NDJSON line's contents: the shared `GrantRecord` plus `cwid` (there is no
 *  per-request path param here, so — unlike the single-cwid route's envelope —
 *  each line carries its own scholar identity). */
export type GrantExportRecord = GrantRecord & { cwid: string };

/** Map one bulk-export row to the NDJSON-line object (pure — no I/O). */
export function toGrantExportRecord(row: GrantRowForBulkExport, now: Date): GrantExportRecord {
  return { cwid: row.cwid, ...toGrantRecord(row, now) };
}

async function main(): Promise<void> {
  const start = Date.now();
  const now = new Date();

  // Cheap env checks before the expensive full-cohort read + serialize below.
  const bucket = process.env.GRANTS_EXPORT_BUCKET;
  if (!bucket) {
    throw new Error(
      "GRANTS_EXPORT_BUCKET is not set. (EtlStack injects it on the deployed sps-etl-<env> task.)",
    );
  }
  const key = process.env.GRANTS_EXPORT_KEY ?? DEFAULT_KEY;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

  console.log("Loading all Grant rows...");
  const rows = await db.read.grant.findMany({
    // Same lean select as the Faculty Review Tool's per-cwid API — no
    // abstract/keywords/meshDescriptorUis columns dragged along.
    select: { cwid: true, ...FACULTY_REVIEW_GRANT_SELECT },
    orderBy: { cwid: "asc" },
  });
  console.log(`Fetched ${rows.length} grant rows.`);

  // A 0-row result is never a legitimate export -- every scholar with a grant
  // disappearing institution-wide is far more likely a transient bad read
  // (replica lag, wrong schema, misconfigured env) than reality. Throw rather
  // than overwrite the one persistent key: this run has no versioning/dated
  // keys by design, so a bad overwrite destroys the last-known-good snapshot
  // and the consumer's next pull silently gets ~0 rows. Throwing here instead
  // fails the ECS task, which the state machine's Catch reports to SNS.
  if (rows.length === 0) {
    throw new Error(
      "Grant.findMany returned 0 rows -- refusing to overwrite the last-known-good " +
        "grants.ndjson with an empty file. Check DATABASE_URL / replica lag / schema " +
        "before re-running.",
    );
  }

  const ndjson = rows.map((r) => JSON.stringify(toGrantExportRecord(r, now))).join("\n") + "\n";
  const bytes = Buffer.byteLength(ndjson, "utf8");

  const s3 = new S3Client({ region });
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: ndjson,
      ContentType: "application/x-ndjson",
    }),
  );

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(
    `Uploaded ${rows.length} rows (${bytes} bytes) to s3://${bucket}/${key} in ${elapsed}s.`,
  );
}

// Guarded so the module can be imported by a unit test (for `toGrantExportRecord`)
// without running the export (mirrors etl/mesh-aliases and etl/family-suppression).
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .then(disconnect)
    .catch(async (err) => {
      console.error(`\ngrants-bulk-export FAILED: ${err instanceof Error ? err.message : err}`);
      await disconnect().catch(() => {});
      process.exitCode = 1;
    });
}
