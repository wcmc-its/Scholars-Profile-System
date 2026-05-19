/**
 * POST /api/edit/revoke — soft-revoke one `suppression` row (#356,
 * `self-edit-spec.md` § Revoke).
 *
 * Body: `{ suppressionId }`. Sets `revoked_at` / `revoked_by`; never deletes.
 * Revoking the last un-revoked whole-scholar suppression restores
 * `Scholar.status = 'active'`. The revoke and its B03 audit row commit in one
 * transaction.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeRevoke, logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";
import { reflectSearchSuppression } from "@/lib/edit/search-suppression";

const PATH = "/api/edit/revoke";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, body, requestId } = req.ctx;

  const { suppressionId } = body;
  if (typeof suppressionId !== "string" || suppressionId.length === 0) {
    return editError(400, "invalid_suppression_id", "suppressionId");
  }

  // --- load the target row ---
  const suppression = await db.read.suppression.findUnique({
    where: { id: suppressionId },
    select: {
      id: true,
      entityType: true,
      entityId: true,
      contributorCwid: true,
      createdBy: true,
      revokedAt: true,
    },
  });
  if (!suppression) return editError(404, "not_found");

  // --- authorization (403) — keyed on who created the suppression ---
  const authz = authorizeRevoke(session, { createdBy: suppression.createdBy });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: suppression.entityId,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // --- already revoked: idempotent — the desired state already holds ---
  if (suppression.revokedAt !== null) {
    return editOk({ suppressionId });
  }

  // --- write: revoke + conditional status restore + B03 audit row ---
  try {
    await db.write.$transaction(async (tx) => {
      const revokedAt = new Date();
      await tx.suppression.update({
        where: { id: suppressionId },
        data: { revokedAt, revokedBy: session.cwid },
      });
      if (suppression.entityType === "scholar") {
        // Restore status only when no other un-revoked whole-scholar
        // suppression remains (`self-edit-spec.md` § Revoke, edge case 4). The
        // update above already cleared this row, so it is not counted.
        const remaining = await tx.suppression.count({
          where: {
            entityType: "scholar",
            entityId: suppression.entityId,
            contributorCwid: null,
            revokedAt: null,
          },
        });
        if (remaining === 0) {
          await tx.scholar.updateMany({
            where: { cwid: suppression.entityId },
            data: { status: "active" },
          });
        }
      }
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: suppression.entityType,
        targetEntityId: suppression.entityId,
        action: "suppression_revoke",
        fieldsChanged: null,
        beforeValues: {
          suppression_id: suppression.id,
          contributor_cwid: suppression.contributorCwid,
        },
        afterValues: { revoked_by: session.cwid, revoked_at: revokedAt.toISOString() },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // --- post-commit reflection ---
  const affected = await resolveAffectedProfiles(
    suppression.entityType,
    suppression.entityId,
    suppression.contributorCwid,
  );
  await reflectVisibilityChange(affected.map((a) => a.slug));
  // Phase 4b C6 — OpenSearch fast-path (lib/edit/search-suppression.ts).
  // Best-effort: failures are logged inside the reflector and never thrown.
  // `affectedCwids` shares the same `resolveAffectedProfiles` query as the
  // slug fan-out above (plan §3 tightening C7).
  await reflectSearchSuppression({
    entityType: suppression.entityType,
    entityId: suppression.entityId,
    contributorCwid: suppression.contributorCwid,
    affectedCwids: affected.map((a) => a.cwid),
  });

  return editOk({ suppressionId });
}
