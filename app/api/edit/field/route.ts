/**
 * POST /api/edit/field — upsert one `field_override` row (#356,
 * `self-edit-spec.md` § `/api/edit/*`).
 *
 * Body: `{ entityType: "scholar", entityId, fieldName: "overview" | "slug", value }`.
 * `overview` is self-only and sanitized server-side; `slug` is superuser-only,
 * format-validated, and collision-checked. The override row and its B03 audit
 * row commit in one transaction.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeFieldEdit, logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit, resolveAffectedProfileSlugs } from "@/lib/edit/revalidation";
import {
  checkSlugCollision,
  isEditableField,
  sanitizeOverview,
  validateSlugFormat,
} from "@/lib/edit/validators";

const PATH = "/api/edit/field";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, body, requestId } = req.ctx;

  // --- body shape ---
  const { entityType, entityId, fieldName, value } = body;
  if (entityType !== "scholar") {
    // v1 `field_override` only ever carries entityType='scholar'.
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  if (typeof fieldName !== "string" || !isEditableField(fieldName)) {
    return editError(400, "invalid_field", "fieldName");
  }
  if (typeof value !== "string") {
    return editError(400, "invalid_value", "value");
  }

  // --- authorization (403) ---
  const authz = authorizeFieldEdit(session, { entityId, fieldName });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: entityId, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  // --- per-field validation (400) ---
  let storedValue: string;
  if (fieldName === "overview") {
    const sanitized = sanitizeOverview(value);
    if (!sanitized.ok) return editError(400, sanitized.error, "value");
    storedValue = sanitized.value;
  } else {
    const format = validateSlugFormat(value);
    if (!format.ok) return editError(400, format.error, "value");
    const collision = await checkSlugCollision(format.value, entityId, db.read);
    if (!collision.ok) return editError(400, collision.error, "value");
    storedValue = format.value;
  }

  // --- write: field_override upsert + B03 audit row, one transaction ---
  try {
    await db.write.$transaction(async (tx) => {
      const key = {
        entityType_entityId_fieldName: {
          entityType: "scholar" as const,
          entityId,
          fieldName,
        },
      };
      const existing = await tx.fieldOverride.findUnique({
        where: key,
        select: { value: true },
      });
      await tx.fieldOverride.upsert({
        where: key,
        create: {
          entityType: "scholar",
          entityId,
          fieldName,
          value: storedValue,
          actorCwid: session.cwid,
        },
        update: { value: storedValue, actorCwid: session.cwid },
      });
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: "scholar",
        targetEntityId: entityId,
        action: "field_override",
        fieldsChanged: [fieldName],
        beforeValues: { [fieldName]: existing?.value ?? null },
        afterValues: { [fieldName]: storedValue },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // --- post-commit reflection (best-effort) ---
  // An overview edit busts the profile page; a slug override changes nothing
  // until etl/ed consumes it, so it reflects nothing at write time.
  if (fieldName === "overview") {
    const [slug] = await resolveAffectedProfileSlugs("scholar", entityId, null);
    if (slug) reflectOverviewEdit(slug);
  }

  return editOk({ fieldName, value: storedValue });
}
