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
import { authorizeFieldEdit, logEditDenial } from "@/lib/edit/authz";
import { isManualHighlightsEnabled } from "@/lib/edit/manual-highlights";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit, resolveAffectedProfiles } from "@/lib/edit/revalidation";
import { isEditableField } from "@/lib/edit/validators";
import { deriveSlug, nextAvailableSlug, reconcileScholarSlug } from "@/lib/slug";

const PATH = "/api/edit/clear-field";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

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
  // #836 — `selectedHighlightPmids` is clearable here (the opt-out path: the
  // scholar reverts to AI-selected Highlights). Self-only and flag-gated. It is
  // a plain delete — no slug reconciliation — so it takes a dedicated handler.
  if (fieldName === "selectedHighlightPmids") {
    return clearSelectedHighlights({
      session,
      realCwid,
      impersonatedCwid,
      requestId,
      entityId,
    });
  }
  // Only `slug` is clearable via the slug arm below. Clearing `overview` runs
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

      // #497 §5.1 (clear arm) — clearing the pin returns the scholar to the
      // name-derived slug *immediately*, not on the next ETL run. Re-derive from
      // the current preferredName and find the numeric/reserved floor against
      // every other live scholar's slug; reconcileScholarSlug writes the old
      // pinned slug to slug_history (so its URL 301s) and sets Scholar.slug.
      // No-op when the derived slug already equals the current one (the pin
      // matched the derived value). Reserved-word avoidance rides nextAvailableSlug.
      const scholar = await tx.scholar.findUnique({
        where: { cwid: entityId },
        select: { preferredName: true },
      });
      if (scholar) {
        const taken = new Set(
          (
            await tx.scholar.findMany({
              where: { cwid: { not: entityId } },
              select: { slug: true },
            })
          ).map((s) => s.slug),
        );
        const derived = nextAvailableSlug(
          deriveSlug(scholar.preferredName) || entityId.toLowerCase(),
          taken,
        );
        await reconcileScholarSlug(tx, entityId, derived);
      }

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
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

/**
 * #836 — clear a `selectedHighlightPmids` override (the opt-out: the scholar
 * reverts from manually-chosen Highlights to the AI selection). Self-only and
 * gated by `SELF_EDIT_MANUAL_HIGHLIGHTS` (with the flag off the field is treated
 * as not-editable, mirroring the field route). Delete-if-exists + a B03
 * field_override_clear audit row in one transaction, then revalidate the public
 * profile so the Highlights section re-renders from the AI ranking. Idempotent:
 * a clear with no override returns `200 { cleared: false }`.
 */
async function clearSelectedHighlights(params: {
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean };
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  entityId: string;
}): Promise<NextResponse> {
  const { session, realCwid, impersonatedCwid, requestId, entityId } = params;

  if (!isManualHighlightsEnabled()) {
    return editError(400, "invalid_field", "fieldName");
  }

  const authz = authorizeFieldEdit(session, {
    entityId,
    fieldName: "selectedHighlightPmids",
  });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: entityId,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  let cleared: boolean;
  try {
    cleared = await db.write.$transaction(async (tx) => {
      const key = {
        entityType_entityId_fieldName: {
          entityType: "scholar" as const,
          entityId,
          fieldName: "selectedHighlightPmids" as const,
        },
      };
      const existing = await tx.fieldOverride.findUnique({
        where: key,
        select: { value: true },
      });
      // Idempotent: no row → 200 cleared:false, no audit row for a no-op.
      if (!existing) return false;
      await tx.fieldOverride.delete({ where: key });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: entityId,
        action: "field_override_clear",
        fieldsChanged: ["selectedHighlightPmids"],
        beforeValues: { selectedHighlightPmids: existing.value },
        afterValues: { selectedHighlightPmids: null },
        ts: new Date(),
        requestId,
      });
      return true;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // The Highlights surface lives on the public profile, so a clear must
  // revalidate it (unlike the slug clear, which only flips on the next etl/ed).
  if (cleared) {
    const [profile] = await resolveAffectedProfiles("scholar", entityId, null);
    if (profile) reflectOverviewEdit(profile.slug);
  }

  return editOk({ fieldName: "selectedHighlightPmids", cleared });
}
