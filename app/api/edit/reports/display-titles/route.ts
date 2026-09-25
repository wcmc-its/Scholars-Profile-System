/**
 * GET /api/edit/reports/display-titles — report 10 (Display titles) as an
 * `.xlsx` of the FILTERED rows (Titles, Criteria). Same query string as the
 * page (`parseTitleDashboardParams`, then `filterTitleDashboard`), same gate
 * (a `report_access` row on `DISPLAY_TITLES_REPORT`; superuser /
 * comms_steward always).
 *
 * Exempt from SCHOLAR_EXPORT_CAP per Paul, 2026-09-25, scoped to this export
 * only (name, CWID, titles; no emails).
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { DISPLAY_TITLES_REPORT, getReportScopes } from "@/lib/edit/report-access";
import {
  filterTitleDashboard,
  loadTitleDashboard,
  parseTitleDashboardParams,
} from "@/lib/edit/title-dashboard";
import { buildTitleDashboardWorkbook } from "@/lib/edit/title-dashboard-xlsx";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if ((await getReportScopes(session, DISPLAY_TITLES_REPORT)).size === 0) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = parseTitleDashboardParams(new URL(request.url).searchParams);
  const generatedAt = new Date();
  const all = await loadTitleDashboard(db.read);
  const rows = filterTitleDashboard(all, params);
  const buffer = await buildTitleDashboardWorkbook(rows, params, all.length, generatedAt);
  const filename = `Display titles ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}
