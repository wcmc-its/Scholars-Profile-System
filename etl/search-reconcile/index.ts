/**
 * #393 — durable suppression search-index reconciler runner (ADR-005 layer 3).
 *
 * Thin CLI around `reconcileSearchSuppressions` (lib/edit/search-reconcile.ts),
 * mirroring etl/search-index/index.ts. Intended to run on a ≤5 min cadence; the
 * EventBridge schedule + CloudWatch alarm are the infra follow-on (#393 PR-2,
 * coordinated with #353).
 *
 *   tsx etl/search-reconcile/index.ts [--batch N] [--grace-seconds N]
 *
 * Exit code: 0 when every stale row reconciled (or none were stale); 1 when any
 * row failed to reflect again, so the scheduler / alarm sees a failed run.
 */
import { reconcileSearchSuppressions } from "@/lib/edit/search-reconcile";
import { withEtlRun } from "@/lib/etl-run";

function parseIntArg(argv: string[], flag: string): number | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = Number(argv[i + 1]);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`Invalid value for ${flag}: ${argv[i + 1] ?? "(missing)"}`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: tsx etl/search-reconcile/index.ts [--batch N] [--grace-seconds N]");
    process.exit(0);
  }
  const batchSize = parseIntArg(argv, "--batch");
  const graceSeconds = parseIntArg(argv, "--grace-seconds");
  // The row has to open AND close before any process.exit(). Exiting inside the
  // wrapped fn would kill the process between withEtlRun's create and its
  // update, stranding every run as 'running' — so argv parsing, which exits on
  // --help and on a bad flag, stays above this line.
  await withEtlRun("SearchReconcile", async () => {
    const summary = await reconcileSearchSuppressions({ batchSize, graceSeconds });
    if (summary.failed > 0) {
      // Throwing is what makes the row say 'failed'. Returning normally would
      // write a green etl_run row beside a red Step Functions execution — the
      // green-while-broken shape this whole change exists to close. withEtlRun
      // re-throws, so the catch below still exits 1 and the Catch -> SNS path
      // is untouched.
      throw new Error(
        `${summary.failed} of ${summary.scanned} stale suppression row(s) failed to reflect`,
      );
    }
    return summary.reflected;
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "edit_search_reconcile_crashed",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
