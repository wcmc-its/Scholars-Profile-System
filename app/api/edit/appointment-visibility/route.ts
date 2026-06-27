/**
 * POST /api/edit/appointment-visibility — reveal (or re-hide) one historical
 * appointment on the public profile (#1323).
 *
 * Body: `{ appointmentExternalId: string, showOnProfile: boolean }`.
 *
 * Historical appointments are imported from the WOOFA faculty SOR's
 * `faculty:expired` records with `source = "ED-HISTORICAL"` and
 * `showOnProfile = false`; they are hidden from the public profile until a
 * curator or comms_steward reveals one. Only historical rows are toggleable —
 * an active appointment (`source` "ED" / "ED-NYP" / "JENZABAR-GSFACULTY") is
 * always shown and is refused here (409). The CV export ignores this flag
 * entirely (historical appointments are always exported).
 *
 * Authorization mirrors the suppress route's two-layer shape: the global base
 * gate (`authorizeAppointmentVisibility` — comms_steward / superuser), with the
 * UNIT-scoped curator path (`resolveEditableUnitViaUnitAdmin`) layered on top,
 * keyed on the REAL cwid and never while impersonating (IS-1). The update and
 * the B03 audit row commit in one transaction; the profile page is reflected
 * post-commit.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeAppointmentVisibility, logEditDenial } from "@/lib/edit/authz";
import {
  resolveEditableUnitViaUnitAdmin,
  type EditableUnit,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

const PATH = "/api/edit/appointment-visibility";

/** The source tag of an import-derived historical appointment (#1323). */
const HISTORICAL_SOURCE = "ED-HISTORICAL";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- body shape ---
  const { appointmentExternalId, showOnProfile } = body;
  if (typeof appointmentExternalId !== "string" || appointmentExternalId.length === 0) {
    return editError(400, "invalid_appointment_id", "appointmentExternalId");
  }
  if (typeof showOnProfile !== "boolean") {
    return editError(400, "invalid_show_on_profile", "showOnProfile");
  }

  // --- load the appointment (404 existence gate) — the owning scholar, source,
  //     and title come from the same read. ---
  const appointment = await db.read.appointment.findUnique({
    where: { externalId: appointmentExternalId },
    select: { cwid: true, source: true, title: true },
  });
  if (!appointment) return editError(404, "appointment_not_found", "appointmentExternalId");

  // Only a historical row is toggleable — an active appointment is always shown,
  // so refuse to touch its visibility (409, like the suppress route's chair
  // refusal).
  if (appointment.source !== HISTORICAL_SOURCE) {
    return editError(409, "not_historical", "appointmentExternalId");
  }

  // --- authorization (403): base = comms_steward / superuser, then the
  //     unit-admin curator path layered on top (Amendment 4, mirroring the
  //     suppress route). The curator path is keyed on the REAL cwid and never
  //     while impersonating (IS-1); the conferring unit is audited. ---
  let authz = authorizeAppointmentVisibility(session);
  let viaUnitAdminUnit: EditableUnit | null = null;
  if (!authz.ok && impersonatedCwid === null) {
    const unit = await resolveEditableUnitViaUnitAdmin(
      realCwid,
      appointment.cwid,
      db.read as unknown as UnitScholarLookup,
    );
    if (unit) {
      authz = { ok: true };
      viaUnitAdminUnit = unit;
    }
  }
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: appointment.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // --- write: the visibility flag + the B03 audit row, one transaction ---
  try {
    await db.write.$transaction(async (tx) => {
      await tx.appointment.update({
        where: { externalId: appointmentExternalId },
        data: { showOnProfile },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "appointment",
        targetEntityId: appointmentExternalId,
        action: "appointment_visibility_set",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          show_on_profile: showOnProfile,
          // Amendment 4 — record the unit that conferred a unit-admin reveal
          // (absent for a comms_steward / superuser action).
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

  // --- post-commit: revalidate the owning scholar's profile page + browse hub
  //     (the historical appointment now renders, or stops rendering). ---
  const affected = await resolveAffectedProfiles("appointment", appointmentExternalId, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));

  return editOk({ showOnProfile });
}
