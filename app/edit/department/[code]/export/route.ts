/**
 * GET /edit/department/[code]/export — CSV download of a department's faculty
 * (extends #1102 from centers to departments/divisions).
 *
 * A department has no curated roster (its members are ED-derived faculty), so
 * this exports the active faculty shown on the public department page — faculty
 * columns only (cwid / name / title / role / division / department), NO email
 * (#847), NO membership/program/date columns (those are center-only).
 *
 * The unit CODE in the path is the authorization boundary — NEVER a query param.
 * `loadUnitEditContext("department", code, …)` re-derives the actor's role (the
 * SAME read the `/edit/department/[code]` page uses) and returns null when the
 * actor can't edit this department (or it's retired and they're not a superuser),
 * which maps to 404. Gate order mirrors the center export: flag off → 404 · no
 * session → 401 · no edit context → 404 · else a `text/csv` attachment.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { loadUnitEditContext } from "@/lib/api/unit-edit-context";
import { isUnitRosterExportEnabled } from "@/lib/edit/unit-roster-export";
import {
  buildFacultyCsv,
  loadDepartmentRosterForExport,
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

  const ctx = await loadUnitEditContext("department", code, session, db.read);
  if (ctx === null) {
    return new NextResponse("Not found", { status: 404 });
  }

  const rows = await loadDepartmentRosterForExport(
    db.read as unknown as FacultyExportClient,
    code,
  );

  console.log(
    JSON.stringify({
      event: "export_unit_members",
      cwid: session.cwid,
      unitType: "department",
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
      "Content-Disposition": `attachment; filename="department-${code}-faculty-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
