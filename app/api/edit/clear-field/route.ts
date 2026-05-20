/**
 * POST /api/edit/clear-field — delete one `field_override` row (#356 Phase 7,
 * `self-edit-spec.md` § The v1 editable-field set — `slug` row, UI-SPEC § Card 3
 * superuser arm "Clear override").
 *
 * Body: `{ entityType: "scholar", entityId, fieldName: "slug" }`. Superuser
 * only. The delete and its B03 audit row commit in one transaction. Idempotent:
 * a clear of a non-existent override returns `200 { cleared: false }`, so the
 * UI can distinguish "already clear" from "just cleared" without a retry path.
 *
 * v1 clears only `slug`. Clearing `overview` is the existing POST /api/edit/field
 * with `""` — the sanitize normalizes a structurally-empty body to `""` and the
 * upsert stores it as the empty effective value. A separate clear endpoint for
 * the slug exists because `validateSlugFormat("")` fails (the pattern requires
 * ≥ 1 char), so the upsert path cannot express "no override" for `slug`.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { isEditableField } from "@/lib/edit/validators";

const PATH = "/api/edit/clear-field";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, body, requestId } = req.ctx;

  // --- body shape ---
  const { entityType, entityId, fieldName } = body;
  if (entityType !== "scholar") {
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  if (typeof fieldName !== "string" || !isEditableField(fieldName)) {
    return editError(400, "invalid_field", "fieldName");
  }
  // v1: only `slug` is clearable via this endpoint. Clearing `overview` runs
  // through the existing field route with `value: ""` (sanitize emits "").
  if (fieldName !== "slug") {
    return editError(400, "unclearable_field", "fieldName");
  }

  // --- authorization (403) — slug overrides are superuser-only (matches
  //     `authorizeFieldEdit` for fieldName='slug' in `lib/edit/authz.ts`). ---
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: entityId,
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }

  // --- write: delete-if-exists + B03 audit row, one transaction ---
  let cleared: boolean;
  try {
    cleared = await db.write.$transaction(async (tx) => {
      const key = {
        entityType_entityId_fieldName: {
          entityType: "scholar" as const,
          entityId,
          fieldName: "slug" as const,
        },
      };
      const existing = await tx.fieldOverride.findUnique({
        where: key,
        select: { value: true },
      });
      // Idempotent: no row → return 200 with cleared:false. No audit row is
      // emitted for a no-op clear; an audit row records a state change.
      if (!existing) return false;
      await tx.fieldOverride.delete({ where: key });
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: "scholar",
        targetEntityId: entityId,
        action: "field_override_clear",
        fieldsChanged: [fieldName],
        beforeValues: { [fieldName]: existing.value },
        afterValues: { [fieldName]: null },
        ts: new Date(),
        requestId,
      });
      return true;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // Post-commit reflection: a slug override changes nothing in the read path
  // until etl/ed consumes the next directory sync, so there is nothing to
  // revalidate at write time (matches `POST /api/edit/field` for `slug`).

  return editOk({ fieldName, cleared });
}
