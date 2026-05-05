/**
 * Phase 6 / ANALYTICS-02 (CTR side) — pure-function handlers for the
 * client-side analytics beacon. Per ADR-001 the route file at
 * `app/api/analytics/route.ts` is a thin delegator; all logic lives here.
 *
 * Threat model (T-06-02-01 log poisoning): only fields with the expected
 * primitive types from a known event are logged. Unknown event types are
 * silently dropped (return 204, no log) so a malicious caller cannot
 * inject arbitrary keys/values into the structured log stream.
 */

/** Event types accepted by the beacon endpoint. Phase 6 ships one. */
export const VALID_EVENTS = new Set<string>(["search_click"]);

/**
 * Validates the beacon payload and emits a structured `search_click` log
 * line. Pure: no Next.js / fs / network dependencies. Safe to call from
 * any context (route handler, test, future server-to-server pipeline).
 *
 * Returns void: the route handler returns 204 regardless of validation
 * outcome (fire-and-forget beacon must not block client navigation).
 */
export function handleAnalyticsBeacon(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const p = payload as Record<string, unknown>;
  const event = typeof p.event === "string" ? p.event : "";
  if (!VALID_EVENTS.has(event)) return;

  // Sanitize filters to known fields with explicit type checks (T-06-02-01).
  const rawFilters =
    typeof p.filters === "object" && p.filters !== null
      ? (p.filters as Record<string, unknown>)
      : {};
  const filters = {
    ...(typeof rawFilters.department === "string"
      ? { department: rawFilters.department }
      : {}),
    ...(typeof rawFilters.personType === "string"
      ? { personType: rawFilters.personType }
      : {}),
    ...(typeof rawFilters.hasActiveGrants === "boolean"
      ? { hasActiveGrants: rawFilters.hasActiveGrants }
      : {}),
  };

  // Only echo whitelisted fields. Never spread `payload` directly.
  console.log(
    JSON.stringify({
      event,
      q: typeof p.q === "string" ? p.q : null,
      position: typeof p.position === "number" ? p.position : null,
      cwid: typeof p.cwid === "string" ? p.cwid : null,
      resultType: typeof p.resultType === "string" ? p.resultType : null,
      resultCount: typeof p.resultCount === "number" ? p.resultCount : null,
      filters,
      ts: typeof p.ts === "number" ? p.ts : Date.now(),
    }),
  );
}
