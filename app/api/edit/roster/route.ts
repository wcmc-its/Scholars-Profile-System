/**
 * POST /api/edit/roster — add or remove one membership row.
 * #540 Phase 5b (SPEC § /api/edit/*, § 2 The unit roster).
 *
 * Body: `{ unitType: "center" | "division", unitCode, cwid, action: "add" | "remove" }`.
 *
 * Roster curation follows ETL-ownership: a manually-owned unit has a
 * manually-curated roster; an ETL-managed unit's roster is LDAP's and is
 * not editable here. So:
 *   - `unitType: "center"`        → writes `CenterMembership`.
 *   - `unitType: "division"`      → writes `DivisionMembership`, only when
 *                                   the division is `source = 'manual'`.
 *                                   An LDAP-sourced division (`source =
 *                                   'ED'`) → `400 no_manual_roster`.
 *
 * Authz: Curator/Owner of the unit (with the dept→division cascade), or
 * Superuser. A roster operation that targets a department is rejected
 * `400 invalid_unit_type` — departments are always ETL-managed.
 *
 * Each add/remove is one MySQL transaction with a B03 audit row
 * (`action: "roster_change"`). Idempotent: re-adding an existing member
 * is a 200 no-op; removing a non-member is a 200 no-op. Post-commit
 * reflection: `reflectUnitChange` on the unit page + `/browse`.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canEditUnit,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectUnitChange } from "@/lib/edit/revalidation";
import { CWID_PATTERN, isRosterAction } from "@/lib/edit/validators";

const PATH = "/api/edit/roster";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, body, requestId } = req.ctx;

  const { unitType, unitCode, cwid, action } = body;
  if (unitType !== "center" && unitType !== "division") {
    return editError(400, "invalid_unit_type", "unitType");
  }
  if (typeof unitCode !== "string" || unitCode.length === 0) {
    return editError(400, "invalid_unit_code", "unitCode");
  }
  if (typeof cwid !== "string" || !CWID_PATTERN.test(cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }
  if (typeof action !== "string" || !isRosterAction(action)) {
    return editError(400, "invalid_action", "action");
  }

  // Unit existence + manually-owned check.
  let unitSlug: string;
  let parentDeptSlug: string | undefined;
  let parentDeptCode: string | null = null;
  if (unitType === "center") {
    const center = await db.read.center.findUnique({
      where: { code: unitCode },
      select: { code: true, slug: true },
    });
    if (!center) return editError(400, "unit_not_found", "unitCode");
    unitSlug = center.slug;
  } else {
    const division = await db.read.division.findUnique({
      where: { code: unitCode },
      select: {
        code: true,
        slug: true,
        source: true,
        deptCode: true,
        department: { select: { slug: true } },
      },
    });
    if (!division) return editError(400, "unit_not_found", "unitCode");
    if (division.source !== "manual") {
      // SPEC line 192/edge 14 — LDAP-sourced division has no manual roster.
      return editError(400, "no_manual_roster", "unitType");
    }
    unitSlug = division.slug;
    parentDeptCode = division.deptCode;
    parentDeptSlug = division.department?.slug ?? undefined;
  }

  // Authz: Curator/Owner of the unit (cascade for division), or Superuser.
  const effective = await getEffectiveUnitRole(
    session,
    unitType === "center"
      ? { kind: "center", code: unitCode }
      : { kind: "division", code: unitCode, parentDeptCode },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: cwid,
      path: PATH,
      reason: authz.reason,
      targetEntityType: unitType,
      targetEntityId: unitCode,
    });
    return editError(403, authz.reason);
  }

  // Idempotency probe — the existing-state check that turns a re-add
  // into a 200 no-op.
  const existing = unitType === "center"
    ? await db.read.centerMembership.findUnique({
        where: { centerCode_cwid: { centerCode: unitCode, cwid } },
        select: { cwid: true },
      })
    : await db.read.divisionMembership.findUnique({
        where: { divisionCode_cwid: { divisionCode: unitCode, cwid } },
        select: { cwid: true },
      });

  if (action === "add" && existing) {
    return editOk({ unitCode, cwid, action: "add", changed: false });
  }
  if (action === "remove" && !existing) {
    return editOk({ unitCode, cwid, action: "remove", changed: false });
  }

  // Write — membership insert/delete + B03 audit row, one transaction.
  try {
    await db.write.$transaction(async (tx) => {
      if (action === "add") {
        if (unitType === "center") {
          await tx.centerMembership.create({
            data: { centerCode: unitCode, cwid, source: "manual-ui" },
          });
        } else {
          await tx.divisionMembership.create({
            data: { divisionCode: unitCode, cwid, source: "manual-ui" },
          });
        }
      } else {
        if (unitType === "center") {
          await tx.centerMembership.delete({
            where: { centerCode_cwid: { centerCode: unitCode, cwid } },
          });
        } else {
          await tx.divisionMembership.delete({
            where: { divisionCode_cwid: { divisionCode: unitCode, cwid } },
          });
        }
      }
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: unitType,
        targetEntityId: unitCode,
        action: "roster_change",
        fieldsChanged: null,
        beforeValues: action === "remove" ? { cwid } : null,
        afterValues: action === "add" ? { cwid, source: "manual-ui" } : null,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  reflectUnitChange({
    unitKind: unitType,
    unitSlug,
    parentDeptSlug,
  });

  return editOk({ unitCode, cwid, action, changed: true });
}
