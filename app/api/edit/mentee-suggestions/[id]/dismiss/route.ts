/**
 * POST /api/edit/mentee-suggestions/[id]/dismiss — the mentor says "Not a
 * mentee" to a co-authorship-derived suggestion (#2634,
 * `SELF_EDIT_MENTEE_SUGGESTIONS`). Body: `{ reason: DismissReason }`.
 *
 * Mirrors the COI-gap dismiss route. Authorization: genuine self (the row's
 * `mentorCwid` is the REAL signed-in human, no impersonation) OR a genuine
 * (non-impersonating) superuser. Any other actor gets a 404 — the same answer a
 * missing row gets, so the endpoint never confirms that another mentor's
 * suggestion exists. Dormant flag ⇒ 503 after authz, before the body is
 * validated or anything is written.
 *
 * Writes `dismissedAt` / `dismissedBy` / `dismissReason` (columns the nightly
 * ETL never touches) plus a B03 `mentee_suggestion_dismiss` audit row keyed on
 * `{mentorCwid}:{menteeCwid}`, in one transaction.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isMenteeSuggestionsEnabled } from "@/lib/edit/mentee-suggestions-flag";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { DISMISS_REASONS, type DismissReason } from "@/lib/mentee-suggestions/kind";

const PATH = "/api/edit/mentee-suggestions/[id]/dismiss";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return editError(400, "invalid_id", "id");

  const row = await db.read.menteeSuggestion.findUnique({
    where: { id },
    select: {
      id: true,
      mentorCwid: true,
      menteeCwid: true,
      dismissedAt: true,
      dismissReason: true,
    },
  });
  if (!row) return editError(404, "not_found");

  const isGenuineSelf = impersonatedCwid === null && row.mentorCwid === realCwid;
  const isGenuineSuperuser = impersonatedCwid === null && session.isSuperuser;
  if (!isGenuineSelf && !isGenuineSuperuser) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: row.mentorCwid,
      path: PATH,
      reason: "not_self",
    });
    return editError(404, "not_found");
  }

  if (!isMenteeSuggestionsEnabled()) return editError(503, "mentee_suggestions_disabled");

  const reason = body.reason;
  if (!DISMISS_REASONS.includes(reason as DismissReason)) {
    return editError(400, "invalid_reason", "reason");
  }

  if (row.dismissedAt !== null && row.dismissReason === reason) {
    return editOk({ status: "dismissed", alreadyDismissed: true });
  }

  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.menteeSuggestion.update({
        where: { id: row.id },
        data: { dismissedAt: now, dismissedBy: realCwid, dismissReason: reason as DismissReason },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null — both allowed paths require no impersonation
        targetEntityType: "mentee_suggestion",
        targetEntityId: `${row.mentorCwid}:${row.menteeCwid}`,
        action: "mentee_suggestion_dismiss",
        fieldsChanged: ["dismissedAt", "dismissedBy", "dismissReason"],
        beforeValues: { reason: row.dismissReason },
        afterValues: { reason },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status: "dismissed", reason });
}
