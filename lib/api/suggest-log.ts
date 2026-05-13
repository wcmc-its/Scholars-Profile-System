/**
 * Server-side autocomplete-query logging. Enables fixture sampling for
 * the v2 ranker experiment per #231 §9 by producing a 30-day rolling
 * sample of real queries on production, with the minimum fidelity #236
 * specified: query string, UTC timestamp, hashed session identifier
 * stable within a typing burst.
 *
 * Scope notes (intentionally narrower than the full #231 §8 spec):
 *   - Only `autocomplete_shown` is emitted here. `clicked` and `refined`
 *     events are deferred to client-side beacons and require experiment-
 *     arm context (queryShape, strongHitKinds, leadKind, etc.).
 *   - Session hashing uses a single static salt. Dual-rotating-salt
 *     (`eventSessionId` + `eventSessionIdPrev`) per #231 §8.b is
 *     experiment-time infrastructure (EventBridge Lambda + Secrets
 *     Manager) and is not required for fixture sampling.
 *   - No PII in event bodies — query strings as-is, hashed session ID
 *     only, no cwid / email / IP.
 */
import { createHash } from "node:crypto";

// Per #231 §8.d — events for queries < 3 chars are dropped.
const MIN_QUERY_LENGTH = 3;

// Per #231 §8.d — bot UA filter, verbatim from the spec.
const BOT_UA_PATTERN =
  /Googlebot|bingbot|Pingdom|UptimeRobot|Datadog|StatusCake|YandexBot/i;

export type SuggestShownEvent = {
  query: string;
  resultCount: number;
  latencyMs: number;
  sessionId: string;
  userAgent: string | null;
};

function getTelemetrySalt(): string {
  return process.env.TELEMETRY_SALT ?? "scholars-profile-system-dev";
}

export function hashSessionId(rawSessionId: string): string {
  return createHash("sha256")
    .update(rawSessionId + getTelemetrySalt())
    .digest("hex")
    .slice(0, 16);
}

/**
 * Emits an `autocomplete_shown` JSON log line if the event passes the
 * min-length gate (#231 §8.d) and is not from a known bot UA. Returns
 * whether the event was logged so the route handler can mirror the
 * same drop semantics in tests.
 */
export function logAutocompleteShown(event: SuggestShownEvent): boolean {
  if (event.query.trim().length < MIN_QUERY_LENGTH) return false;
  if (event.userAgent && BOT_UA_PATTERN.test(event.userAgent)) return false;

  console.log(
    JSON.stringify({
      event: "autocomplete_shown",
      query: event.query,
      resultCount: event.resultCount,
      latencyMs: event.latencyMs,
      sessionId: event.sessionId,
      tsUtc: new Date().toISOString(),
    }),
  );
  return true;
}
