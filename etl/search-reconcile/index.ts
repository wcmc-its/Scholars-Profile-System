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
  const summary = await reconcileSearchSuppressions({ batchSize, graceSeconds });
  process.exit(summary.failed > 0 ? 1 : 0);
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
