/**
 * GET /edit/data-sharing/export — CSV download of the S-Index Phase 1
 * admin/CTSA dashboard (`/edit/data-sharing`). Item-level: one row per
 * suppression-filtered (person, dataset) link, reusing `loadDatasetLinkRows`
 * — that loader already returns the full, unpaginated, suppression-filtered
 * set, which is exactly what an unpaginated export needs; a second loader
 * would just duplicate the same query (see `lib/api/data-sharing-report.ts`'s
 * CSV-export section header).
 *
 * No scope/filter concept: `/edit/data-sharing` is global-only, no unit
 * scoping and no query-param filters (per its own page header comment), so
 * this route carries none either — unlike `/edit/data-quality/export`.
 *
 * Gate order: flag off → 404 · no session → 401 · failed view gate → 404 ·
 * else text/csv attachment. Mirrors `/edit/data-quality/export`.
 */
import { NextResponse } from "next/server";

import {
  buildDataSharingCsv,
  buildSectionCsv,
  capDatasetLinkRows,
  CSV_SECTIONS,
  loadDataSharingReport,
  loadDatasetLinkRows,
  type CsvSection,
} from "@/lib/api/data-sharing-report";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { canViewDataSharingDashboard, isDataSharingDashboardEnabled } from "@/lib/edit/data-sharing-dashboard";

export const dynamic = "force-dynamic";
// `maxDuration` is inert under `output: "standalone"`; the real budget this route is
// bound by in prod is CloudFront's 30s origin-read timeout (`/edit*` behavior).

/** `request` is optional so the gating tests' bare `GET()` calls stay valid —
 *  Next always passes it in production. */
export async function GET(request?: Request) {
  if (!isDataSharingDashboardEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!canViewDataSharingDashboard(session)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // ?section=<aggregate> → per-table CSV of the corresponding on-page table;
  // no param keeps the original item-level export. Unknown section → 400.
  const rawSection = request ? new URL(request.url).searchParams.get("section") : null;
  if (rawSection !== null) {
    if (!(CSV_SECTIONS as readonly string[]).includes(rawSection)) {
      return new NextResponse("Unknown section", { status: 400 });
    }
    const section = rawSection as CsvSection;
    const report = await loadDataSharingReport(db.read);
    console.log(
      JSON.stringify({
        event: "export_data_sharing",
        cwid: session.cwid,
        section,
        ts: new Date().toISOString(),
      }),
    );
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(buildSectionCsv(report, section), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="data-sharing-${section}-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const linkRows = await loadDatasetLinkRows(db.read);
  const { rows, total, truncated } = capDatasetLinkRows(linkRows);

  console.log(
    JSON.stringify({
      event: "export_data_sharing",
      cwid: session.cwid,
      rows: rows.length,
      total,
      truncated,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildDataSharingCsv(rows);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="data-sharing-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
