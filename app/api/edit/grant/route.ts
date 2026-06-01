/**
 * POST /api/edit/grant — insert / hard-delete one `unit_admin` row.
 * #540 Phase 5b (SPEC § /api/edit/*, § 4 Unit lifecycle and grants).
 *
 * Body: `{ entityType, entityId, cwid, role: "owner" | "curator", action: "grant" | "revoke" }`.
 *
 * Authz follows Amendment 1 § A1.2 — granting requires Owner role on the
 * target unit's subtree (the grant's `role` must also be ≤ the grantor's
 * own role, but at v1 we offer only `owner` and `curator` and an Owner can
 * grant either, so the role check collapses to the predicate
 * `canGrant`). A Superuser grants any role on any unit.
 *
 * Revoke uses the same predicate — by SPEC line 218 ("clearing is gated
 * identically to setting, and revoking identically to granting").
 *
 * The row is inserted on grant and **hard-deleted** on revoke (Amendment 1
 * § A1.3 T5 — `grantedBy` is a historical breadcrumb, never a live
 * dependency). Idempotent: re-granting an existing row updates `grantedBy`
 * + `createdAt`; revoking a non-existent row is a 200 no-op.
 *
 * Each write is one MySQL transaction with a B03 audit row
 * (`action: "grant_change"`). Post-commit reflection: `reflectUnitChange`
 * on the unit page + `/browse`.
 *
 * A grant against a department also cascades to that dept's divisions for
 * the granted role — but the cascade lives in `getEffectiveUnitRole`
 * (read time), not in the `unit_admin` table; this endpoint writes
 * exactly one row.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canGrant,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
  type UnitKind,
  type UnitRef,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectUnitChange } from "@/lib/edit/revalidation";
import {
  CWID_PATTERN,
  findUnit,
  isGrantAction,
  isUnitAdminRole,
} from "@/lib/edit/validators";

const PATH = "/api/edit/grant";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { entityType, entityId, cwid, role, action } = body;

  if (
    entityType !== "department" &&
    entityType !== "division" &&
    entityType !== "center"
  ) {
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  if (typeof cwid !== "string" || !CWID_PATTERN.test(cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }
  if (typeof role !== "string" || !isUnitAdminRole(role)) {
    return editError(400, "invalid_role", "role");
  }
  if (typeof action !== "string" || !isGrantAction(action)) {
    return editError(400, "invalid_action", "action");
  }

  // Footgun guard (Amendment 1 § A1.3 T7): an Owner cannot revoke
  // themselves — the Superuser is the always-available backstop, but a
  // self-revoke makes the revoke surface inaccessible to the actor in
  // the same transaction.
  if (action === "revoke" && cwid === session.cwid && !session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: cwid,
      path: PATH,
      reason: "not_unit_owner",
      targetEntityType: entityType,
      targetEntityId: entityId,
    });
    return editError(403, "cannot_revoke_self");
  }

  // Unit existence — a 400 precedes the 403. Lookup also gives the slug
  // + parent dept slug for post-commit revalidation.
  const unit = await findUnit(entityType, entityId, db.read);
  if (!unit.ok) return editError(400, "unit_not_found", "entityId");

  // Authz: Owner of the target unit (with the dept→division cascade), or
  // Superuser. `canGrant` distinguishes scope_violation vs
  // authority_violation; both render as a 403 with a stable `reason`.
  const unitRef: UnitRef =
    unit.kind === "department"
      ? { kind: "department", code: entityId }
      : unit.kind === "division"
        ? { kind: "division", code: entityId, parentDeptCode: unit.parentDeptCode }
        : { kind: "center", code: entityId };
  const effective = await getEffectiveUnitRole(
    session,
    unitRef,
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canGrant(session, effective, role);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: cwid,
      path: PATH,
      reason: authz.reason,
      targetEntityType: entityType,
      targetEntityId: entityId,
      role,
    });
    return editError(403, authz.reason);
  }

  // Idempotency probe.
  const existing = await db.read.unitAdmin.findUnique({
    where: {
      entityType_entityId_cwid: { entityType, entityId, cwid },
    },
    select: { role: true, grantedBy: true },
  });
  if (action === "revoke" && !existing) {
    return editOk({ entityType, entityId, cwid, action: "revoke", changed: false });
  }

  // Write — insert (upsert) or hard-delete + B03 audit row, one transaction.
  try {
    await db.write.$transaction(async (tx) => {
      if (action === "grant") {
        await tx.unitAdmin.upsert({
          where: {
            entityType_entityId_cwid: { entityType, entityId, cwid },
          },
          create: {
            entityType,
            entityId,
            cwid,
            role,
            grantedBy: session.cwid,
          },
          update: {
            role,
            grantedBy: session.cwid,
          },
        });
      } else {
        await tx.unitAdmin.delete({
          where: {
            entityType_entityId_cwid: { entityType, entityId, cwid },
          },
        });
      }
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: entityType,
        targetEntityId: entityId,
        action: "grant_change",
        fieldsChanged: null,
        beforeValues: existing
          ? { cwid, role: existing.role, granted_by: existing.grantedBy }
          : null,
        afterValues: action === "grant" ? { cwid, role, granted_by: session.cwid } : null,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // Post-commit reflection — the access list is rendered on the unit page
  // (Phase 7); a grant changes who sees the edit affordances.
  const unitKind: UnitKind = unit.kind;
  reflectUnitChange({
    unitKind,
    unitSlug: unit.slug,
    parentDeptSlug:
      unit.kind === "division" ? (unit.parentDeptSlug ?? undefined) : undefined,
  });

  return editOk({ entityType, entityId, cwid, role, action, changed: true });
}
