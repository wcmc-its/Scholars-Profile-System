/**
 * POST /api/edit/coi-gap/[id]/restore — the scholar UNDOES a "Not relevant"
 * dismissal on the self-only "From your publications" panel, bringing the
 * suggestion back to their advisory view (`SELF_EDIT_COI_GAP_HINT`, dormant).
 *
 * This is the exact inverse of the dismiss route and shares its posture: a
 * SELF-ONLY, suggestion-side toggle of the scholar's OWN review status
 * (`status` back to 'new'), never a verdict and never a compliance event. A B03
 * audit row records the scholar's own action, self-scoped like the dismiss.
 *
 * Authorization, identical to dismiss (operator decision, #836 follow-on):
 * genuine self OR a genuine (non-impersonating) superuser. A superuser
 * impersonating the scholar via "View as" (#637) and a non-superuser
 * curator/proxy are refused. Dormant behind `SELF_EDIT_COI_GAP_HINT`: 503 after
 * authz, before any write.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isCoiGapHintEnabled } from "@/lib/edit/coi-gap-hint";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/coi-gap/[id]/restore";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId } = req.ctx;

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return editError(400, "invalid_id", "id");
  }

  const candidate = await db.read.coiGapCandidate.findUnique({
    where: { id },
    select: { id: true, cwid: true, status: true },
  });
  if (!candidate) return editError(404, "not_found");

  // --- authorization (403): genuine self OR a genuine (non-impersonating)
  //     superuser (same contract as dismiss). ---
  const isGenuineSelf = impersonatedCwid === null && candidate.cwid === realCwid;
  const isGenuineSuperuser = impersonatedCwid === null && session.isSuperuser;
  if (!isGenuineSelf && !isGenuineSuperuser) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: candidate.cwid,
      path: PATH,
      reason: "not_self",
    });
    return editError(403, "not_self");
  }

  // --- dormant unless enabled: 503 after authz, before any write. ---
  if (!isCoiGapHintEnabled()) return editError(503, "coi_gap_disabled");

  // --- only a dismissed candidate can be restored; anything else is already
  //     active, so return ok idempotently without a write. ---
  if (candidate.status !== "dismissed") {
    return editOk({ status: candidate.status, alreadyActive: true });
  }

  // --- write: status back to 'new' + B03 audit row, one tx ---
  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.coiGapCandidate.update({
        where: { id: candidate.id },
        data: { status: "new", reviewedAt: now },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null — both allowed paths require no impersonation
        targetEntityType: "coi_gap_candidate",
        targetEntityId: candidate.id,
        action: "coi_gap_restore",
        fieldsChanged: ["status"],
        beforeValues: { status: candidate.status },
        afterValues: { status: "new" },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status: "new" });
}
