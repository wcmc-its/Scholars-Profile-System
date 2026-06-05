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

async function main() {
  const summary = await runReciterRefresh();
  const failed = summary.goldstandardFailed > 0 || summary.uidsFailed > 0;
  process.exit(failed ? 1 : 0);
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
