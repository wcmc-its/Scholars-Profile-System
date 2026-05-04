/**
 * Phase 6 ANALYTICS-03 — weekly completeness snapshot cron entrypoint.
 *
 * Run via `npm run etl:completeness` (also wired into etl/orchestrate.ts
 * as a best-effort daily step — see that file for the wrapping semantics).
 *
 * Standalone usage: cron schedules this script weekly to compute the
 * snapshot independent of the daily chain. Exits 0 on success, 1 on
 * failure. STDOUT carries the structured result line for log drains.
 */
import { prisma } from "../../lib/db";
import { computeCompletenessSnapshot } from "../../lib/analytics/completeness";

async function main() {
  const result = await computeCompletenessSnapshot();
  console.log(
    JSON.stringify({
      event: "completeness_snapshot",
      ...result,
      ts: new Date().toISOString(),
    }),
  );
}

main()
  .catch((err) => {
    console.error("[Completeness] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
