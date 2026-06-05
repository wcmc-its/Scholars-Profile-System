/**
 * POST /api/edit/coi-gap/[id]/dismiss — the scholar disavows ("Not relevant") a
 * publication-derived COI-gap candidate on the self-only "From your
 * publications" panel (`SELF_EDIT_COI_GAP_HINT`, dormant).
 *
 * This is a SELF-ONLY, suggestion-side action — never a verdict, never a
 * compliance event. The only thing it persists is the scholar's own review
 * status (`status='dismissed'`, `reviewedAt=now`); the daily `etl:coi-gap` job
 * respects a dismissal durably and never re-nags. A B03 audit row records the
 * scholar's own action (self-scoped, like `scholars_audit`), not an accusation.
 *
 * Authorization is GENUINE-self, stricter than the rest of `/api/edit/*`: the
 * candidate's `cwid` must equal the REAL signed-in human, AND no impersonation
 * overlay may be live. A superuser, a curator, and a superuser impersonating the
 * scholar via "View as" (#637) are ALL refused 403 — these candidates are an
 * inference more sensitive than either of their inputs and have no authorized
 * viewer but the scholar themselves. (`authorizeSuppress` would let a superuser
 * act on another's behalf; that is exactly what must NOT happen here, so this
 * route does its own genuine-self check instead.)
 *
 * Dormant behind `SELF_EDIT_COI_GAP_HINT` (default off): when off the endpoint
 * 503s after authz, before any write — mirroring the reject route's ordering, so
 * a malformed/unauthorized call still gets the right 400/403/404 while the
 * feature is dark.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isCoiGapHintEnabled } from "@/lib/edit/coi-gap-hint";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/coi-gap/[id]/dismiss";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { realCwid, impersonatedCwid, requestId } = req.ctx;

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return editError(400, "invalid_id", "id");
  }

  // --- load the candidate (404 when absent — do NOT leak whether an id exists
  //     for another scholar; a non-owner gets 403 below, a missing row 404) ---
  const candidate = await db.read.coiGapCandidate.findUnique({
    where: { id },
    select: { id: true, cwid: true, status: true },
  });
  if (!candidate) return editError(404, "not_found");

  // --- authorization (403): GENUINE self only. The candidate must belong to the
  //     REAL signed-in human, and no "View as" overlay may be live. A superuser,
  //     a curator, and an impersonating superuser are all refused — these rows
  //     have no authorized viewer but the scholar themselves. ---
  const isGenuineSelf = impersonatedCwid === null && candidate.cwid === realCwid;
  if (!isGenuineSelf) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: candidate.cwid,
      path: PATH,
      reason: "not_self",
    });
    return editError(403, "not_self");
  }

  // --- dormant unless enabled: 503 after authz, before any write (a dormant
  //     feature does no DB work). Mirrors the reject route's ordering. ---
  if (!isCoiGapHintEnabled()) return editError(503, "coi_gap_disabled");

  // --- idempotency: an already-dismissed candidate returns ok without
  //     re-writing (the daily ETL has already stopped surfacing it). ---
  if (candidate.status === "dismissed") {
    return editOk({ status: "dismissed", alreadyDismissed: true });
  }

  // --- write: status transition + reviewedAt + B03 audit row, one tx ---
  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.coiGapCandidate.update({
        where: { id: candidate.id },
        data: { status: "dismissed", reviewedAt: now },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null here (genuine-self gate above)
        targetEntityType: "coi_gap_candidate",
        targetEntityId: candidate.id,
        action: "coi_gap_dismiss",
        fieldsChanged: ["status"],
        beforeValues: { status: candidate.status },
        afterValues: { status: "dismissed" },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status: "dismissed" });
}
