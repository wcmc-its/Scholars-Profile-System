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
import { logNotFound, type NotFoundPattern } from "@/lib/analytics/errors";
import { logVivoFourOhFour } from "@/lib/analytics/vivo-pattern";

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
 *    observed per query. Emitted only on turn-ON, never on turn-OFF.
 *  - biosketch_worksheet_copy: a Copy on the SciENcv worksheet (#2652). Carries
 *    `surface` (which block was copied) and `cwid` (the scholar the worksheet is
 *    for). Distinct (cwid, day) is the "completed worksheet" denominator — the
 *    feature's only adoption signal.
 *  - grant_rec_impression / grant_rec_details_open / grant_rec_outbound_click /
 *    grant_rec_sort: the /edit "Grants for me" card (#1609). Every one carries
 *    `cwid` (the scholar the list is for), `surface` (`self` | `superuser` — the
 *    viewer, so superuser QA never inflates scholar engagement) and `mode` (the
 *    active sort chip). An impression is one list render: `resultCount` +
 *    `opportunityIds` (rank order). Details-open / outbound-click carry
 *    `opportunityId` + 0-based `position`; grant_rec_sort's `mode` is the chip
 *    just chosen. Save / Not-relevant are NOT beacons — they are durable rows in
 *    `grant_rec_feedback` (+ the B03 audit log). */
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
  "biosketch_worksheet_copy",
  "grant_rec_impression",
  "grant_rec_details_open",
  "grant_rec_outbound_click",
  "grant_rec_sort",
]);

/** Max logged length for any user-controlled string field. The beacon is
 *  unauthenticated (T-06-02-01), so an unbounded string would let a caller
 *  balloon the structured-log stream. 512 is generous for a query/id/slug. */
const MAX_STR = 512;

/** Coerce to a length-bounded string, or null for non-strings. */
function capStr(v: unknown): string | null {
  return typeof v === "string" ? v.slice(0, MAX_STR) : null;
}

/** Max ids logged from an array field — the grant-recs route caps a list at 100. */
const MAX_IDS = 100;

/** Coerce to a bounded array of bounded strings (non-strings dropped), or null
 *  for a non-array. Same log-poisoning posture as {@link capStr}. */
function capStrArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((x): x is string => typeof x === "string")
    .slice(0, MAX_IDS)
    .map((x) => x.slice(0, MAX_STR));
}

/**
 * `not_found` — sent by `components/site/not-found-beacon.tsx` when a 404
 * page mounts. Deliberately NOT in `VALID_EVENTS`: it is not echoed through
 * the generic click-log shape below but re-emitted through the existing
 * `logNotFound` (and, for the root not-found, `logVivoFourOhFour`) emitters so
 * the CloudWatch event shapes are unchanged from when the not-found files
 * logged server-side. The not-found files can no longer log server-side:
 * reading the path there needed `headers()`, which forced every route dynamic.
 */
const NOT_FOUND_EVENT = "not_found";
const NOT_FOUND_PATTERNS = new Set<NotFoundPattern>(["vivo", "profile", "other"]);

function handleNotFoundBeacon(p: Record<string, unknown>): void {
  if (typeof p.path !== "string" || !p.path.startsWith("/")) return;
  // Path only, never query/fragment (privacy — docs/error-handling-spec.md §6).
  // The client sends location.pathname, but the endpoint is unauthenticated.
  const path = p.path.split(/[?#]/, 1)[0].slice(0, MAX_STR);
  const pattern = p.pattern as NotFoundPattern;
  if (!NOT_FOUND_PATTERNS.has(pattern)) return;
  logNotFound({ path, pattern });
  // The root not-found always emitted vivo_404 alongside not_found (the
  // helper itself only logs on a /display/cwid-… match) — keep that exactly.
  if (p.variant === "root") logVivoFourOhFour(path);
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
  if (event === NOT_FOUND_EVENT) {
    handleNotFoundBeacon(p);
    return;
  }
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
      // grant_rec_* fields (#1609). Null for other events.
      opportunityId: capStr(p.opportunityId),
      opportunityIds: capStrArray(p.opportunityIds),
      filters,
      ts: typeof p.ts === "number" ? p.ts : Date.now(),
    }),
  );
}
