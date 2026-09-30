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
 * One `db.write.$transaction` does a compare-and-set ON THE PRIMARY
 * (`updateMany where diseaseAutoPublish = !enabled`) and, only when that
 * changed a row, appends a `disease_auto_publish_set` audit row
 * (`targetEntityType: "center"`, `targetEntityId` the code, before/after
 * `{ diseaseAutoPublish }`), with `actorCwid` the real accountable human, never
 * the impersonated cwid. Zero rows changed means the value was already
 * `enabled`: a no-op (`changed: false`, no audit row). The no-op decision and
 * the audit before-value never come from `db.read`: the prod reader is a
 * lagging replica, so an off-then-on flip inside the lag would read the stale
 * value, skip the write and leave the switch off while the UI shows it on.
 * `db.read` is used only for the existence, taxonomy and authz gates.
 *
 * When `CENTER_DISEASE_FACET` is on, a real change runs `reflectUnitChange`
 * for the center: the public center page's facet + card row read the switch
 * (via the publish predicate) through the ISR page and the `center:` swr
 * roster cache. Flag off ⇒ nothing public reads it, so no reflection.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { isCenterDiseaseFacetEnabled } from "@/lib/center-disease-flags";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canEditUnit,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectUnitChange } from "@/lib/edit/revalidation";

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
    select: { code: true, slug: true },
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

  let changed: boolean;
  try {
    changed = await db.write.$transaction(async (tx) => {
      const { count } = await tx.center.updateMany({
        where: { code: center.code, diseaseAutoPublish: !enabled },
        data: { diseaseAutoPublish: enabled },
      });
      if (count === 0) return false;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center",
        targetEntityId: center.code,
        action: "disease_auto_publish_set",
        fieldsChanged: ["diseaseAutoPublish"],
        beforeValues: { diseaseAutoPublish: !enabled },
        afterValues: { diseaseAutoPublish: enabled },
        ts: new Date(),
        requestId,
      });
      return true;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  if (changed && isCenterDiseaseFacetEnabled()) {
    await reflectUnitChange({ unitKind: "center", unitSlug: center.slug });
  }
  return editOk({ code: center.code, enabled, changed });
}
