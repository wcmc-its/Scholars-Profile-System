/**
 * `/edit/titles-queue` — the Titles queue's gate and its nav pill count.
 *
 * The queue lists the scholars whose display title needs an operator
 * (`lib/edit/title-dashboard.ts`: contested, leadership lost, role/title
 * mismatch, ...), resolved by pinning a title. It was report 10 ("Display
 * titles") until it moved under Queues; it is pending work, not a report.
 *
 * Gate: superuser OR comms_steward — exactly who may pin a display title
 * (`authorizeFieldEdit`'s `primaryTitle` branch, `lib/edit/authz.ts`). The
 * page, its `.xlsx` export and the nav tab all read this one predicate.
 *
 * The pill is the "Needs review" count. It needs the full
 * `loadTitleDashboard` pass (~9.4k candidates in memory), too heavy to run on
 * every console page render, so a SUCCESSFUL count is memoized in-process for
 * a few minutes (and dropped when a title is pinned through
 * `/api/edit/field`). A failed count is NOT memoized: it returns null, the
 * nav shows the tab with no pill, and the next render tries again. The queue
 * page itself passes the exact count it just computed.
 *
 * Server-only (reads the database through `loadTitleDashboard`).
 */
import type { EditSession } from "@/lib/auth/superuser";
import { loadTitleDashboard, titleTabOf } from "@/lib/edit/title-dashboard";

type TitlesSession = Pick<EditSession, "isSuperuser" | "isCommsSteward">;

/** Superuser or comms steward: the people who can pin a display title. */
export function canReviewTitles(session: TitlesSession): boolean {
  return session.isSuperuser || session.isCommsSteward === true;
}

/** How long a successful pending count is reused across requests. */
export const TITLES_PENDING_TTL_MS = 5 * 60 * 1000;

let memo: { value: number; at: number } | null = null;
let inFlight: Promise<number> | null = null;

/** Forget the memoized count, so the next nav render recounts. Called after a
 *  display-title pin or unpin. */
export function invalidateTitlesPendingCount(): void {
  memo = null;
}

/** The number of "Needs review" rows. Null when the count fails (logged);
 *  never throws, so a failure costs the pill and nothing else. */
export async function countTitlesNeedingReview(
  client: Parameters<typeof loadTitleDashboard>[0],
  now: number = Date.now(),
): Promise<number | null> {
  if (memo && now - memo.at < TITLES_PENDING_TTL_MS) return memo.value;
  // Concurrent renders share one load.
  const p = (inFlight ??= loadTitleDashboard(client).then(
    (rows) => rows.filter((r) => titleTabOf(r) === "review").length,
  ));
  try {
    const value = await p;
    memo = { value, at: now };
    return value;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "titles_pending_count_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  } finally {
    if (inFlight === p) inFlight = null;
  }
}

/** Record an exact count the queue page just computed, so the pill on the
 *  next console page agrees with the page the operator just left. */
export function rememberTitlesPendingCount(value: number, now: number = Date.now()): void {
  memo = { value, at: now };
}
