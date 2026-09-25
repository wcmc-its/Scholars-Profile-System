/**
 * Fill gaps in the durable `daily_usage` CloudFront rollup from the raw logs
 * that still exist (PR #2814, the /edit/usage range dropdown).
 *
 * Why: `/edit/usage` now reads any window back to launch from `daily_usage`
 * (partitions under `rollup/daily-usage/dt=<date>/` in the analytics bucket,
 * which has no expiry rule). The raw CloudFront logs it is rolled up from expire
 * after 90 days, so a day the nightly rollup missed (schedule disabled, a failed
 * run, the weeks before the rollup was deployed) can only be recovered while its
 * raw logs are still there. This script finds those missing days and rolls them.
 *
 * What it does, idempotently:
 *   1. Reads the rollup Lambda's own config (`aws lambda
 *      get-function-configuration`) for the analytics bucket and rollup prefix.
 *   2. Lists the existing `dt=` partitions under that prefix.
 *   3. Plans every day from `--from` (default: the oldest day whose raw logs are
 *      still guaranteed, MAX_REROLL_AGE_DAYS back) through yesterday that has NO
 *      partition. Existing partitions are never touched: the Lambda purges a
 *      day before re-inserting it, so re-rolling a day whose raw logs are partly
 *      expired would shrink good history. The Lambda also refuses such days.
 *   4. Invokes `sps-cf-usage-rollup-<env>` once per missing day with
 *      `{"date": "<day>"}` (synchronous; each day is one Athena INSERT).
 *
 * Re-runnable: a second run finds nothing missing and invokes nothing. (A day
 * with genuinely zero traffic writes no partition and is re-rolled on every run,
 * which is harmless.)
 *
 * Usage (needs AWS credentials for the SPS account in the shell):
 *   npx tsx scripts/backfills/2026-09-25-usage-rollup-history.ts --env=staging --dry-run
 *   npx tsx scripts/backfills/2026-09-25-usage-rollup-history.ts --env=staging
 *
 * Flags:
 *   --env=staging|prod  required; picks the `sps-cf-usage-rollup-<env>` Lambda.
 *   --dry-run           list the days that would be rolled; invoke nothing.
 *   --from=YYYY-MM-DD   earliest day to consider (clamped to the retention floor).
 *   --limit=<n>         roll at most n days this run (oldest first).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Mirrors MAX_REROLL_AGE_DAYS in cdk/lambda/cf-usage-rollup/queries.ts: the
 *  oldest day (in UTC days before today) whose raw logs are still guaranteed to
 *  exist under EdgeStack's 90-day expiry. */
export const MAX_REROLL_AGE_DAYS = 85;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export type BackfillArgs = {
  env: "staging" | "prod";
  dryRun: boolean;
  from?: string;
  limit?: number;
};

export function parseArgs(argv: string[]): BackfillArgs {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const env = get("env");
  if (env !== "staging" && env !== "prod") {
    throw new Error("--env=staging|prod is required");
  }
  const from = get("from");
  if (from !== undefined && !ISO_DATE.test(from)) {
    throw new Error(`--from must be YYYY-MM-DD, got ${from}`);
  }
  const limitRaw = get("limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error(`--limit must be a positive integer, got ${limitRaw}`);
  }
  return { env, dryRun: argv.includes("--dry-run"), from, limit };
}

function addDays(iso: string, delta: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** `rollup/daily-usage/dt=2026-09-01/` -> `2026-09-01` (others dropped). */
export function partitionDates(prefixes: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of prefixes) {
    const m = /dt=(\d{4}-\d{2}-\d{2})\/?$/.exec(p);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Days to roll, oldest first: every day in `[max(from, floor), yesterday]` with
 * no existing partition, where `floor` is the retention-safe oldest day.
 */
export function planBackfillDates(opts: {
  existing: Set<string>;
  today: string;
  from?: string;
  limit?: number;
}): string[] {
  const floor = addDays(opts.today, -MAX_REROLL_AGE_DAYS);
  const start = opts.from && opts.from > floor ? opts.from : floor;
  const yesterday = addDays(opts.today, -1);
  const out: string[] = [];
  for (let d = start; d <= yesterday; d = addDays(d, 1)) {
    if (!opts.existing.has(d)) out.push(d);
  }
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}

function aws(args: string[]): string {
  return execFileSync("aws", args, {
    encoding: "utf8",
    env: { ...process.env, AWS_PAGER: "" },
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fn = `sps-cf-usage-rollup-${args.env}`;
  const today = new Date().toISOString().slice(0, 10);

  const vars = JSON.parse(
    aws([
      "lambda",
      "get-function-configuration",
      "--function-name",
      fn,
      "--query",
      "Environment.Variables",
      "--output",
      "json",
    ]),
  ) as Record<string, string>;
  const bucket = vars.ANALYTICS_BUCKET;
  const prefix = vars.ROLLUP_PREFIX;
  if (!bucket || !prefix) throw new Error(`${fn} has no ANALYTICS_BUCKET / ROLLUP_PREFIX`);

  const listed = JSON.parse(
    aws([
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--prefix",
      `${prefix}/`,
      "--delimiter",
      "/",
      "--query",
      "CommonPrefixes[].Prefix",
      "--output",
      "json",
    ]),
  ) as string[] | null;
  const existing = partitionDates(listed ?? []);
  const plan = planBackfillDates({ existing, today, from: args.from, limit: args.limit });

  console.log(
    JSON.stringify({
      event: "usage_rollup_backfill_plan",
      env: args.env,
      existingPartitions: existing.size,
      oldestExisting: [...existing].sort()[0] ?? null,
      missing: plan.length,
      dryRun: args.dryRun,
    }),
  );
  if (args.dryRun) {
    for (const d of plan) console.log(`would roll ${d}`);
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "usage-backfill-"));
  let failed = 0;
  try {
    for (const d of plan) {
      const out = path.join(dir, `${d}.json`);
      const meta = JSON.parse(
        aws([
          "lambda",
          "invoke",
          "--function-name",
          fn,
          "--cli-binary-format",
          "raw-in-base64-out",
          "--cli-read-timeout",
          "900",
          "--payload",
          JSON.stringify({ date: d }),
          "--output",
          "json",
          out,
        ]),
      ) as { FunctionError?: string };
      if (meta.FunctionError) {
        failed++;
        console.error(`FAILED ${d}: ${readFileSync(out, "utf8")}`);
      } else {
        console.log(`rolled ${d}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({ event: "usage_rollup_backfill_done", rolled: plan.length - failed, failed }),
  );
  if (failed > 0) process.exitCode = 1;
}

// Run only when executed directly, so the unit test can import the planners.
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
