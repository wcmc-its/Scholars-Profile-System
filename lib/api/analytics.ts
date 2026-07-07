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
 *    can be attributed across rotation cycles (#343).
 *  - search_popover_opened / search_popover_mesh_browser_clicked: Search
 *    interpretation popover open + NLM-browser-link click events (#265).
 *  - home_methods_stat_click / home_method_category_click /
 *    home_methods_explore_all_click: clicks on the home "Browse by research
 *    method" stat anchor, a category card (carries `slug`), and the "Explore
 *    all" footer link (spec §10).
 *  - search_nav_watchdog: the #1017 deploy-cutover navigation watchdog forced a
 *    hard reload because a /search soft-nav hung past the timeout. Carries
 *    `surface` (which entry point hung) and `n` (the elapsed timeout) so the
 *    firing rate can be observed and NAV_WATCHDOG_MS tuned.
 *  - search_mesh_restrict: the #396 Publications-tab "Show only MeSH-tagged
 *    matches" facet toggle was turned ON. Carries `q` so the engage rate can be
 *    observed per query. Emitted only on turn-ON, never on turn-OFF. */
export const VALID_EVENTS = new Set<string>([
  "search_click",
  "mentoring_copubs_open",
  "person_popover_open",
  "person_popover_action",
  "spotlight_paper_click",
  "search_popover_opened",
  "search_popover_mesh_browser_clicked",
  "home_methods_stat_click",
  "home_method_category_click",
  "home_methods_explore_all_click",
  "search_nav_watchdog",
  "search_mesh_restrict",
]);

/** Max logged length for any user-controlled string field. The beacon is
 *  unauthenticated (T-06-02-01), so an unbounded string would let a caller
 *  balloon the structured-log stream. 512 is generous for a query/id/slug. */
const MAX_STR = 512;

/** Coerce to a length-bounded string, or null for non-strings. */
function capStr(v: unknown): string | null {
  return typeof v === "string" ? v.slice(0, MAX_STR) : null;
}

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
      ? { department: rawFilters.department.slice(0, MAX_STR) }
      : {}),
    ...(typeof rawFilters.personType === "string"
      ? { personType: rawFilters.personType.slice(0, MAX_STR) }
      : {}),
    ...(typeof rawFilters.hasActiveGrants === "boolean"
      ? { hasActiveGrants: rawFilters.hasActiveGrants }
      : {}),
  };

  // Only echo whitelisted fields. Never spread `payload` directly.
  // All string fields are length-bounded via capStr (T-06-02-01): the beacon
  // is unauthenticated, so raw user strings must never hit the log unbounded.
  console.log(
    JSON.stringify({
      event,
      q: capStr(p.q),
      position: typeof p.position === "number" ? p.position : null,
      cwid: capStr(p.cwid),
      // Funding tab clicks identify by InfoEd account number rather than
      // cwid since hits aggregate across multiple WCM scholars.
      projectId: capStr(p.projectId),
      resultType: capStr(p.resultType),
      resultCount: typeof p.resultCount === "number" ? p.resultCount : null,
      // mentoring_copubs_open fields. Null for other events.
      mentorCwid: capStr(p.mentorCwid),
      menteeCwid: capStr(p.menteeCwid),
      n: typeof p.n === "number" ? p.n : null,
      // person_popover_* fields (#242). Null for other events.
      surface: capStr(p.surface),
      contextScholarCwid: capStr(p.contextScholarCwid),
      contextPubPmid: capStr(p.contextPubPmid),
      contextTopicSlug: capStr(p.contextTopicSlug),
      action: capStr(p.action),
      // spotlight_paper_click fields (#343). Null for other events.
      pmid: capStr(p.pmid),
      slot: typeof p.slot === "number" ? p.slot : null,
      cycleId: capStr(p.cycleId),
      subtopicId: capStr(p.subtopicId),
      // search_popover_* fields (#265). Null for other events.
      mode: capStr(p.mode),
      descriptorId: capStr(p.descriptorId),
      // home_method_category_click — carries the category slug. Null otherwise.
      slug: capStr(p.slug),
      filters,
      ts: typeof p.ts === "number" ? p.ts : Date.now(),
    }),
  );
}
