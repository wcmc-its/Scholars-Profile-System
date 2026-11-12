/**
 * GET /api/edit/activity/export?range=…&asOf=… — every edit in the chosen
 * `/edit/activity` range as CSV (who, editor kind, action, entity, fields;
 * never the changed values). `asOf` is the page's `generatedAt`, so the file
 * matches the totals on screen.
 *
 * Same gate as the page (`canViewDashboard(session, "activity")`), re-checked
 * per request. A GET with no side effects; the session + gate is the whole
 * gate (the `GET /api/edit/activity/recent` pattern).
 */
import { type NextRequest, NextResponse } from "next/server";

import { loadEditActivityCsv, parseAsOf, parseRange } from "@/lib/api/edit-activity";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { canViewDashboard } from "@/lib/edit/dashboard-access";
import { db } from "@/lib/db";
import { logEditDenial } from "@/lib/edit/authz";
import { resolveDirectoryPeople } from "@/lib/edit/directory-names";
import { editError } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/activity/export";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session) return editError(401, "unauthenticated");
  if (!(await canViewDashboard(session, "activity"))) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: "activity", path: PATH, reason: "not_superuser" });
    return editError(403, "not_superuser");
  }
  const range = parseRange(request.nextUrl.searchParams.get("range"));
  const asOf = parseAsOf(request.nextUrl.searchParams.get("asOf"));
  if (!asOf) return editError(400, "invalid_as_of", "asOf");

  try {
    const csv = await loadEditActivityCsv(db.read, range, asOf, resolveDirectoryPeople);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="edit-activity-${range}-${asOf.toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "edit_activity_export_failed",
        path: PATH,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return editError(500, "activity_unavailable");
  }
}
