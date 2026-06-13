/**
 * POST /api/edit/field — upsert (or, for unit fields, delete) one
 * `field_override` row.
 *
 * Two write surfaces share this endpoint:
 *
 *  - **Scholar** (#356, `self-edit-spec.md`) — `entityType: "scholar"`, fields
 *    `overview` (self OR superuser — #844 widened the bio to admins; also editable
 *    by a granted proxy / unit admin, sanitized) and `slug` (superuser-only,
 *    format-validated, collision-checked). The override row commits with a B03
 *    audit row in one transaction; a `slug` override also reconciles `Scholar.slug`
 *    in-transaction (#497 §5.1, Option B).
 *
 *  - **Department / Division** (#540 Phase 5, ADR-005 Amendment 1 § A1.1) —
 *    `entityType: "department" | "division"`, fields `description` / `slug` /
 *    `leaderCwid` / `leaderInterim`. Curator or Owner of the unit (cascade
 *    via `getEffectiveUnitRole`) for the curator-editable trio; Superuser
 *    only for `slug` (structural; SPEC § Authorization). An optional
 *    `op: "set" | "clear"` (default `"set"`) toggles between upsert and
 *    delete-if-exists; SPEC § 1 — the three leadership states ("detect", "no
 *    leader", "this person") are expressed as `op:"clear"`, `value:""`, and
 *    `value:<cwid>`. The unit page revalidates post-commit
 *    (`reflectUnitChange`); the URL of a dept/div `slug` flip rides the next
 *    `etl/ed` run (Phase 4).
 *
 *  - **Center** writes are NOT accepted here — centers edit in-row via
 *    `/api/edit/unit op:"update"` (Phase 5b).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow, type AuditAction, type AuditEntityType } from "@/lib/edit/audit";
import {
  authorizeFieldEdit,
  canEditUnit,
  getEffectiveUnitRole,
  logEditDenial,
  type AuthzResult,
  type UnitAdminLookup,
  type UnitKind,
  type UnitRef,
} from "@/lib/edit/authz";
import { computeOverviewOrigin } from "@/lib/edit/overview-provenance";
import { containsProfanity } from "@/lib/edit/profanity";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import {
  type EditableUnit,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import {
  reflectOverviewEdit,
  reflectUnitChange,
  resolveAffectedProfiles,
} from "@/lib/edit/revalidation";
import {
  checkSlugCollision,
  findUnit,
  isEditableField,
  isEditableUnitField,
  sanitizeOverview,
  validateSelectedHighlightPmids,
  validateSlugFormat,
  validateUnitFieldValue,
} from "@/lib/edit/validators";
import { isManualHighlightsEnabled } from "@/lib/edit/manual-highlights";
import { isNameBasedSlug, reconcileScholarSlug } from "@/lib/slug";

const PATH = "/api/edit/field";

type UnitEntityType = "department" | "division";

function isUnitEntityType(value: string): value is UnitEntityType {
  return value === "department" || value === "division";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- body shape (entityType discriminator) ---
  const { entityType, entityId, fieldName, value, op, sourceGenerationId } = body;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  if (typeof fieldName !== "string") {
    return editError(400, "invalid_field", "fieldName");
  }
  // `op` is additive — defaults to "set" when absent. "clear" is supported for
  // unit fields only (SPEC § 1); scholar overview / slug clears use the
  // existing /api/edit/clear-field route (with the slug-reconciliation logic).
  if (op !== undefined && op !== "set" && op !== "clear") {
    return editError(400, "invalid_op", "op");
  }
  const effectiveOp: "set" | "clear" = op === "clear" ? "clear" : "set";

  if (typeof entityType !== "string") {
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (entityType === "scholar") {
    return handleScholarFieldEdit({
      session,
      realCwid,
      impersonatedCwid,
      requestId,
      entityId,
      fieldName,
      value,
      op: effectiveOp,
      // #742 Phase B — provenance pointer for an `overview` save: the generation
      // the saved text derived from (or null/absent for a hand-authored save).
      sourceGenerationId,
    });
  }
  if (isUnitEntityType(entityType)) {
    return handleUnitFieldEdit({
      session,
      realCwid,
      impersonatedCwid,
      requestId,
      entityType,
      entityId,
      fieldName,
      value,
      op: effectiveOp,
    });
  }
  return editError(400, "invalid_entity_type", "entityType");
}

// ---------------------------------------------------------------------------
// scholar — existing self-edit-spec behavior, unchanged contract
// ---------------------------------------------------------------------------

async function handleScholarFieldEdit(params: {
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean };
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  entityId: string;
  fieldName: string;
  value: unknown;
  op: "set" | "clear";
  /** #742 Phase B — the OverviewGeneration the saved overview derived from, when
   *  the save came from a generated draft. Absent/non-string/foreign ⇒ authored. */
  sourceGenerationId: unknown;
}): Promise<NextResponse> {
  const {
    session,
    realCwid,
    impersonatedCwid,
    requestId,
    entityId,
    fieldName,
    value,
    op,
    sourceGenerationId,
  } = params;
  // SPEC § Interfaces — scholar contract is unchanged. `op` is not part of
  // self-edit-spec's /api/edit/field; reject "clear" here to keep the existing
  // semantics (clearing rides /api/edit/clear-field).
  if (op !== "set") return editError(400, "invalid_op", "op");
  if (!isEditableField(fieldName)) {
    return editError(400, "invalid_field", "fieldName");
  }
  // #836 — the manual-Highlights override is gated by SELF_EDIT_MANUAL_HIGHLIGHTS.
  // With the flag off the field is treated as not-editable (the same shape as an
  // unknown field), so the whole surface is dark.
  if (fieldName === "selectedHighlightPmids" && !isManualHighlightsEnabled()) {
    return editError(400, "invalid_field", "fieldName");
  }
  // `selectedHighlightPmids` carries a JSON array value; every other scholar
  // field is a string. The per-field validation below enforces the precise shape.
  if (fieldName !== "selectedHighlightPmids" && typeof value !== "string") {
    return editError(400, "invalid_value", "value");
  }

  // `overview` writes authorize via the shared `authorizeOverviewWrite` — the
  // single source of truth the overview generator also uses (#844 follow-up, "no
  // special rules"): self OR superuser OR granted proxy (#779) OR org-unit
  // owner/curator (#728), keyed on `realCwid` and gated to non-impersonating
  // (IS-1). A unit-admin allow carries the resolved membership unit into the B03
  // audit `afterValues` for attribution. Every other field keeps the pure
  // `authorizeFieldEdit` rule (`selectedHighlightPmids` self-only, `slug`
  // superuser-only).
  let viaUnitAdminUnit: EditableUnit | null = null;
  let authz: AuthzResult;
  if (fieldName === "overview") {
    const ov = await authorizeOverviewWrite({
      session,
      realCwid,
      impersonatedCwid,
      entityId,
      proxyDb: db.read as unknown as ProxyLookup,
      unitDb: db.read as unknown as UnitScholarLookup,
    });
    if (ov.ok) {
      authz = { ok: true };
      viaUnitAdminUnit = ov.viaUnitAdminUnit;
    } else {
      authz = { ok: false, reason: ov.reason };
    }
  } else {
    authz = authorizeFieldEdit(session, { entityId, fieldName });
  }
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: entityId,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  let storedValue: string;
  if (fieldName === "overview") {
    const sanitized = sanitizeOverview(value as string);
    if (!sanitized.ok) return editError(400, sanitized.error, "value");
    storedValue = sanitized.value;
  } else if (fieldName === "selectedHighlightPmids") {
    // #836 — validate shape (JSON array of ≤ MAX numeric PMIDs, no dupes) and
    // store the normalized array as JSON. Membership-in-the-scholar's-pubs is
    // not enforced here (needs a DB read of confirmed authorships); the read
    // path silently drops any stored pmid the scholar is not a confirmed author
    // of (`pickManualHighlights`), and the edit UI only offers the scholar's own
    // publications, so a well-behaved client never sends an out-of-set pmid.
    const result = validateSelectedHighlightPmids(value);
    if (!result.ok) return editError(400, result.error, "value");
    storedValue = JSON.stringify(result.value);
  } else {
    const format = validateSlugFormat(value as string);
    if (!format.ok) return editError(400, format.error, "value");
    // #955 item 4 — apply the same best-effort profanity screen the self-serve
    // slug-request path enforces (`validateRequestedSlug`), so a superuser/owner
    // override can't bypass the gate the request route blocks on. Token-exact,
    // name-safe (`containsProfanity`); block with the matching `profanity` code.
    if (containsProfanity(format.value)) return editError(400, "profanity", "value");
    const collision = await checkSlugCollision(format.value, entityId, db.read);
    if (!collision.ok) return editError(400, collision.error, "value");
    storedValue = format.value;
  }

  // #678 — name-basis is a WARN (not a block) on the superuser override path:
  // superusers have legitimate edge cases (namesake disambiguation, an agreed
  // exception). Set inside the transaction (where the subject row is read on the
  // same surface `reconcileScholarSlug` uses), emitted after commit. The
  // self-serve request path is where name-basis is actually enforced.
  let slugNotNameBased = false;

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
      if (fieldName === "overview") {
        // #742 Phase B — record the provenance of the saved overview in the SAME
        // transaction. A save derived from a generation (`sourceGenerationId`
        // pointing at one of THIS scholar's generations) is "generated" when
        // saved verbatim, else "generated_edited"; a hand-authored save (no/empty
        // pointer) — or a pointer that is foreign or missing — is "authored".
        // The generation lookup is read-only and self-scoped; it never fails the
        // save (a missing generation just downgrades to "authored").
        let origin: "authored" | "generated" | "generated_edited" = "authored";
        let provenanceModel: string | null = null;
        let provenanceSource: string | null = null;
        if (typeof sourceGenerationId === "string" && sourceGenerationId.length > 0) {
          const generation = await tx.overviewGeneration.findUnique({
            where: { id: sourceGenerationId },
            select: { cwid: true, text: true, model: true },
          });
          if (generation && generation.cwid === entityId) {
            origin = computeOverviewOrigin(storedValue, generation.text);
            provenanceModel = generation.model;
            provenanceSource = sourceGenerationId;
          }
        }
        await tx.overviewProvenance.upsert({
          where: { cwid: entityId },
          create: {
            cwid: entityId,
            origin,
            model: provenanceModel,
            sourceGenerationId: provenanceSource,
            updatedByCwid: session.cwid,
          },
          update: {
            origin,
            model: provenanceModel,
            sourceGenerationId: provenanceSource,
            updatedByCwid: session.cwid,
          },
        });
      }
      if (fieldName === "slug") {
        await reconcileScholarSlug(tx, entityId, storedValue);
        const subject = await tx.scholar.findUnique({
          where: { cwid: entityId },
          select: { preferredName: true, fullName: true },
        });
        if (
          subject &&
          !isNameBasedSlug(storedValue, [subject.preferredName, subject.fullName])
        ) {
          slugNotNameBased = true;
        }
      }
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: entityId,
        action: "field_override",
        fieldsChanged: [fieldName],
        beforeValues: { [fieldName]: existing?.value ?? null },
        afterValues: {
          [fieldName]: storedValue,
          // Amendment 4 — when the edit was authorized via a unit-admin role,
          // record which unit conferred it (the actor's cwid alone identifies
          // WHO, not through which unit). Absent for self / proxy edits.
          ...(viaUnitAdminUnit
            ? {
                edited_via: "unit_admin",
                via_unit_type: viaUnitAdminUnit.kind,
                via_unit_code: viaUnitAdminUnit.code,
              }
            : {}),
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  if (slugNotNameBased) {
    console.warn(
      JSON.stringify({
        event: "slug_override_not_name_based",
        path: PATH,
        actor_cwid: session.cwid,
        target_cwid: entityId,
        slug: storedValue,
      }),
    );
  }

  // A changed `overview` or `selectedHighlightPmids` (#836) both alter the public
  // profile page, so revalidate its canonical path. `slug` changes don't flip the
  // URL until the next etl/ed run, so they need no revalidation here.
  if (fieldName === "overview" || fieldName === "selectedHighlightPmids") {
    const [profile] = await resolveAffectedProfiles("scholar", entityId, null);
    if (profile) await reflectOverviewEdit(profile.slug);
  }

  return editOk({ fieldName, value: storedValue });
}

// ---------------------------------------------------------------------------
// dept / division — #540 Phase 5 (ADR-005 Amendment 1 § A1.1)
// ---------------------------------------------------------------------------

async function handleUnitFieldEdit(params: {
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean };
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  entityType: UnitEntityType;
  entityId: string;
  fieldName: string;
  value: unknown;
  op: "set" | "clear";
}): Promise<NextResponse> {
  const {
    session,
    realCwid,
    impersonatedCwid,
    requestId,
    entityType,
    entityId,
    fieldName,
    value,
    op,
  } = params;
  if (!isEditableUnitField(fieldName)) {
    return editError(400, "invalid_field", "fieldName");
  }

  // Unit existence — a 400 precedes the 403 (SPEC § Authorization). Lookup
  // also yields the slug + parent dept slug for post-commit revalidation.
  const unit = await findUnit(entityType, entityId, db.read);
  if (!unit.ok) return editError(400, "unit_not_found", "entityId");

  // Authorization — SPEC § Authorization table. `slug` is structural and
  // Superuser-only; the other three are Curator/Owner-editable via cascade.
  if (fieldName === "slug") {
    if (!session.isSuperuser) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: entityId,
        path: PATH,
        reason: "not_superuser",
        targetEntityType: entityType,
        targetEntityId: entityId,
      });
      return editError(403, "not_superuser");
    }
  } else {
    const unitRef: UnitRef =
      entityType === "department"
        ? { kind: "department", code: entityId }
        : {
            kind: "division",
            code: entityId,
            parentDeptCode: unit.kind === "division" ? unit.parentDeptCode : null,
          };
    // db.read satisfies UnitAdminLookup structurally; cast widens the unit_admin
    // EntityType enum (which the Prisma client types as the full ENUM) to the
    // unit-only subset the lookup actually queries.
    const effective = await getEffectiveUnitRole(
      session,
      unitRef,
      db.read as unknown as UnitAdminLookup,
    );
    const authz = canEditUnit(session, effective);
    if (!authz.ok) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: entityId,
        path: PATH,
        reason: authz.reason,
        targetEntityType: entityType,
        targetEntityId: entityId,
      });
      return editError(403, authz.reason);
    }
  }

  // For op:"clear" the value is irrelevant; for op:"set" it must validate
  // per the field-level rule.
  let storedValue = "";
  if (op === "set") {
    if (typeof value !== "string") {
      return editError(400, "invalid_value", "value");
    }
    const result = validateUnitFieldValue(fieldName, value);
    if (!result.ok) return editError(400, result.error, "value");
    storedValue = result.value;
    // Slug collision check — the @unique guard at the DB level is the atomic
    // backstop; the friendly check is the ETL's collision-suffix pipeline at
    // run time. For dept/div the URL flips on the next `etl/ed`, so the only
    // immediate cross-unit collision we can reject here is a duplicate
    // override row writing the same slug to two distinct codes. Defer that
    // belt-and-suspenders to Phase 5b's unit-create path where slug formatting
    // first lands; Phase 5a relies on the @unique constraint.
  }

  // Write — `field_override` upsert/delete + B03 audit row, one transaction.
  const targetAuditType: AuditEntityType =
    entityType === "department" ? "department" : "division";
  try {
    await db.write.$transaction(async (tx) => {
      const key = {
        entityType_entityId_fieldName: {
          entityType,
          entityId,
          fieldName,
        },
      };
      const existing = await tx.fieldOverride.findUnique({
        where: key,
        select: { value: true },
      });
      let action: AuditAction;
      let after: Record<string, unknown> | null;
      if (op === "set") {
        await tx.fieldOverride.upsert({
          where: key,
          create: {
            entityType,
            entityId,
            fieldName,
            value: storedValue,
            actorCwid: session.cwid,
          },
          update: { value: storedValue, actorCwid: session.cwid },
        });
        action = "field_override";
        after = { [fieldName]: storedValue };
      } else {
        if (!existing) {
          // No row → no-op. Skip the audit row (no state change). The route
          // still returns 200; the UI treats it as a successful clear.
          return;
        }
        await tx.fieldOverride.delete({ where: key });
        action = "field_override_clear";
        after = null;
      }
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: targetAuditType,
        targetEntityId: entityId,
        action,
        fieldsChanged: [fieldName],
        beforeValues: { [fieldName]: existing?.value ?? null },
        afterValues: after,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // Post-commit reflection — unit page + browse. Skip for `slug`: the URL
  // does not flip until the next `etl/ed` run.
  if (fieldName !== "slug") {
    const unitKind: UnitKind = entityType;
    await reflectUnitChange({
      unitKind,
      unitSlug: unit.slug,
      parentDeptSlug:
        unit.kind === "division" ? (unit.parentDeptSlug ?? undefined) : undefined,
    });
  }

  return editOk({ fieldName, op, value: op === "set" ? storedValue : null });
}
