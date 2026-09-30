/**
 * POST /api/edit/mentee-suggestions/[id]/restore — undoes a "Not a mentee"
 * dismissal (#2634, `SELF_EDIT_MENTEE_SUGGESTIONS`), returning the suggestion
 * to the mentor's active list. No body.
 *
 * Same contract as the dismiss route: genuine self OR a genuine superuser, any
 * other actor 404s (never confirms another mentor's row exists), dormant flag
 * ⇒ 503 after authz. Nulls `dismissedAt` / `dismissedBy` / `dismissReason` and
 * writes a B03 `mentee_suggestion_restore` audit row, one transaction. An
 * already-active row returns ok without a write.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isMenteeSuggestionsEnabled } from "@/lib/edit/mentee-suggestions-flag";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/mentee-suggestions/[id]/restore";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId } = req.ctx;

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

  if (row.dismissedAt === null) return editOk({ status: "active", alreadyActive: true });

  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.menteeSuggestion.update({
        where: { id: row.id },
        data: { dismissedAt: null, dismissedBy: null, dismissReason: null },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null — both allowed paths require no impersonation
        targetEntityType: "mentee_suggestion",
        targetEntityId: `${row.mentorCwid}:${row.menteeCwid}`,
        action: "mentee_suggestion_restore",
        fieldsChanged: ["dismissedAt", "dismissedBy", "dismissReason"],
        beforeValues: { reason: row.dismissReason },
        afterValues: { reason: null },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status: "active" });
}
