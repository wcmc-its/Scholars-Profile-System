/**
 * GET /edit/titles-queue/export — the Titles queue as an `.xlsx` of the
 * FILTERED rows (Titles, Criteria). Same query string as the page
 * (`parseTitleDashboardParams`, then `filterTitleDashboard`), same gate as the
 * page (`canReviewTitles`: superuser / comms_steward): no session → 401,
 * anyone else → 404, like `/edit/honors-queue/export`. An unset `tab` exports
 * every tab, so a bare link exports the whole list.
 *
 * Exempt from SCHOLAR_EXPORT_CAP per Paul, 2026-09-25, scoped to this export
 * only (name, CWID, titles; no emails). It was report 10's export
 * (`/api/edit/reports/display-titles`) until the report moved under Queues.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  filterTitleDashboard,
  loadTitleDashboard,
  parseTitleDashboardParams,
} from "@/lib/edit/title-dashboard";
import { buildTitleDashboardWorkbook } from "@/lib/edit/title-dashboard-xlsx";
import { canReviewTitles } from "@/lib/edit/titles-queue";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!canReviewTitles(session)) return new NextResponse("Not found", { status: 404 });

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
