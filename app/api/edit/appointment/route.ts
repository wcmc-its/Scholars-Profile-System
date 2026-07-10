/**
 * /api/edit/appointment — CRUD for a scholar's SELF-ASSERTED appointments
 * (`profile_appointment`, #1568): internal WCM roles the ED feed omits (Program
 * Director, Head of Section) and current/historical positions at OTHER
 * institutions. A separate store from the ED/Jenzabar-fed `appointment` table;
 * these render ONLY on the owner's own profile, never on a third-party or
 * aggregate surface (the serializers for center / department / division / search
 * never read this table — a structural trust boundary, no per-row guard).
 *
 *   GET  ?cwid=<target>  — list the target scholar's rows (defaults to self).
 *   POST { action, ... } — a single write endpoint (mirrors /api/edit/center-program):
 *       - `create` — `{ cwid, category, title, organization, unit?, location?,
 *                       startDate?, endDate?, sortOrder?, showOnProfile? }`
 *       - `update` — `{ id, <same field set> }` (full replace of the mutable fields)
 *       - `delete` — `{ id }`
 *
 * Authorization rides the SAME `authorizeOverviewWrite` predicate as the bio +
 * section-visibility + historical-appointment reveal (#1554/#1557): self OR
 * superuser OR comms_steward OR granted proxy (#779) OR org-unit owner/curator
 * (#728), keyed on the OWNING scholar. For `create` the owner is the posted
 * `cwid`; for `update` / `delete` it is the existing row's `cwid` (so a scholar
 * can never touch another scholar's row). Each mutation is one transaction with a
 * B03 audit row (its own store → its own `profile_appointment_*` action, never
 * `field_override`). The owner's profile page is reflected post-commit.
 */
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { CWID_PATTERN } from "@/lib/cwid";
import { authorizeOverviewWrite } from "@/lib/edit/overview-authz";
import { type ProxyLookup } from "@/lib/edit/proxy-authz";
import {
  type EditableUnit,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";
import {
  editError,
  editOk,
  logEditFailure,
  readEditRequest,
  resolveEditIdentity,
} from "@/lib/edit/request";
import {
  type ProfileAppointmentInput,
  validateProfileAppointmentInput,
} from "@/lib/edit/profile-appointment";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

const PATH = "/api/edit/appointment";

const WRITE_ACTIONS = ["create", "update", "delete"] as const;
type WriteAction = (typeof WRITE_ACTIONS)[number];
function isWriteAction(value: string): value is WriteAction {
  return (WRITE_ACTIONS as readonly string[]).includes(value);
}

/** A stored row's mutable content — the audit before/after snapshot + list item. */
type StoredRow = {
  id: string;
  cwid: string;
  category: string;
  title: string;
  organization: string;
  unit: string | null;
  location: string | null;
  startDate: Date | null;
  endDate: Date | null;
  sortOrder: number;
  showOnProfile: boolean;
  source: string;
  enteredByCwid: string;
  createdAt: Date;
  updatedAt: Date;
};

/** A `@db.Date` column → `YYYY-MM-DD` (or null); the value is a UTC-midnight Date. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** The wire shape for one appointment (dates as `YYYY-MM-DD`, timestamps as ISO). */
function serialize(row: StoredRow) {
  return {
    id: row.id,
    cwid: row.cwid,
    category: row.category,
    title: row.title,
    organization: row.organization,
    unit: row.unit,
    location: row.location,
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    sortOrder: row.sortOrder,
    showOnProfile: row.showOnProfile,
    source: row.source,
    enteredByCwid: row.enteredByCwid,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The mutable content the audit before/after values capture (no id/timestamps). */
function snapshot(row: StoredRow): Record<string, unknown> {
  return {
    category: row.category,
    title: row.title,
    organization: row.organization,
    unit: row.unit,
    location: row.location,
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    sortOrder: row.sortOrder,
    showOnProfile: row.showOnProfile,
    source: row.source,
  };
}

/** Merge the unit-admin attribution (Amendment 4) into an audit values object. */
function withUnitAttribution(
  values: Record<string, unknown>,
  viaUnitAdminUnit: EditableUnit | null,
): Record<string, unknown> {
  return viaUnitAdminUnit
    ? {
        ...values,
        edited_via: "unit_admin",
        via_unit_type: viaUnitAdminUnit.kind,
        via_unit_code: viaUnitAdminUnit.code,
      }
    : values;
}

// ---------------------------------------------------------------------------
// GET — list the target scholar's self-asserted appointments (editor view: ALL
// rows, hidden included, so the editor can toggle `showOnProfile`).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const id = await resolveEditIdentity();
  if (!id) return new NextResponse(null, { status: 401 });
  const { session, realCwid, impersonatedCwid } = id;

  // Target defaults to self; a present `?cwid` selects a foreign read, authorized
  // by the SAME predicate as the write (no drift).
  const requested = new URL(request.url).searchParams.get("cwid")?.trim();
  const targetCwid = requested && requested.length > 0 ? requested : session.cwid;

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: targetCwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  try {
    const rows = await db.read.profileAppointment.findMany({
      where: { cwid: targetCwid },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return editOk({ appointments: rows.map(serialize) });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}

// ---------------------------------------------------------------------------
// POST — create / update / delete, discriminated by `action`.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { action } = body;
  if (typeof action !== "string" || !isWriteAction(action)) {
    return editError(400, "invalid_action", "action");
  }

  if (action === "create") {
    return handleCreate({ session, realCwid, impersonatedCwid, requestId, body });
  }
  return handleUpdateOrDelete({ session, realCwid, impersonatedCwid, requestId, body, action });
}

async function handleCreate(params: {
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean };
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  body: Record<string, unknown>;
}): Promise<NextResponse> {
  const { session, realCwid, impersonatedCwid, requestId, body } = params;

  // The owning scholar the row is created FOR.
  if (typeof body.cwid !== "string" || !CWID_PATTERN.test(body.cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }
  const targetCwid = body.cwid;

  const parsed = validateProfileAppointmentInput(body);
  if (!parsed.ok) return editError(400, parsed.error, parsed.field);

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: targetCwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({ actorCwid: session.cwid, targetCwid, path: PATH, reason: authz.reason });
    return editError(403, authz.reason);
  }

  // Provenance: SELF when the owner is entering it themselves (self / "View as"
  // overlay — `session.cwid === targetCwid`), else CURATOR (a proxy / unit-admin
  // / comms_steward acting on another's profile). The accountable human is
  // recorded in `enteredByCwid` (= realCwid) and the immutable audit row.
  const source = session.cwid === targetCwid ? "SELF" : "CURATOR";

  let created: StoredRow;
  try {
    created = await db.write.$transaction(async (tx) => {
      const row = await tx.profileAppointment.create({
        data: { ...buildData(parsed.value), cwid: targetCwid, source, enteredByCwid: realCwid },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "profile_appointment",
        targetEntityId: row.id,
        action: "profile_appointment_create",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: withUnitAttribution(snapshot(row), authz.viaUnitAdminUnit),
        ts: new Date(),
        requestId,
      });
      return row;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectOwnerProfile(targetCwid);
  return editOk({ action: "create", appointment: serialize(created) });
}

async function handleUpdateOrDelete(params: {
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean };
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  body: Record<string, unknown>;
  action: "update" | "delete";
}): Promise<NextResponse> {
  const { session, realCwid, impersonatedCwid, requestId, body, action } = params;

  if (typeof body.id !== "string" || body.id.length === 0) {
    return editError(400, "invalid_id", "id");
  }
  const rowId = body.id;

  // Load the existing row — owner (authz key) + the before-snapshot come from it.
  const existing = (await db.read.profileAppointment.findUnique({
    where: { id: rowId },
  })) as StoredRow | null;
  if (!existing) return editError(404, "appointment_not_found", "id");

  // For `update`, validate the new field set BEFORE authz work (a malformed body
  // is a 400 regardless of who is asking).
  let parsed: ProfileAppointmentInput | null = null;
  if (action === "update") {
    const result = validateProfileAppointmentInput(body);
    if (!result.ok) return editError(400, result.error, result.field);
    parsed = result.value;
  }

  const authz = await authorizeOverviewWrite({
    session,
    realCwid,
    impersonatedCwid,
    entityId: existing.cwid,
    proxyDb: db.read as unknown as ProxyLookup,
    unitDb: db.read as unknown as UnitScholarLookup,
  });
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: existing.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  const before = snapshot(existing);

  let updated: StoredRow | null = null;
  try {
    updated = await db.write.$transaction(async (tx) => {
      if (action === "delete") {
        await tx.profileAppointment.delete({ where: { id: rowId } });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "profile_appointment",
          targetEntityId: rowId,
          action: "profile_appointment_delete",
          fieldsChanged: null,
          beforeValues: withUnitAttribution(before, authz.viaUnitAdminUnit),
          afterValues: null,
          ts: new Date(),
          requestId,
        });
        return null;
      }
      // update — replace the mutable fields (source + enteredByCwid are the
      // original entry's provenance and are left untouched).
      const row = await tx.profileAppointment.update({
        where: { id: rowId },
        data: buildData(parsed as ProfileAppointmentInput),
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "profile_appointment",
        targetEntityId: rowId,
        action: "profile_appointment_update",
        fieldsChanged: null,
        beforeValues: before,
        afterValues: withUnitAttribution(snapshot(row), authz.viaUnitAdminUnit),
        ts: new Date(),
        requestId,
      });
      return row;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectOwnerProfile(existing.cwid);
  return action === "delete"
    ? editOk({ action, id: rowId, changed: true })
    : editOk({ action, appointment: serialize(updated as StoredRow) });
}

/** The mutable-field `data` shared by create + update (create additionally
 *  spreads the ownership/provenance columns `cwid` / `source` / `enteredByCwid`). */
function buildData(input: ProfileAppointmentInput) {
  return {
    category: input.category,
    title: input.title,
    organization: input.organization,
    unit: input.unit,
    location: input.location,
    startDate: input.startDate,
    endDate: input.endDate,
    sortOrder: input.sortOrder,
    showOnProfile: input.showOnProfile,
  };
}

/** Reflect the owner's profile page post-commit — the only surface these rows
 *  render on (profile-only by construction). */
async function reflectOwnerProfile(cwid: string): Promise<void> {
  const affected = await resolveAffectedProfiles("scholar", cwid, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));
}
