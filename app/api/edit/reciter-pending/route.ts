/**
 * GET /api/edit/reciter-pending — live ReCiter "pending / suggested" candidate
 * publications (`SELF_EDIT_RECITER_PENDING_HINT`).
 *
 * Replaces the nightly `reciter_pending_suggestion` table with a LIVE read of
 * the ReCiter engine (Feature Generator + a fresh gold-standard cross-check, in
 * `fetchSuggestedArticles`) so a paper the scholar just curated disappears from
 * the nudge immediately rather than lingering until the next ETL.
 *
 * Self OR an authorized superuser viewing the target — the route is the authz
 * point for the client-supplied `?cwid`. The client may pass the target scholar's
 * cwid (the superuser-parity case, mirroring the COI-gap hint); this route
 * authorizes it: a non-superuser may ONLY read their own `session.cwid`, so a
 * mismatched `?cwid` from a plain scholar degrades to empty. The "View as"
 * effective target (`getEffectiveCwid`) is deliberately NOT used — the caller
 * passes the target explicitly and we re-authorize against the REAL signed-in
 * identity.
 *
 * Dormant-safe: returns `{ suggestions: [] }` when the flag is off OR there is
 * no session. The client read in `fetchSuggestedArticles` already degrades to
 * `[]` on any error / not-configured / timeout (and a failed gold-standard read
 * hides everything rather than risk surfacing an already-curated pub); the
 * try/catch here is belt-and-suspenders so this route NEVER throws to the client.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { isReciterPendingHintEnabled } from "@/lib/edit/reciter-pending-hint";
import {
  fetchSuggestedArticles,
  fetchSuggestedArticlesViaApi,
  preferReciterApiSource,
  type ReciterSuggestion,
} from "@/lib/reciter/client";

// Live ReCiter read, gated on the signed-in identity — never cache it.
export const dynamic = "force-dynamic";

function empty(): NextResponse {
  return NextResponse.json(
    { suggestions: [] as ReciterSuggestion[] },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Flag off ⇒ dormant. Cheap short-circuit before touching the session.
  if (!isReciterPendingHintEnabled()) return empty();

  // The effective edit session carries the live `isSuperuser` re-check; it equals
  // the real signed-in identity except under a "View as" overlay (where cwid is the
  // impersonated target). Either way the authz below is keyed on this session's own
  // cwid/isSuperuser, matching the `/edit/scholar/[cwid]` page's gate.
  const session = await getEffectiveEditSession();
  // No session ⇒ nothing to read (middleware also gates `/api/edit/*`).
  if (!session) return empty();

  // The client may pass the target scholar's cwid (superuser-parity case);
  // default to the signed-in identity when absent/blank (the self case).
  const requested = new URL(request.url).searchParams.get("cwid")?.trim();
  const targetCwid = requested && requested.length ? requested : session.cwid;

  // AUTHORIZE the client-supplied cwid here — the route is the authz point. A
  // non-superuser may ONLY read their own suggestions; a mismatched target from a
  // plain scholar degrades to empty rather than leaking another scholar's read.
  if (targetCwid !== session.cwid && !session.isSuperuser) return empty();

  try {
    // RECITER_PENDING_SOURCE=api ⇒ read from the engine's Feature Generator API
    // (sidesteps the S3-offloaded Analysis read where the SPS task can reach the
    // engine but not the offloaded object); otherwise the DynamoDB/S3 source.
    const suggestions = preferReciterApiSource()
      ? await fetchSuggestedArticlesViaApi(targetCwid)
      : await fetchSuggestedArticles(targetCwid);
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
