/**
 * POST /api/edit/suppress — insert one `suppression` row (#356,
 * `self-edit-spec.md` § `/api/edit/*`, § Suppression UX and behavior).
 *
 * Body: `{ entityType: "scholar" | "publication", entityId, contributorCwid?, reason }`.
 * A scholar suppression also projects `Scholar.status = 'suppressed'`. The
 * suppression row, the status projection, and the B03 audit row commit in one
 * transaction. A duplicate of an already-active suppression is an idempotent
 * no-op (edge case 19).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeSuppress, logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfileSlugs } from "@/lib/edit/revalidation";
import { publicationAuthorshipExists } from "@/lib/edit/validators";

const PATH = "/api/edit/suppress";

/** Default `reason` for a self-action that left it blank (`self-edit-spec.md`). */
const SELF_SUPPRESS_REASON = "Self-suppressed via /edit";
const SELF_HIDE_REASON = "Hidden by the author via /edit";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, body, requestId } = req.ctx;

  // --- body shape ---
  const { entityType, entityId, contributorCwid, reason } = body;
  if (entityType !== "scholar" && entityType !== "publication") {
    // grant / education / appointment suppression is blocked on #352.
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  let contributor: string | null = null;
  if (contributorCwid !== undefined && contributorCwid !== null) {
    if (typeof contributorCwid !== "string" || contributorCwid.length === 0) {
      return editError(400, "invalid_contributor", "contributorCwid");
    }
    contributor = contributorCwid;
  }
  if (entityType === "scholar" && contributor !== null) {
    // A scholar suppression is always whole-entity — it carries no contributor.
    return editError(400, "invalid_contributor", "contributorCwid");
  }

  // --- authorization (403) ---
  const authz = authorizeSuppress(session, { entityType, entityId, contributorCwid: contributor });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: entityType === "scholar" ? entityId : (contributor ?? entityId),
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // --- per-author publication hide: the authorship must exist (400, edge 18) ---
  if (entityType === "publication" && contributor !== null) {
    const exists = await publicationAuthorshipExists(entityId, contributor, db.read);
    if (!exists) return editError(400, "no_authorship", "contributorCwid");
  }

  // --- reason: optional for a self-action (defaulted), mandatory otherwise ---
  const isSelfScholar = entityType === "scholar" && session.cwid === entityId;
  const isSelfAuthorHide =
    entityType === "publication" && contributor !== null && session.cwid === contributor;
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  let reasonValue: string;
  if (trimmedReason.length > 0) {
    reasonValue = trimmedReason;
  } else if (isSelfScholar) {
    reasonValue = SELF_SUPPRESS_REASON;
  } else if (isSelfAuthorHide) {
    reasonValue = SELF_HIDE_REASON;
  } else {
    // A superuser suppression's reason is mandatory (self-edit-spec.md).
    return editError(400, "reason_required", "reason");
  }

  // --- idempotency (edge 19): an un-revoked matching suppression already exists ---
  const existing = await db.read.suppression.findFirst({
    where: { entityType, entityId, contributorCwid: contributor, revokedAt: null },
    select: { id: true },
  });
  if (existing) return editOk({ suppressionId: existing.id });

  // --- write: suppression + status projection + B03 audit row, one transaction ---
  let suppressionId: string;
  try {
    suppressionId = await db.write.$transaction(async (tx) => {
      const created = await tx.suppression.create({
        data: {
          entityType,
          entityId,
          contributorCwid: contributor,
          reason: reasonValue,
          createdBy: session.cwid,
        },
        select: { id: true },
      });
      if (entityType === "scholar") {
        // Denormalized projection of the suppression table (ADR-005).
        // updateMany — a suppression row may legitimately outlive its target.
        await tx.scholar.updateMany({
          where: { cwid: entityId },
          data: { status: "suppressed" },
        });
      }
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: entityType,
        targetEntityId: entityId,
        action: "suppression_create",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          suppression_id: created.id,
          contributor_cwid: contributor,
          reason: reasonValue,
        },
        ts: new Date(),
        requestId,
      });
      return created.id;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // --- post-commit ---
  if (isSelfScholar) {
    // A scholar hiding their own profile is a care / follow-up signal.
    console.warn(
      JSON.stringify({
        event: "self_suppression",
        scholar_cwid: entityId,
        reason: reasonValue,
        ts: new Date().toISOString(),
        request_id: requestId,
      }),
    );
  }
  const slugs = await resolveAffectedProfileSlugs(entityType, entityId, contributor);
  await reflectVisibilityChange(slugs);

  return editOk({ suppressionId });
}
