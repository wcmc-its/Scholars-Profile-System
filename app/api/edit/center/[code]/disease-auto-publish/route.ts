/**
 * POST /api/edit/center/[code]/disease-auto-publish — turn a center's
 * "Auto-publish high-confidence inferences" switch on or off
 * (`Center.diseaseAutoPublish`, read by `lib/cancer-center-disease-publish.ts`).
 *
 * Body: `{ enabled: boolean }`.
 *
 * Authz mirrors `/api/edit/center/[code]/disease-assignments` exactly: `[code]`
 * is the raw `Center.code`, it must resolve to a center WITH a `CenterProgram`
 * taxonomy (the data-driven Cancer-Center-only gate; `400 no_program_taxonomy`
 * otherwise), and the actor must be Curator/Owner of THIS center or
 * Superuser/comms_steward (`canEditUnit`).
 *
 * Setting the value it already has is a no-op (`changed: false`, no audit row).
 * Otherwise one `db.write.$transaction` updates the column and appends a
 * `disease_auto_publish_set` audit row (`targetEntityType: "center"`,
 * `targetEntityId` the code, before/after `{ diseaseAutoPublish }`), with
 * `actorCwid` the real accountable human, never the impersonated cwid.
 *
 * No ISR revalidation: nothing public reads the switch yet. The public center
 * page that will (PR5) must revalidate here when it lands.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canEditUnit,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/disease-auto-publish";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { enabled } = body;
  if (typeof enabled !== "boolean") {
    return editError(400, "invalid_enabled", "enabled");
  }

  const { code } = await params;
  const center = await db.read.center.findUnique({
    where: { code },
    select: { code: true, diseaseAutoPublish: true },
  });
  if (!center) return editError(400, "unit_not_found", "code");

  const program = await db.read.centerProgram.findFirst({
    where: { centerCode: center.code },
    select: { code: true },
  });
  if (!program) return editError(400, "no_program_taxonomy", "code");

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

  if (center.diseaseAutoPublish === enabled) {
    return editOk({ code: center.code, enabled, changed: false });
  }

  try {
    await db.write.$transaction(async (tx) => {
      await tx.center.update({
        where: { code: center.code },
        data: { diseaseAutoPublish: enabled },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center",
        targetEntityId: center.code,
        action: "disease_auto_publish_set",
        fieldsChanged: ["diseaseAutoPublish"],
        beforeValues: { diseaseAutoPublish: center.diseaseAutoPublish },
        afterValues: { diseaseAutoPublish: enabled },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ code: center.code, enabled, changed: true });
}
