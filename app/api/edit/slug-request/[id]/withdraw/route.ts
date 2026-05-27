/**
 * POST /api/edit/slug-request/[id]/withdraw (#497 PR-3, SPEC § 5.4) — the
 * requester cancels their OWN pending request (`pending → withdrawn`).
 *
 * Self-only: only the scholar who filed the request may withdraw it. A
 * superuser dispositions a request via the decision endpoint (approve/reject),
 * not withdraw. Only a `pending` request is withdrawable. Writes a B03 row; no
 * notification (the requester initiated it).
 *
 * Flag-gated behind `SELF_EDIT_SLUG_REQUEST` (off ⇒ 404).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { isSlugRequestEnabled } from "@/lib/edit/slug-request";

const PATH = "/api/edit/slug-request/[id]/withdraw";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isSlugRequestEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, requestId } = req.ctx;

  const { id } = await params;
  const slugRequest = await db.read.slugRequest.findUnique({
    where: { id },
    select: { id: true, cwid: true, requestedSlug: true, status: true, requestedBy: true },
  });
  if (!slugRequest) return editError(404, "not_found");

  // --- authorization (403): only the requester may withdraw their own request ---
  if (slugRequest.requestedBy !== session.cwid) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: slugRequest.cwid,
      path: PATH,
      reason: "not_self",
    });
    return editError(403, "not_self");
  }

  // --- only a pending request is withdrawable ---
  if (slugRequest.status !== "pending") return editError(409, "not_pending");

  try {
    await db.write.$transaction(async (tx) => {
      await tx.slugRequest.update({
        where: { id },
        data: { status: "withdrawn" },
      });
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: "scholar",
        targetEntityId: slugRequest.cwid,
        action: "slug_request_withdrawn",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: { requested_slug: slugRequest.requestedSlug, request_id: id },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ id, status: "withdrawn" });
}
