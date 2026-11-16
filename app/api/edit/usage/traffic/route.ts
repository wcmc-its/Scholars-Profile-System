/**
 * GET /api/edit/usage/traffic?list=referrers|pages&range=…[&from=&to=]&… — one
 * page (25 rows, busiest first) of a Usage-dashboard traffic list, read from
 * the `daily_traffic` rollup, plus the matching-row total:
 *  - list=referrers: `view=site|page`, `cats=<category,…>`, `q=<search>`.
 *  - list=pages: `kind=all|home|profile|topics|methods`, and for landing pages
 *    `cats=<category,…>` and/or `ai=fetch,crawler`.
 *  - `offset` for "Show 25 more".
 * The range params are the page's own (`resolveUsageRange`), so the list always
 * covers the window on screen.
 *
 * Same gate as the page (`canViewDashboard(session, "usage")`), re-checked per
 * request. A GET with no side effects.
 */
import { type NextRequest, NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import {
  loadTrafficList,
  parseTrafficListRequest,
  rangeFromSearchParams,
} from "@/lib/api/usage-traffic";
import { logEditDenial } from "@/lib/edit/authz";
import { canViewDashboard } from "@/lib/edit/dashboard-access";
import { editError } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/usage/traffic";

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
  const req = parseTrafficListRequest(sp);
  if (!req) return editError(400, "invalid_params");
  const range = rangeFromSearchParams(sp);
  try {
    const page = await loadTrafficList({ since: range.since, until: range.until }, req);
    return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "usage_traffic_list_failed",
        path: PATH,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return editError(500, "usage_traffic_unavailable");
  }
}
