/**
 * POST /api/edit/reporter-profile/[id]/reject — the scholar (or a genuine
 * superuser on their behalf) declines a RePORTER "Is this you?" match
 * (`REPORTER_MATCH_V2`, dormant). Body: `{ "reason": "not_me" | "name_only" |
 * "cant_tell" }`.
 *
 * Effect: flips the `ReporterProfileCandidate` to terminal `rejected` + records
 * the enum reason. No `person_nih_profile` write, no grant materialization. The
 * row is never re-proposed (ETL skips terminal candidates) and feeds matcher QA
 * (a high `not_me` rate flags a precision problem). PURE SIGNAL — never an
 * accusation, no workflow. A B03 audit row records the real human.
 *
 * Authorization (IS-1 parity) + flag-first 404 dark behavior: identical to the
 * confirm route.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isReporterMatchV2Enabled } from "@/lib/edit/reporter-match";
import { isRejectReason } from "@/lib/edit/reporter-profile";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/reporter-profile/[id]/reject";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isReporterMatchV2Enabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return editError(400, "invalid_id", "id");
  }

  const candidate = await db.read.reporterProfileCandidate.findUnique({
    where: { id },
    select: { id: true, cwid: true, status: true, rejectReason: true },
  });
  if (!candidate) return editError(404, "not_found");

  const isGenuineSelf = impersonatedCwid === null && candidate.cwid === realCwid;
  const isGenuineSuperuser = impersonatedCwid === null && session.isSuperuser;
  if (!isGenuineSelf && !isGenuineSuperuser) {
    logEditDenial({ actorCwid: realCwid, targetCwid: candidate.cwid, path: PATH, reason: "not_self" });
    return editError(403, "not_self");
  }

  // --- body shape: a known reason is required (reached only once authorized +
  //     enabled, so an unauthorized/dark caller never probes the contract). ---
  const { reason } = body;
  if (!isRejectReason(reason)) return editError(400, "invalid_reason", "reason");

  // --- state: reject is valid only from `pending`; an already-rejected row is a
  //     no-op (terminal); confirmed/revoked cannot be rejected. ---
  if (candidate.status === "rejected") {
    return editOk({ status: "rejected", reason: candidate.rejectReason, unchanged: true });
  }
  if (candidate.status !== "pending") return editError(409, "invalid_state");

  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.reporterProfileCandidate.update({
        where: { id: candidate.id },
        data: { status: "rejected", rejectReason: reason, reviewedBy: realCwid, reviewedAt: now },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "reporter_profile_candidate",
        targetEntityId: candidate.id,
        action: "reporter_profile_reject",
        fieldsChanged: ["status", "rejectReason"],
        beforeValues: { status: candidate.status, rejectReason: candidate.rejectReason },
        afterValues: { status: "rejected", rejectReason: reason },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status: "rejected", reason });
}
