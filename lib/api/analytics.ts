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

/** Event types accepted by the beacon endpoint.
 *  - search_click: result clicks on /search (Phase 6 / ANALYTICS-02).
 *  - mentoring_copubs_open: scholar profile co-pubs popover opened (#181).
 *  - person_popover_open / person_popover_action: PersonPopover open + primary
 *    action click events (#242).
 *  - spotlight_paper_click: representative-paper clicks in the home Spotlight
 *    section, carrying PMID + publish-cycle ID so the #286 CTR success metric
 *    can be attributed across rotation cycles (#343). */
export const VALID_EVENTS = new Set<string>([
  "search_click",
  "mentoring_copubs_open",
  "person_popover_open",
  "person_popover_action",
  "spotlight_paper_click",
]);

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
      // Funding tab clicks identify by InfoEd account number rather than
      // cwid since hits aggregate across multiple WCM scholars.
      projectId: typeof p.projectId === "string" ? p.projectId : null,
      resultType: typeof p.resultType === "string" ? p.resultType : null,
      resultCount: typeof p.resultCount === "number" ? p.resultCount : null,
      // mentoring_copubs_open fields. Null for other events.
      mentorCwid: typeof p.mentorCwid === "string" ? p.mentorCwid : null,
      menteeCwid: typeof p.menteeCwid === "string" ? p.menteeCwid : null,
      n: typeof p.n === "number" ? p.n : null,
      // person_popover_* fields (#242). Null for other events.
      surface: typeof p.surface === "string" ? p.surface : null,
      contextScholarCwid:
        typeof p.contextScholarCwid === "string" ? p.contextScholarCwid : null,
      contextPubPmid:
        typeof p.contextPubPmid === "string" ? p.contextPubPmid : null,
      contextTopicSlug:
        typeof p.contextTopicSlug === "string" ? p.contextTopicSlug : null,
      action: typeof p.action === "string" ? p.action : null,
      // spotlight_paper_click fields (#343). Null for other events.
      pmid: typeof p.pmid === "string" ? p.pmid : null,
      slot: typeof p.slot === "number" ? p.slot : null,
      cycleId: typeof p.cycleId === "string" ? p.cycleId : null,
      subtopicId: typeof p.subtopicId === "string" ? p.subtopicId : null,
      filters,
      ts: typeof p.ts === "number" ? p.ts : Date.now(),
    }),
  );
}
