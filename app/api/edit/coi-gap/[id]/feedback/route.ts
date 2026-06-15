/**
 * POST /api/edit/coi-gap/[id]/feedback — the scholar (or a genuine superuser on
 * their behalf) records a 3-way reason on a publication-derived COI-gap
 * suggestion on the self-only "From your publications" panel
 * (`SELF_EDIT_COI_GAP_HINT`, dormant). Replaces the old binary `dismiss`.
 *
 * Body: `{ "reason": "will_disclose" | "historical" | "invalid" }`.
 * PURE SIGNAL — never a verdict, never a compliance event. The only thing it
 * persists is the scholar's own review state: `status` (`acknowledged` for
 * will_disclose, else `dismissed`) + `feedbackReason` + `reviewedAt`. The daily
 * `etl:coi-gap` job respects the resulting state durably and never re-nags; the
 * row drops off the panel (`lib/api/edit-context.ts` surfaces only `status='new'`)
 * but stays in the table for the ETL/reconcile and for suggestion-quality
 * research. A B03 audit row records the scholar's own action (self-scoped), not
 * an accusation.
 *
 * Authorization, identical to the dismiss/restore routes (operator decision,
 * #836 follow-on): genuine self OR a genuine (non-impersonating) superuser. A
 * superuser impersonating via "View as" (#637) and a non-superuser curator/proxy
 * are both refused (IS-1). The UI nags superusers before this action; the audit
 * row records the real admin as the actor.
 *
 * Dormant behind `SELF_EDIT_COI_GAP_HINT` (default off): 503 after authz, before
 * any write — and before the `reason` shape is validated, so a dark feature never
 * reveals its body contract.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { isFeedbackReason, statusForReason } from "@/lib/coi-gap/feedback";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isCoiGapHintEnabled } from "@/lib/edit/coi-gap-hint";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/coi-gap/[id]/feedback";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return editError(400, "invalid_id", "id");
  }

  const candidate = await db.read.coiGapCandidate.findUnique({
    where: { id },
    select: { id: true, cwid: true, status: true, feedbackReason: true },
  });
  if (!candidate) return editError(404, "not_found");

  // --- authorization (403): genuine self OR a genuine (non-impersonating)
  //     superuser. A "View as" overlay never confers it (IS-1). ---
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

  // --- dormant unless enabled: 503 after authz, before any write (and before
  //     the body contract is validated, so a dark feature stays opaque). ---
  if (!isCoiGapHintEnabled()) return editError(503, "coi_gap_disabled");

  // --- body shape: a known reason is required (only reached once authorized +
  //     enabled, so an unauthorized/dark caller never probes the contract). ---
  const { reason } = body;
  if (!isFeedbackReason(reason)) return editError(400, "invalid_reason", "reason");
  const status = statusForReason(reason);

  // --- idempotency: the candidate already holds exactly this feedback → ok
  //     without re-writing. ---
  if (candidate.status === status && candidate.feedbackReason === reason) {
    return editOk({ status, reason, unchanged: true });
  }

  // --- write: status + feedbackReason + reviewedAt + B03 audit row, one tx ---
  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.coiGapCandidate.update({
        where: { id: candidate.id },
        data: { status, feedbackReason: reason, reviewedAt: now },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null — both allowed paths require no impersonation
        targetEntityType: "coi_gap_candidate",
        targetEntityId: candidate.id,
        action: "coi_gap_feedback",
        fieldsChanged: ["status", "feedbackReason"],
        beforeValues: { status: candidate.status, feedbackReason: candidate.feedbackReason },
        afterValues: { status, feedbackReason: reason },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status, reason });
}
