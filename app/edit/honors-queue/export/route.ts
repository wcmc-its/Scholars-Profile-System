/**
 * GET /edit/honors-queue/export — CSV report of every honor (all statuses),
 * for the Research Dean's office (#1762). Same gate as the queue page (the query,
 * not the UI, is the boundary): flag off → 404 · no session → 401 · neither
 * superuser nor honors_curator → 404 · else a text/csv attachment.
 *
 * Scope is the FULL record — pending, published, and rejected, self-asserted
 * included — with a Status and Source column, so the office filters it in a
 * spreadsheet rather than the queue dictating the report. `force-dynamic`,
 * no-store, like the other `/edit/*` exports.
 */
import { NextResponse } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { buildHonorCsv, isHonorQueueEnabled, loadHonorExport } from "@/lib/edit/honor-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  if (!isHonorQueueEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  // `isSuperuser || isHonorsCurator`, never a bare curator read — same reason as
  // the page (the session route reports `isDeveloper:false` for a superuser).
  if (!session.isSuperuser && session.isHonorsCurator !== true) {
    return new NextResponse("Not found", { status: 404 });
  }

  const rows = await loadHonorExport(db.read);
  console.log(
    JSON.stringify({
      event: "export_honors",
      cwid: session.cwid,
      rows: rows.length,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildHonorCsv(rows);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="honors-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
