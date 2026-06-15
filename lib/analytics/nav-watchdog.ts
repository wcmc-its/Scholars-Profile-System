/**
 * #1017 deploy-cutover navigation-watchdog telemetry.
 *
 * When the watchdog forces a hard reload (a /search soft-nav stayed pending past
 * NAV_WATCHDOG_MS with the URL never moving — the deploy-cutover hang), fire a
 * fire-and-forget beacon to /api/analytics so the firing rate and surface can be
 * observed in prod. That data is what lets us tune NAV_WATCHDOG_MS or decide
 * whether a more precise deploy-skew signal is worth its complexity.
 *
 * Observe-only: this never blocks or alters the recovery navigation. It reuses
 * the existing ANALYTICS-02 beacon endpoint (lib/api/analytics.ts), logging the
 * whitelisted `surface` (which soft-nav entry point hung) and `n` (the timeout
 * that elapsed) fields under the `search_nav_watchdog` event.
 */

/** Which search soft-nav entry point hung when the watchdog tripped. */
export type NavWatchdogSurface =
  | "autocomplete_submit"
  | "autocomplete_suggestion"
  | "search_results";

export function reportNavWatchdog(surface: NavWatchdogSurface, timeoutMs: number): void {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
  try {
    const payload = {
      event: "search_nav_watchdog",
      surface,
      n: timeoutMs,
      ts: Date.now(),
    };
    navigator.sendBeacon(
      "/api/analytics",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  } catch {
    // Telemetry must never interfere with the recovery hard navigation.
  }
}
