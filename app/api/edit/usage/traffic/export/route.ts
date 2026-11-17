/**
 * GET /api/edit/usage/traffic/export?range=…[&from=&to=]&grain=week|month —
 * the Usage dashboard's "Download Excel": one .xlsx for the selected range
 * (Summary, Sources by week/month, Referring sites, Referring pages, Top pages,
 * Landing pages, AI), built by `buildUsageTrafficWorkbook`. Every list sheet
 * carries all its rows, not the 25 on screen.
 *
 * Same gate as the page (`canViewDashboard(session, "usage")`), re-checked per
 * request. A GET with no side effects.
 *
 * Same scope as the page too: for a department / division / center admin the
 * Top pages and Landing pages sheets hold only their own people's profile
 * pages (resolved from the session, never from the request), and the Summary
 * sheet says so. The other sheets are site-wide for everyone.
 */
import { type NextRequest, NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import {
  loadTrafficExportRows,
  loadTrafficOverview,
  rangeFromSearchParams,
} from "@/lib/api/usage-traffic";
import { logEditDenial } from "@/lib/edit/authz";
import {
  canViewDashboard,
  loadDashboardScope,
  loadScopeSlugs,
} from "@/lib/edit/dashboard-access";
import { editError } from "@/lib/edit/request";
import { buildUsageTrafficWorkbook } from "@/lib/edit/usage-traffic-xlsx";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/usage/traffic/export";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getEffectiveEditSession();
  if (!session) return editError(401, "unauthenticated");
  if (!(await canViewDashboard(session, "usage"))) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: "usage",
      path: PATH,
      reason: "not_superuser_or_unit_admin",
    });
    return editError(403, "not_superuser_or_unit_admin");
  }
  const sp = request.nextUrl.searchParams;
  const grain = sp.get("grain") === "month" ? "month" : "week";
  const range = rangeFromSearchParams(sp);
  const w = { since: range.since, until: range.until };
  try {
    const scope = await loadDashboardScope(session, "usage");
    const [overview, lists] = await Promise.all([
      loadTrafficOverview(w),
      loadTrafficExportRows(w, scope.all ? undefined : await loadScopeSlugs(scope.memberCwids)),
    ]);
    const buffer = await buildUsageTrafficWorkbook(
      overview,
      lists,
      grain,
      scope.all ? undefined : scope.unitNames.join(", "),
    );
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="scholars-usage-${range.since}-to-${range.until}.xlsx"`,
        "content-length": String(buffer.byteLength),
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "usage_traffic_export_failed",
        path: PATH,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return editError(500, "usage_traffic_unavailable");
  }
}
