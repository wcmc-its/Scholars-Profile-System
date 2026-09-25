/**
 * GET /api/edit/reports/clinical-trials?center=<code>[&q=&status=&phase=&sponsorType=] —
 * report 5 as an `.xlsx` (Trials, Investigators — withheld above
 * SCHOLAR_EXPORT_CAP — and Criteria), for the same filters as the page
 * (`parseClinicalTrialsParams`, `filterTrials`).
 *
 * Unit-gated like the report page, unlike the other `/api/edit/reports/*`
 * routes (person- or admin-gated):
 *   - the center must be one report 5 serves: a `center` with a
 *     `CenterProgram` taxonomy (`resolveReportsCenterCode`'s rule; report 5
 *     is center-only in `REPORT_NUMBERS_BY_KIND`);
 *   - `canEditUnit`: superuser, comms_steward, or the center's Owner/Curator
 *     (a denial is logged);
 *   - `loadReportsContext`, the page's own gate, which also refuses a retired
 *     center to anyone but a superuser.
 * `center` is required: the page always sends it, and a route has no picker
 * to fall back on.
 */
import { NextResponse, type NextRequest } from "next/server";

import { loadClinicalTrialsReport } from "@/lib/center-collaboration/clinical-trials-report";
import { db } from "@/lib/db";
import {
  canEditUnit,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { loadReportsContext } from "@/lib/edit/cancer-center-reports";
import {
  filterTrials,
  groupTrials,
  parseClinicalTrialsParams,
} from "@/lib/edit/clinical-trials-report";
import { buildClinicalTrialsWorkbook } from "@/lib/edit/clinical-trials-xlsx";
import { editError, resolveEditIdentity } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/reports/clinical-trials";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");
  const { session, realCwid } = identity;

  const sp = request.nextUrl.searchParams;
  const code = sp.get("center");
  if (!code) return editError(400, "missing_center", "center");

  const [center, program] = await Promise.all([
    db.read.center.findUnique({ where: { code }, select: { code: true } }),
    db.read.centerProgram.findFirst({ where: { centerCode: code }, select: { centerCode: true } }),
  ]);
  if (!center || !program) return editError(404, "unit_not_found", "center");

  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: center.code },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: center.code,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return editError(403, authz.reason);
  }
  const ctx = await loadReportsContext(center.code, session, db.read, "center");
  if (ctx === null) return editError(403, "not_curator");

  const params = parseClinicalTrialsParams(sp);
  const trials = filterTrials(
    groupTrials(await loadClinicalTrialsReport(db.read, center.code)),
    params,
  );
  const generatedAt = new Date();
  const buffer = await buildClinicalTrialsWorkbook(trials, params, ctx.unit.name, generatedAt);
  const filename = `Clinical trials ${center.code.replace(/[^a-zA-Z0-9_-]/g, "")} ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
