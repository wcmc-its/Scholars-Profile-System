/**
 * POST /api/edit/reporter-profile/[id]/revoke — the scholar (or a genuine
 * superuser on their behalf) revokes a previously CONFIRMED RePORTER match,
 * including a system auto-lock (`REPORTER_MATCH_V2`, dormant). Body: `{}`.
 *
 * Effect: flips the `ReporterProfileCandidate` to terminal `revoked` AND deletes
 * the `person_nih_profile` row — so the materialized RePORTER grants are
 * reconciled out on the next `reporter-grants` ETL run (the reconcile step
 * deletes `source='RePORTER'` rows no longer backed by a profile_id; InfoEd rows
 * are never touched). Mirrors core-claim's soft-revoke + the v2 spec §6.3. A B03
 * audit row records the real human.
 *
 * Authorization (IS-1 parity) + flag-first 404 dark behavior: identical to the
 * confirm route.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isReporterMatchV2Enabled } from "@/lib/edit/reporter-match";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/reporter-profile/[id]/revoke";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isReporterMatchV2Enabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId } = req.ctx;

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return editError(400, "invalid_id", "id");
  }

  const candidate = await db.read.reporterProfileCandidate.findUnique({
    where: { id },
    select: { id: true, cwid: true, externalProfileId: true, status: true },
  });
  if (!candidate) return editError(404, "not_found");

  const isGenuineSelf = impersonatedCwid === null && candidate.cwid === realCwid;
  const isGenuineSuperuser = impersonatedCwid === null && session.isSuperuser;
  if (!isGenuineSelf && !isGenuineSuperuser) {
    logEditDenial({ actorCwid: realCwid, targetCwid: candidate.cwid, path: PATH, reason: "not_self" });
    return editError(403, "not_self");
  }

  // --- state: revoke is valid only from `confirmed`; an already-revoked row is
  //     a no-op (terminal); pending/rejected have no person_nih_profile to drop. ---
  if (candidate.status === "revoked") return editOk({ status: "revoked", unchanged: true });
  if (candidate.status !== "confirmed") return editError(409, "invalid_state");

  // --- write: candidate→revoked + delete the person_nih_profile row + audit, one
  //     tx. deleteMany (not delete) is idempotent — no throw if the row is gone. ---
  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.reporterProfileCandidate.update({
        where: { id: candidate.id },
        data: { status: "revoked", reviewedBy: realCwid, reviewedAt: now },
      });
      await tx.personNihProfile.deleteMany({
        where: { cwid: candidate.cwid, nihProfileId: candidate.externalProfileId },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "reporter_profile_candidate",
        targetEntityId: candidate.id,
        action: "reporter_profile_revoke",
        fieldsChanged: ["status"],
        beforeValues: { status: candidate.status, nihProfileId: candidate.externalProfileId },
        afterValues: { status: "revoked" },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status: "revoked" });
}
