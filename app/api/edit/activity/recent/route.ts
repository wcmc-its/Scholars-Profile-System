/**
 * GET /api/edit/activity/recent?cursor=… — one "Load older" page of the
 * `/edit/activity` Recent activity feed: the next
 * {@link EDIT_ACTIVITY_RECENT_LIMIT} audit rows strictly older than `cursor`
 * (the opaque `(ts, id)` cursor the page or the previous call returned), still
 * inside the trailing 30-day window, plus the names those rows need.
 *
 * Superuser-only, like the page, re-checked on every GET. A read has no CSRF
 * surface and a cross-origin read can't see the response (CORS), so the
 * session + `isSuperuser` re-check is the whole gate (the `GET
 * /api/edit/slugs` pattern). No flag: this only pages further through the
 * rows the page already shows.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { decodeCursor, loadOlderEdits } from "@/lib/api/edit-activity";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/activity/recent";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session) return editError(401, "unauthenticated");
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "activity",
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }

  const cursor = decodeCursor(request.nextUrl.searchParams.get("cursor"));
  if (!cursor) return editError(400, "invalid_cursor", "cursor");

  try {
    const page = await loadOlderEdits(db.read, cursor);
    return editOk({ ...page });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "edit_activity_read_failed",
        path: PATH,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return editError(503, "activity_unavailable");
  }
}
