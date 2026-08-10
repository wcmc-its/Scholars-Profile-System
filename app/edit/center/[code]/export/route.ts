/**
 * GET /edit/center/[code]/export — CSV download of a center's FULL roster
 * (#1102). The Members-tab "Export CSV" affordance points here.
 *
 * The unit CODE in the path is the authorization boundary — NEVER a query param.
 * The route re-derives the actor's effective role by calling `loadUnitEditContext`
 * (the SAME read the `/edit/center/[code]` page and its Members tab use); that
 * helper returns `null` when the actor can't edit this center (or it's retired and
 * they're not a superuser), which we map to 404.
 *
 * Gate order (mirrors `/edit/data-quality/export`): flag off → 404 · no session →
 * 401 · no edit context (can't edit / no such center) → 404 · else a `text/csv`
 * attachment, `force-dynamic`, `no-store`.
 *
 * Columns + status derivation live in `lib/edit/unit-roster-export.ts`; the
 * `status` column matches the Members-tab badge exactly. `?activeOnly=1` drops
 * pending + inactive rows. NO email column (#847).
 */
import { NextResponse, type NextRequest } from "next/server";

import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  buildUnitRosterCsv,
  countRosterCsvRows,
  isUnitRosterExportEnabled,
  loadRosterFacultyMeta,
  type RosterFacultyClient,
} from "@/lib/edit/unit-roster-export";
import { loadUnitEditContext } from "@/lib/api/unit-edit-context";

export const dynamic = "force-dynamic";
// `maxDuration` is inert under `output: "standalone"`; the real budget this route is
// bound by in prod is CloudFront's 30s origin-read timeout (`/edit*` behavior).

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

  // The unit CODE is the scope: `loadUnitEditContext` re-derives the actor's
  // role on THIS center and returns null when they can't edit it (or it's a
  // retired unit they can't see). Anything but a real edit context → 404.
  const ctx = await loadUnitEditContext("center", code, session, db.read);
  if (ctx === null) {
    return new NextResponse("Not found", { status: 404 });
  }

  const activeOnly = request.nextUrl.searchParams.get("activeOnly") === "1";
  const today = new Date().toISOString().slice(0, 10);

  // Faculty block (email / role / dept / division) joined by cwid. Loaded HERE
  // rather than on `UnitEditContext` — that context is serialized to the client
  // for the Members tab, and email must not ride along into a browser payload.
  // `as unknown as` matches the division export's `FacultyExportClient` cast —
  // the narrow client type is a select-shaped subset Prisma's broad `findMany`
  // signature doesn't structurally satisfy.
  const facultyByCwid = await loadRosterFacultyMeta(
    (ctx.roster ?? []).map((m) => m.cwid),
    db.read as unknown as RosterFacultyClient,
  );
  const options = { today, activeOnly, facultyByCwid };

  const rows = countRosterCsvRows(ctx, options);

  console.log(
    JSON.stringify({
      event: "export_unit_members",
      cwid: session.cwid,
      unitType: "center",
      unitCode: code,
      rows,
      // Emails actually emitted, post-carve — the auditable number. Diverges
      // from `rows` whenever a hidden role or a `none` release code blanks a
      // cell, so a disclosure review can see the gate working (or not firing,
      // while PROFILE_EMAIL_RELEASE_GATE is off).
      emailRows: [...facultyByCwid.values()].filter((m) => m.email).length,
      activeOnly,
      ts: new Date().toISOString(),
    }),
  );

  const csv = buildUnitRosterCsv(ctx, options);
  const date = today;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="center-${code}-roster-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
