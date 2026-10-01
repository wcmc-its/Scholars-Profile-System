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
import { runAfterResponse } from "@/lib/edit/after-response";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeRevoke, logEditDenial } from "@/lib/edit/authz";
import { isGrantedProxy, type ProxyLookup } from "@/lib/edit/proxy-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";
import { reflectSearchSuppression } from "@/lib/edit/search-suppression";
import { isCwid } from "@/lib/cwid";
import { isRejectReason } from "@/lib/edit/reject-reason";
import { findSuppressibleEntityOwner } from "@/lib/edit/validators";

const PATH = "/api/edit/revoke";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

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
      reason: true,
      revokedAt: true,
    },
  });
  if (!suppression) return editError(404, "not_found");

  // --- authorization (403) — keyed on who created the suppression ---
  // A content editor may also lift a staff hide on one profile; resolve whose
  // profile it is on, and whether that scholar (or their proxy) applied it.
  // Only for a content editor who did not create it — no extra reads otherwise.
  let subject: string | null = null;
  let bySubject = true;
  if (
    session.isContentEditor === true &&
    !session.isSuperuser &&
    !session.isCommsSteward &&
    session.cwid !== suppression.createdBy
  ) {
    subject = await contentEditorRevokeSubject(suppression);
    bySubject =
      subject === null ||
      suppression.createdBy === subject ||
      (await isGrantedProxy(suppression.createdBy, subject, db.read as unknown as ProxyLookup));
  }
  const authz = authorizeRevoke(session, {
    createdBy: suppression.createdBy,
    subject,
    bySubject,
  });
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
        // Reset the #393 reconciler sentinel: a revoke is a new index-relevant
        // transition, so the prior suppress's stamp no longer applies. NULL
        // until the post-commit reflect re-stamps it; if that reflect is lost,
        // the reconciler sees NULL and re-reflects the revoke.
        data: { revokedAt, revokedBy: session.cwid, searchReflectedAt: null },
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
        actorCwid: realCwid,
        impersonatedCwid,
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
  // slug fan-out above (plan §3 tightening C7). Run AFTER the response (#955 #6);
  // the revoked suppression row backstops it via the #393 reconciler.
  runAfterResponse(async () => {
    await reflectSearchSuppression({
      suppressionId: suppression.id,
      entityType: suppression.entityType,
      entityId: suppression.entityId,
      contributorCwid: suppression.contributorCwid,
      affectedCwids: affected.map((a) => a.cwid),
    });
  });

  return editOk({ suppressionId });
}

/**
 * Whose profile a suppression is on, for the content-editor revoke leg — set
 * only for a hide a PERSON applied (its creator is a CWID, so never an ETL hold
 * such as `system-confidential-title` or `system-recency`, which the ETL never
 * re-applies once lifted) that is not a ReCiter "Not mine" reject, and only for
 * the one-profile kinds a content editor may hide (the suppress route's
 * delegated allowlist): a per-author publication hide, or an appointment /
 * education / grant. Null for everything else — a whole scholar, a whole-
 * publication takedown, a mentee, a dataset, a unit, or a row whose owner no
 * longer resolves — so `authorizeRevoke` refuses it.
 */
async function contentEditorRevokeSubject(s: {
  entityType: string;
  entityId: string;
  contributorCwid: string | null;
  createdBy: string;
  reason: string | null;
}): Promise<string | null> {
  if (!isCwid(s.createdBy) || isRejectReason(s.reason)) return null;
  if (s.entityType === "publication") return s.contributorCwid;
  if (s.entityType === "appointment" || s.entityType === "education" || s.entityType === "grant") {
    const owner = await findSuppressibleEntityOwner(s.entityType, s.entityId, db.read);
    return owner?.ownerCwid ?? null;
  }
  return null;
}
