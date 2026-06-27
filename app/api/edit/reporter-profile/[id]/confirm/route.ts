/**
 * POST /api/edit/reporter-profile/[id]/confirm — the scholar (or a genuine
 * superuser on their behalf) confirms a RePORTER PMID-overlap "Is this you?"
 * match on the `/edit` panel (`REPORTER_MATCH_V2`, dormant). Body: `{}`.
 *
 * Effect: flips the `ReporterProfileCandidate` to `confirmed` and upserts the
 * `person_nih_profile` row (`resolution_source="pmid-overlap-confirmed"`). The
 * Grant rows appear on the NEXT `reporter-grants` ETL run (the v1 path picks up
 * the new profile_id) — same "updates next nightly" contract as funding search
 * (#481). The card copy states the lag. A B03 audit row records the real human.
 *
 * Authorization (IS-1 parity, identical to the coi-gap routes): genuine self OR
 * a genuine (non-impersonating) superuser. A superuser impersonating via "View
 * as" (#637) is refused — confirming links a real NIH identity to a scholar.
 *
 * Dormant behind `REPORTER_MATCH_V2` (default off): a flag-first 404 (CV pattern,
 * `lib/edit/cv-export.ts`) — the route is fully dark when the feature is off.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isReporterMatchV2Enabled } from "@/lib/edit/reporter-match";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/reporter-profile/[id]/confirm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Flag-first: a dormant feature is fully dark (no auth probe, no body read).
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

  // --- authorization (403): genuine self OR a genuine (non-impersonating)
  //     superuser. A "View as" overlay never confers it (IS-1). ---
  const isGenuineSelf = impersonatedCwid === null && candidate.cwid === realCwid;
  const isGenuineSuperuser = impersonatedCwid === null && session.isSuperuser;
  if (!isGenuineSelf && !isGenuineSuperuser) {
    logEditDenial({ actorCwid: realCwid, targetCwid: candidate.cwid, path: PATH, reason: "not_self" });
    return editError(403, "not_self");
  }

  // --- state: confirm is valid only from `pending`; already-confirmed is a
  //     no-op; a terminal `rejected`/`revoked` row is never re-confirmed. ---
  if (candidate.status === "confirmed") return editOk({ status: "confirmed", unchanged: true });
  if (candidate.status !== "pending") return editError(409, "invalid_state");

  // --- write: candidate→confirmed + person_nih_profile upsert + audit, one tx ---
  const now = new Date();
  try {
    await db.write.$transaction(async (tx) => {
      await tx.reporterProfileCandidate.update({
        where: { id: candidate.id },
        data: { status: "confirmed", reviewedBy: realCwid, reviewedAt: now },
      });
      await tx.personNihProfile.upsert({
        where: { cwid_nihProfileId: { cwid: candidate.cwid, nihProfileId: candidate.externalProfileId } },
        create: {
          cwid: candidate.cwid,
          nihProfileId: candidate.externalProfileId,
          source: "RePORTER",
          resolutionSource: "pmid-overlap-confirmed",
          lastVerified: now,
        },
        update: { resolutionSource: "pmid-overlap-confirmed", lastVerified: now },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null — both allowed paths require no impersonation
        targetEntityType: "reporter_profile_candidate",
        targetEntityId: candidate.id,
        action: "reporter_profile_confirm",
        fieldsChanged: ["status"],
        beforeValues: { status: candidate.status },
        afterValues: { status: "confirmed", nihProfileId: candidate.externalProfileId },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ status: "confirmed" });
}
