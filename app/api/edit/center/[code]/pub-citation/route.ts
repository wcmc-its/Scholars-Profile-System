/**
 * GET /api/edit/center/[code]/pub-citation?start=&end=&membership=&relevance= —
 * report 18 (Publication citation report) as EVAL's `.xlsx`. Same query
 * string as the page (`parsePubCitationParams`). `[code]` is the raw
 * `Center.code`.
 *
 * Exempt from SCHOLAR_EXPORT_CAP (approved 2026-10-29) on the condition that
 * it carries NO CWID column: publication-grain, investigator names only (see
 * `lib/edit/pub-citation-report.ts`).
 *
 * Authz mirrors `/api/edit/center/[code]/nci-2a`: Curator/Owner of the
 * center, or Superuser/comms_steward (`canEditUnit`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import {
  canEditUnit,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { buildPubCitationWorkbook, parsePubCitationParams } from "@/lib/edit/pub-citation-report";
import { loadPubCitationReport } from "@/lib/edit/pub-citation-report.server";
import { editError, resolveEditIdentity } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/center/[code]/pub-citation";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const identity = await resolveEditIdentity();
  if (!identity) return editError(401, "unauthenticated");
  const { session, realCwid } = identity;

  const { code } = await params;
  const center = await db.read.center.findUnique({ where: { code }, select: { code: true } });
  if (!center) return editError(404, "unit_not_found", "code");

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

  const p = parsePubCitationParams(request.nextUrl.searchParams);
  const buffer = await buildPubCitationWorkbook(
    await loadPubCitationReport(center.code, p),
    p,
    new Date(),
  );
  const filename = `Publications ${p.start} to ${p.end}.xlsx`;
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
