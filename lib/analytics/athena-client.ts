/**
 * Minimal server-side Athena runner for the in-app Usage dashboard: start a
 * query in the `sps-usage-<env>` workgroup, poll to completion, return the
 * result rows as objects keyed by the column aliases. Runs on the Fargate task
 * role (default AWS credential chain) — the role is granted workgroup-scoped
 * athena/glue/s3 in AnalyticsStack. Reads the workgroup + database + region from
 * env vars the AppStack task definition sets (SPS_USAGE_*).
 *
 * This module talks to the network; the pure SQL builders (usage-queries.ts) and
 * the pure row-shaper (usage-summary.ts) are kept separate so they unit-test
 * without the SDK — the cf-usage-rollup queries.ts / index.ts split.
 */
import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "@aws-sdk/client-athena";

/** A result row keyed by the query's column aliases (all values as strings). */
export type AthenaRow = Record<string, string>;

/** Poll cadence + ceiling: daily_usage scans are tiny, so this finishes in ~1-2s;
 *  the ceiling only guards a stuck query (fail-soft to the caller). */
const POLL_INTERVAL_MS = 500;
const MAX_POLLS = 40; // 20s hard ceiling

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`missing_env: ${name}`);
  return v;
}

const client = new AthenaClient({
  region: process.env.SPS_USAGE_REGION || process.env.AWS_REGION,
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run one SQL string against the usage workgroup and return its rows as objects.
 * Throws on query FAILED/CANCELLED or if it does not finish within the poll
 * ceiling — the caller (usage-summary) treats any throw as "unavailable".
 */
export async function runUsageQuery(sql: string): Promise<AthenaRow[]> {
  const workGroup = env("SPS_USAGE_WORKGROUP");
  const database = env("SPS_USAGE_DATABASE");

  const started = await client.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: workGroup,
      QueryExecutionContext: { Database: database },
    }),
  );
  const id = started.QueryExecutionId;
  if (!id) throw new Error("athena_no_execution_id");

  for (let i = 0; i < MAX_POLLS; i++) {
    const exec = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = exec.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") return await collectRows(id);
    if (state === "FAILED" || state === "CANCELLED") {
      const reason = exec.QueryExecution?.Status?.StateChangeReason ?? state;
      throw new Error(`athena_query_${String(state).toLowerCase()}: ${reason}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("athena_query_timeout");
}

/** Read all result rows (following NextToken), mapping each to a header-keyed object. */
async function collectRows(queryExecutionId: string): Promise<AthenaRow[]> {
  let header: string[] | null = null;
  const out: AthenaRow[] = [];
  let nextToken: string | undefined;

  do {
    const res = await client.send(
      new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId, NextToken: nextToken }),
    );
    const rows = res.ResultSet?.Rows ?? [];
    for (const row of rows) {
      const cells = (row.Data ?? []).map((d) => d.VarCharValue ?? "");
      // Athena returns the column headers as the first row of the FIRST page only.
      if (header === null) {
        header = cells;
        continue;
      }
      const obj: AthenaRow = {};
      header.forEach((col, idx) => {
        obj[col] = cells[idx] ?? "";
      });
      out.push(obj);
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return out;
}
