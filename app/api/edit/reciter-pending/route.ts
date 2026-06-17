/**
 * GET /api/edit/reciter-pending — the self viewer's live ReCiter "pending /
 * suggested" candidate publications (`SELF_EDIT_RECITER_PENDING_HINT`).
 *
 * Replaces the nightly `reciter_pending_suggestion` table with a LIVE read of
 * the ReCiter engine (Feature Generator + a fresh gold-standard cross-check, in
 * `fetchSuggestedArticles`) so a paper the scholar just curated disappears from
 * the nudge immediately rather than lingering until the next ETL.
 *
 * SELF-ONLY by construction: the uid is the authenticated session's OWN
 * `session.cwid` — the real signed-in scholar, NEVER an impersonation target
 * (`getEffectiveCwid` returns the "View as" target; we deliberately do NOT use
 * it here). A superuser viewing another scholar therefore reads their OWN
 * suggestions or, far more often, nothing.
 *
 * Dormant-safe: returns `{ suggestions: [] }` when the flag is off OR there is
 * no session. The client read in `fetchSuggestedArticles` already degrades to
 * `[]` on any error / not-configured / timeout (and a failed gold-standard read
 * hides everything rather than risk surfacing an already-curated pub); the
 * try/catch here is belt-and-suspenders so this route NEVER throws to the client.
 */
import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session-server";
import { isReciterPendingHintEnabled } from "@/lib/edit/reciter-pending-hint";
import { fetchSuggestedArticles, type ReciterSuggestion } from "@/lib/reciter/client";

// Live ReCiter read, gated on the signed-in identity — never cache it.
export const dynamic = "force-dynamic";

function empty(): NextResponse {
  return NextResponse.json(
    { suggestions: [] as ReciterSuggestion[] },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function GET(): Promise<NextResponse> {
  // Flag off ⇒ dormant. Cheap short-circuit before touching the session.
  if (!isReciterPendingHintEnabled()) return empty();

  const session = await getSession();
  // No session ⇒ nothing to read (middleware also gates `/api/edit/*`).
  if (!session) return empty();

  try {
    // `session.cwid` is the REAL signed-in scholar's CWID — the self-only uid.
    // An impersonating superuser's effective target is intentionally ignored.
    const suggestions = await fetchSuggestedArticles(session.cwid);
    return NextResponse.json(
      { suggestions },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    // `fetchSuggestedArticles` already degrades to [] on any failure; this guard
    // covers an unexpected throw so the client always gets a clean empty payload.
    return empty();
  }
}
