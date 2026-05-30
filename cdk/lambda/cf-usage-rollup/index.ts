import {
  AthenaClient,
  GetQueryExecutionCommand,
  StartQueryExecutionCommand,
  StopQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { assertIsoDate, buildRollupInsert } from "./queries.js";

// CloudFront usage rollup handler. Nightly EventBridge fire (empty event)
// defaults to a trailing 2-day UTC window so late-arriving CF logs (which can
// lag the access hours by several hours) are caught on the next run; an
// explicit `event.date` rolls a single day, and `event.backfillFrom` /
// `event.backfillTo` roll an inclusive range. Each date is made exactly-once
// by deleting the rollup/daily-usage/dt=<date>/ S3 prefix before the INSERT
// (delete-then-insert): Athena INSERT INTO only appends, and external (non-
// Iceberg) Glue tables on Trino support neither INSERT OVERWRITE of a single
// partition nor DELETE, so a re-run without the purge would double-count. That
// purge is why this handler needs @aws-sdk/client-s3 in addition to
// @aws-sdk/client-athena; both are externalized in the CDK bundling config
// because they ship in the NODEJS_22_X runtime.
//
// `new Date()` here runs at Lambda EXECUTION time -- the CDK synth-time Date
// ban (deterministic templates) does not apply inside the deployable.

/** Invocation event. All three date fields are optional; see resolveDates. */
interface RollupEvent {
  /** Single explicit date YYYY-MM-DD. */
  readonly date?: string;
  /** Inclusive backfill range start YYYY-MM-DD. */
  readonly backfillFrom?: string;
  /** Inclusive backfill range end YYYY-MM-DD. */
  readonly backfillTo?: string;
}

const athena = new AthenaClient({});
const s3 = new S3Client({});

/** Read a required env var (CDK sets all of these); throw if missing/empty. */
function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    throw new Error(`missing_env: ${name}`);
  }
  return v;
}

/** UTC date N days before today, as YYYY-MM-DD. */
function utcDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive UTC date range [from, to] as YYYY-MM-DD strings. */
function dateRange(from: string, to: string): string[] {
  assertIsoDate(from);
  assertIsoDate(to);
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (cur > end) throw new Error(`backfill_from_after_to: ${from} > ${to}`);
  // Bound a runaway backfill so a fat-fingered range can't scan years.
  for (let guard = 0; cur <= end && guard < 400; guard++) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Resolve the dates to roll up from the event (default: trailing 2 days). */
function resolveDates(event: RollupEvent): string[] {
  if (event.date !== undefined) {
    assertIsoDate(event.date);
    return [event.date];
  }
  if (event.backfillFrom !== undefined && event.backfillTo !== undefined) {
    return dateRange(event.backfillFrom, event.backfillTo);
  }
  // Default: yesterday + day-before (UTC) to absorb late-arriving CF logs.
  return [utcDaysAgo(1), utcDaysAgo(2)];
}

/** Delete every object under <prefix>/dt=<date>/ for an idempotent re-run. */
async function purgePartition(
  bucket: string,
  prefix: string,
  date: string,
): Promise<void> {
  assertIsoDate(date);
  const keyPrefix = `${prefix}/dt=${date}/`;
  let token: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: keyPrefix,
        ContinuationToken: token,
      }),
    );
    const objects = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => k !== undefined)
      .map((Key) => ({ Key }));
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token !== undefined);
}

/** Start an Athena query and poll to a terminal state. Throws on FAILED. */
async function runAthena(
  sql: string,
  database: string,
  workgroup: string,
  resultOutput: string,
): Promise<void> {
  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      QueryExecutionContext: { Database: database },
      WorkGroup: workgroup,
      ResultConfiguration: { OutputLocation: resultOutput },
    }),
  );
  const id = start.QueryExecutionId;
  if (id === undefined) throw new Error("athena_no_execution_id");

  const deadline = Date.now() + 8 * 60 * 1000; // 8 min poll budget
  for (;;) {
    if (Date.now() > deadline) {
      await athena
        .send(new StopQueryExecutionCommand({ QueryExecutionId: id }))
        .catch(() => undefined);
      throw new Error(`athena_timeout: ${id}`);
    }
    const got = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId: id }),
    );
    const state = got.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") return;
    if (state === "FAILED" || state === "CANCELLED") {
      const reason =
        got.QueryExecution?.Status?.StateChangeReason ?? "(no reason)";
      throw new Error(`athena_${state}: ${id}: ${reason}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export const handler = async (event: RollupEvent = {}): Promise<void> => {
  const database = env("ATHENA_DATABASE");
  const workgroup = env("ATHENA_WORKGROUP");
  const rawTable = env("RAW_TABLE");
  const rollupTable = env("ROLLUP_TABLE");
  const bucket = env("ANALYTICS_BUCKET");
  const rollupPrefix = env("ROLLUP_PREFIX");
  const resultOutput = env("RESULT_OUTPUT");

  const dates = resolveDates(event);
  for (const dt of dates) {
    // (i) idempotency: clear the partition, then (ii) INSERT fresh.
    await purgePartition(bucket, rollupPrefix, dt);
    const sql = buildRollupInsert({ database, rawTable, rollupTable }, dt);
    await runAthena(sql, database, workgroup, resultOutput);
    console.log(JSON.stringify({ event: "cf_usage_rollup", dt, outcome: "ok" }));
  }
};
