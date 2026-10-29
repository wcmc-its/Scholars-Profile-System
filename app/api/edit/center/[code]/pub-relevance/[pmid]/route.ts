/**
 * PATCH /api/edit/center/[code]/pub-relevance/[pmid]
 *
 * A reviewer confirms or flips one publication's cancer relevance, or edits
 * its note, on report 17 (`center_publication_relevance`). `[code]` is the raw
 * `Center.code`.
 *
 * Body (at least one):
 *   relevant: boolean — confirm (the same value) or flip it.
 *   reason: string (trimmed, at most PUB_RELEVANCE_REASON_MAX chars) or null;
 *     blank clears it.
 *
 * Either one makes the row `source: "human"` (Confirmed) and stamps
 * `reviewedBy` / `reviewedAt`; `etl/center-pub-relevance` never overwrites a
 * human row. A publication the ETL has not decided yet has no row, and 404s.
 *
 * Authz + audit posture mirror the NCI 2A override route: Curator/Owner of the
 * center, or Superuser/comms_steward, checked before the body; one transaction
 * with a `pub_relevance_review` audit row.
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
import { PUB_RELEVANCE_REASON_MAX } from "@/lib/edit/pub-relevance-report";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/pub-relevance/[pmid]";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ code: string; pmid: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { code, pmid } = await params;
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
      targetCwid: pmid,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return editError(403, authz.reason);
  }

  const wantsRelevant = "relevant" in body;
  const wantsReason = "reason" in body;
  if (!wantsRelevant && !wantsReason) return editError(400, "invalid_value", "relevant|reason");
  if (wantsRelevant && typeof body.relevant !== "boolean")
    return editError(400, "invalid_value", "relevant");
  let reason: string | null = null;
  if (wantsReason) {
    const v = body.reason;
    if (v !== null && typeof v !== "string") return editError(400, "invalid_value", "reason");
    reason = v?.trim() || null;
    if (reason && reason.length > PUB_RELEVANCE_REASON_MAX)
      return editError(400, "invalid_value", "reason");
  }

  const where = { centerCode_pmid: { centerCode: center.code, pmid } };
  const existing = await db.read.centerPublicationRelevance.findUnique({
    where,
    select: { relevant: true, reason: true, source: true },
  });
  if (!existing) return editError(404, "not_found", "pmid");

  const after = {
    relevant: wantsRelevant ? (body.relevant as boolean) : existing.relevant,
    reason: wantsReason ? reason : existing.reason,
    source: "human",
  };
  const fieldsChanged = [
    ...(wantsRelevant ? ["relevant"] : []),
    ...(wantsReason ? ["reason"] : []),
  ];

  try {
    await db.write.$transaction(async (tx) => {
      await tx.centerPublicationRelevance.update({
        where,
        data: { ...after, reviewedBy: realCwid, reviewedAt: new Date() },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center_publication_relevance",
        targetEntityId: `${center.code}:${pmid}`,
        action: "pub_relevance_review",
        fieldsChanged,
        beforeValues: existing,
        afterValues: after,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ pmid, relevant: after.relevant, reason: after.reason, source: after.source });
}
