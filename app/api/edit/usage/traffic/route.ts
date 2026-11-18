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
 *
 * Same scope as the page too: for a department / division / center admin a
 * pages list holds only their own people's profile pages. The scope is
 * resolved from the session here, never taken from the request. Referrer lists
 * are site-wide for everyone.
 */
import { type NextRequest, NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import {
  loadScopedPageList,
  loadTrafficList,
  parseTrafficListRequest,
  rangeFromSearchParams,
} from "@/lib/api/usage-traffic";
import { logEditDenial } from "@/lib/edit/authz";
import {
  canViewDashboard,
  loadDashboardScope,
  loadScopeSlugs,
} from "@/lib/edit/dashboard-access";
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
    const w = { since: range.since, until: range.until };
    const scope = await loadDashboardScope(session, "usage");
    const page =
      scope.all || req.list !== "pages"
        ? await loadTrafficList(w, req)
        : await loadScopedPageList(w, req, await loadScopeSlugs(scope.memberCwids));
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
