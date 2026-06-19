/**
 * GET /edit/division/[code]/export — CSV download of a division's members
 * (extends #1102 from centers to departments/divisions).
 *
 * A division's members are the ED-attached scholars (`divCode = code`) plus, for
 * a `source = 'manual'` division, its `DivisionMembership` roster — the same
 * union the public division page shows. Exported with faculty columns only (cwid
 * / name / title / role / division / department), NO email (#847), NO
 * membership/program/date columns (center-only).
 *
 * The unit CODE in the path is the authorization boundary — NEVER a query param.
 * `loadUnitEditContext("division", code, …)` re-derives the actor's role and
 * returns null when they can't edit this division (or it's retired and they're
 * not a superuser) → 404. Gate order mirrors the center export: flag off → 404 ·
 * no session → 401 · no edit context → 404 · else a `text/csv` attachment. The
 * division's `source` (which decides the manual-roster union) comes from that
 * same edit context — never the client.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { loadUnitEditContext } from "@/lib/api/unit-edit-context";
import { isUnitRosterExportEnabled } from "@/lib/edit/unit-roster-export";
import {
  buildFacultyCsv,
  loadDivisionRosterForExport,
  type FacultyExportClient,
} from "@/lib/edit/unit-faculty-export";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  if (!isUnitRosterExportEnabled()) {
    return new NextResponse("Not found", { status: 404 });
  }
  const session = await getEffectiveEditSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { code } = await params;

  const ctx = await loadUnitEditContext("division", code, session, db.read);
  if (ctx === null) {
    return new NextResponse("Not found", { status: 404 });
  }

  // `source` decides the manual-roster union — taken from the authorized edit
  // context, never the request.
  const rows = await loadDivisionRosterForExport(
    db.read as unknown as FacultyExportClient,
    code,
    ctx.unit.source,
  );

  console.log(
    JSON.stringify({
      event: "export_unit_members",
      cwid: session.cwid,
      unitType: "division",
      unitCode: code,
      rows: rows.length,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildFacultyCsv(rows);
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="division-${code}-faculty-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
