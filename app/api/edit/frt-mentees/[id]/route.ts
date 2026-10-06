/**
 * POST /api/edit/frt-mentees/[id] — act on one Faculty Review Tool mentee row
 * from /edit "Mentees › Suggested mentees".
 *
 * Body: `{ op: "dismiss" }`, `{ op: "restore" }`, or
 * `{ op: "assign", cwid: string | null }` (null = "no WCM person"). An assigned
 * CWID is the mentor's call from then on: the weekly import keeps it and it is
 * what report 7 counts the pair under.
 *
 * Same actor rule as the co-author suggestion routes: genuine self or a genuine
 * superuser; anyone else (and View-as) gets 404 so another mentor's row is never
 * confirmed to exist. The flag check sits after authz.
 */
import { type NextRequest, type NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isCwid } from "@/lib/cwid";
import { appendAuditRow, type AuditAction } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isMenteeSuggestionsEnabled } from "@/lib/edit/mentee-suggestions-flag";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/frt-mentees/[id]";

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

  const row = await db.read.frtMentee.findUnique({
    where: { id },
    select: { id: true, mentorCwid: true, menteeCwid: true, dismissedAt: true },
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

  if (!isMenteeSuggestionsEnabled()) return editError(500, "mentee_suggestions_disabled");

  const now = new Date();
  let data: Record<string, unknown>;
  let action: AuditAction;
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  if (body.op === "dismiss" || body.op === "restore") {
    const dismiss = body.op === "dismiss";
    data = dismiss
      ? { dismissedAt: now, dismissedBy: realCwid }
      : { dismissedAt: null, dismissedBy: null };
    action = dismiss ? "frt_mentee_dismiss" : "frt_mentee_restore";
    before = { dismissed: row.dismissedAt !== null };
    after = { dismissed: dismiss };
  } else if (body.op === "assign") {
    const raw = body.cwid;
    const cwid =
      raw === null ? null : typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
    if (cwid === undefined || (cwid !== null && !isCwid(cwid)))
      return editError(400, "invalid_cwid", "cwid");
    if (cwid === row.mentorCwid) return editError(400, "invalid_cwid", "cwid");
    data = { menteeCwid: cwid, cwidAssignedAt: now, cwidAssignedBy: realCwid };
    action = "frt_mentee_assign_cwid";
    before = { menteeCwid: row.menteeCwid };
    after = { menteeCwid: cwid };
  } else {
    return editError(400, "invalid_op", "op");
  }

  try {
    await db.write.$transaction(async (tx) => {
      await tx.frtMentee.update({ where: { id: row.id }, data });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null here
        targetEntityType: "frt_mentee",
        targetEntityId: String(row.id),
        action,
        fieldsChanged: Object.keys(data),
        beforeValues: before,
        afterValues: after,
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
  return editOk({ ...after });
}
