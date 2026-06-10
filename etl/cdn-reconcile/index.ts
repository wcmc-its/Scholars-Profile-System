/**
 * #353 — durable CloudFront-invalidation reconciler runner (ADR-005 layer 3).
 *
 * Thin CLI around `reconcileCdnInvalidations` (lib/edit/cdn-reconcile.ts),
 * mirroring etl/search-reconcile/index.ts. Intended to run on a ≤5 min cadence;
 * the EventBridge schedule + CloudWatch alarm are the infra follow-on (#353
 * PR-2, mirroring #393's #582). Dormant (drains nothing) until
 * SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID is set.
 *
 *   tsx etl/cdn-reconcile/index.ts [--batch N] [--grace-seconds N]
 *
 * Exit code: 0 when every pending row purged (or none were pending); 1 when any
 * row failed to invalidate again, so the scheduler / alarm sees a failed run.
 */
import { reconcileCdnInvalidations } from "@/lib/edit/cdn-reconcile";

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
    console.log("Usage: tsx etl/cdn-reconcile/index.ts [--batch N] [--grace-seconds N]");
    process.exit(0);
  }
  const batchSize = parseIntArg(argv, "--batch");
  const graceSeconds = parseIntArg(argv, "--grace-seconds");
  const summary = await reconcileCdnInvalidations({ batchSize, graceSeconds });
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "edit_cdn_reconcile_crashed",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
