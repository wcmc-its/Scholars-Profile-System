/**
 * #746 — delayed ReCiter re-score scanner runner. Thin CLI around
 * `runReciterRefresh` (lib/reciter/refresh.ts), mirroring
 * etl/search-reconcile/index.ts. Intended to run ~hourly; the EventBridge
 * schedule + Step Function are a follow-up (the table + the scanner are the
 * contract). Dormant (`RECITER_REJECT_SEND` off, or the API unconfigured) ⇒ a
 * no-op success.
 *
 *   tsx etl/reciter-refresh/index.ts
 *
 * Exit code: 0 when nothing failed (or the feature is dormant); 1 when any
 * goldstandard POST or feature-generator re-score failed, so the scheduler /
 * alarm sees a failed run.
 */
import { runReciterRefresh } from "@/lib/reciter/refresh";
import { withEtlRun } from "@/lib/etl-run";

async function main() {
  // Operator-run, so this row is a record of a HUMAN run, not of a schedule.
  // That is exactly why "ReciterRefresh" must NOT be added to TRACKED in
  // lib/etl/freshness-policy.ts: a step nobody runs on a cadence goes stale by
  // design, and tracking it would turn the freshness heartbeat red for doing
  // nothing wrong.
  await withEtlRun("ReciterRefresh", async () => {
    const summary = await runReciterRefresh();
    if (summary.goldstandardFailed > 0 || summary.uidsFailed > 0) {
      throw new Error(
        `${summary.goldstandardFailed} gold-standard POST(s) and ` +
          `${summary.uidsFailed} re-score(s) failed`,
      );
    }
    return summary.uidsRefreshed;
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "reciter_refresh_crashed",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
