/**
 * POST /api/edit/roster — add, remove, or set one membership row.
 * #540 Phase 5b (base add/remove) + #552 Phase 2 (the `set` action + the four
 * extended CenterMembership fields).
 *
 * Body: `{ unitType: "center" | "division", unitCode, cwid, action, ... }`.
 *
 * Roster curation follows ETL-ownership: a manually-owned unit has a
 * manually-curated roster; an ETL-managed unit's roster is LDAP's and is not
 * editable here.
 *   - `unitType: "center"`   → writes `CenterMembership`.
 *   - `unitType: "division"` → writes `DivisionMembership`, only when the
 *     division is `source = 'manual'`. An LDAP-sourced division → `400`.
 *
 * Actions:
 *   - `add`    — insert (no-op if the row exists). Center rows may carry the
 *                four extended fields; absent → null.
 *   - `remove` — delete (no-op if absent).
 *   - `set`    — upsert (#552). Partial bodies allowed; a field present as
 *                `null` clears it, an absent field is left unchanged.
 *
 * Extended fields (`membershipType` / `programCode` / `startDate` / `endDate`)
 * are **center-only** — `DivisionMembership` has no columns for them, so the
 * route rejects any of them on a division (400 `roster_field_center_only`).
 * `programCode` must reference a `CenterProgram` row for the center; a center
 * with no program taxonomy rejects a non-null `programCode` (400 `no_taxonomy`).
 * `endDate` must be `>= startDate` when both are set (400 `invalid_date_range`).
 *
 * Each mutation is one MySQL transaction with a B03 audit row
 * (`action: "roster_change"`); `before`/`after` carry the full row snapshot
 * (`{ cwid, membershipType, programCode, startDate, endDate }`) so consumers can
 * diff. Post-commit: `reflectUnitChange` on the unit page + `/browse`.
 *
 * #2519 PR 1 (`docs/2026-08-26-cornell-ithaca-membership-SPEC.md` §5) — the
 * `add` action additionally accepts `source:"cornell"` + a `netid`, behind the
 * `CORNELL_DIRECTORY_MEMBERS` flag. A completely separate identifier path from
 * the WCM `cwid` flow above (`handleCornellAdd`): the server re-fetches the
 * person by netid from the Cornell client (never trusts client-supplied
 * display data), resolves the disjoint-union bridge, and either inserts a
 * normal WCM membership row or upserts `ExternalMember` + inserts a
 * `source: "cornell-ithaca"` membership row. Reuses the SAME `roster_change`
 * `AuditAction` / `center`|`division` `AuditEntityType` as the WCM path above
 * — no new audit enum value (the `scripts/sql/audit-log.sql` trap in CLAUDE.md).
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  CENTER_ENTITY_TYPE,
  MEMBER_ROLE_KEY,
  deriveMembershipType,
  orgUnitRoleSeedRows,
} from "@/lib/org-unit-roles";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canEditUnit,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { isCornellDirectoryMembersEnabled } from "@/lib/edit/cornell-directory-flag";
import { resolveCornellRosterAdd } from "@/lib/edit/cornell-roster";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectUnitChange } from "@/lib/edit/revalidation";
import {
  CWID_PATTERN,
  isCenterMembershipType,
  isRosterAction,
  isValidDateRange,
  validateRosterDate,
} from "@/lib/edit/validators";
import type { EditSession } from "@/lib/auth/superuser";
import { fetchCornellPersonByNetid } from "@/lib/sources/cornell-ldap";

const PATH = "/api/edit/roster";

/** The extended CenterMembership fields, with per-field "present in body" flags. */
type ExtendedFields = {
  membershipType: { present: boolean; value: "research" | "clinical" | null };
  programCode: { present: boolean; value: string | null };
  startDate: { present: boolean; value: Date | null };
  endDate: { present: boolean; value: Date | null };
};

/** The columns `snapshot` projects. Kept as one constant so the three `select:`
 *  blocks below cannot drift from it — a column present on the model but absent
 *  here is silently missing from every audit `before`/`after` (#2542). */
const SNAPSHOT_SELECT = {
  cwid: true,
  membershipType: true,
  membershipRoleKey: true,
  programCode: true,
  startDate: true,
  endDate: true,
} as const;

/** Snapshot a CenterMembership row for the audit `before`/`after` (#552 §5). */
function snapshot(row: {
  cwid: string;
  membershipType: string | null;
  membershipRoleKey: string | null;
  programCode: string | null;
  startDate: Date | null;
  endDate: Date | null;
}): Record<string, unknown> {
  return {
    cwid: row.cwid,
    membershipType: row.membershipType,
    membershipRoleKey: row.membershipRoleKey,
    programCode: row.programCode,
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { unitType, unitCode, cwid, action } = body;
  if (unitType !== "center" && unitType !== "division") {
    return editError(400, "invalid_unit_type", "unitType");
  }
  if (typeof unitCode !== "string" || unitCode.length === 0) {
    return editError(400, "invalid_unit_code", "unitCode");
  }

  // #2519 — Cornell (Ithaca) external-member add. A distinct identifier path:
  // the client supplies a `netid`, never a `cwid` (resolved server-side, never
  // trusting client-supplied display data — §5). Diverges completely from the
  // WCM flow starting here; `source` absent or `"wcm"` falls through unchanged
  // to the existing behavior below.
  const rawSource = body.source;
  if (rawSource !== undefined && rawSource !== "wcm" && rawSource !== "cornell") {
    return editError(400, "invalid_source", "source");
  }
  if (rawSource === "cornell") {
    if (action !== "add") {
      return editError(400, "cornell_source_add_only", "action");
    }
    return handleCornellAdd({
      unitType,
      unitCode,
      netid: body.netid,
      session,
      realCwid,
      impersonatedCwid,
      requestId,
    });
  }

  if (typeof cwid !== "string" || !CWID_PATTERN.test(cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }
  if (typeof action !== "string" || !isRosterAction(action)) {
    return editError(400, "invalid_action", "action");
  }

  // --- parse the extended fields (center-only; validated below) ---
  const ext: ExtendedFields = {
    membershipType: { present: "membershipType" in body, value: null },
    programCode: { present: "programCode" in body, value: null },
    startDate: { present: "startDate" in body, value: null },
    endDate: { present: "endDate" in body, value: null },
  };
  const anyExtended =
    ext.membershipType.present ||
    ext.programCode.present ||
    ext.startDate.present ||
    ext.endDate.present;

  // Extended fields are CenterMembership-only.
  if (unitType === "division" && anyExtended) {
    return editError(400, "roster_field_center_only", "unitType");
  }

  if (ext.membershipType.present) {
    const v = body.membershipType;
    if (v !== null && (typeof v !== "string" || !isCenterMembershipType(v))) {
      return editError(400, "invalid_membership_type", "membershipType");
    }
    ext.membershipType.value = (v as "research" | "clinical" | null) ?? null;
  }
  if (ext.programCode.present) {
    const v = body.programCode;
    if (v !== null && (typeof v !== "string" || v.length === 0 || v.length > 16)) {
      return editError(400, "invalid_program_code", "programCode");
    }
    ext.programCode.value = (v as string | null) ?? null;
  }
  if (ext.startDate.present) {
    const r = validateRosterDate(body.startDate);
    if (!r.ok) return editError(400, r.error, "startDate");
    ext.startDate.value = r.value;
  }
  if (ext.endDate.present) {
    const r = validateRosterDate(body.endDate);
    if (!r.ok) return editError(400, r.error, "endDate");
    ext.endDate.value = r.value;
  }

  // --- unit existence + manually-owned check ---
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
      return editError(400, "no_manual_roster", "unitType");
    }
    unitSlug = division.slug;
    parentDeptCode = division.deptCode;
    parentDeptSlug = division.department?.slug ?? undefined;
  }

  // --- authz: Curator/Owner of the unit (cascade for division), or Superuser ---
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

  // --- program taxonomy validation (center; only when programCode is set) ---
  if (unitType === "center" && ext.programCode.present && ext.programCode.value !== null) {
    const programs = await db.read.centerProgram.findMany({
      where: { centerCode: unitCode },
      select: { code: true },
    });
    if (programs.length === 0) {
      return editError(400, "no_taxonomy", "programCode");
    }
    if (!programs.some((p) => p.code === ext.programCode.value)) {
      return editError(400, "invalid_program_code", "programCode");
    }
  }

  // --- date range (when both endpoints are being set non-null) ---
  if (
    ext.startDate.present &&
    ext.endDate.present &&
    !isValidDateRange(ext.startDate.value, ext.endDate.value)
  ) {
    return editError(400, "invalid_date_range", "endDate");
  }

  if (unitType === "division") {
    return handleDivision({
      unitCode,
      cwid,
      action,
      unitSlug,
      parentDeptSlug,
      realCwid,
      impersonatedCwid,
      requestId,
    });
  }
  return handleCenter({
    unitCode,
    cwid,
    action,
    ext,
    unitSlug,
    realCwid,
    impersonatedCwid,
    requestId,
  });
}

// ---------------------------------------------------------------------------
// division — base add/remove/set (no extended fields)
// ---------------------------------------------------------------------------

async function handleDivision(p: {
  unitCode: string;
  cwid: string;
  action: string;
  unitSlug: string;
  parentDeptSlug: string | undefined;
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
}): Promise<NextResponse> {
  const {
    unitCode,
    cwid,
    action,
    unitSlug,
    parentDeptSlug,
    realCwid,
    impersonatedCwid,
    requestId,
  } = p;
  const existing = await db.read.divisionMembership.findUnique({
    where: { divisionCode_cwid: { divisionCode: unitCode, cwid } },
    select: { cwid: true },
  });

  if (action === "remove" && !existing) return editOk({ unitCode, cwid, action, changed: false });
  if (action === "add" && existing) return editOk({ unitCode, cwid, action, changed: false });
  if (action === "set" && existing) return editOk({ unitCode, cwid, action, changed: false });

  try {
    await db.write.$transaction(async (tx) => {
      if (action === "remove") {
        await tx.divisionMembership.delete({
          where: { divisionCode_cwid: { divisionCode: unitCode, cwid } },
        });
      } else {
        await tx.divisionMembership.create({
          data: { divisionCode: unitCode, cwid, source: "manual-ui" },
        });
      }
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "division",
        targetEntityId: unitCode,
        action: "roster_change",
        fieldsChanged: null,
        beforeValues: action === "remove" ? { cwid } : null,
        afterValues: action === "remove" ? null : { cwid },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectUnitChange({ unitKind: "division", unitSlug, parentDeptSlug });
  return editOk({ unitCode, cwid, action, changed: true });
}

// ---------------------------------------------------------------------------
// center — add/remove/set with the extended fields + full-row audit snapshots
// ---------------------------------------------------------------------------

async function handleCenter(p: {
  unitCode: string;
  cwid: string;
  action: string;
  ext: ExtendedFields;
  unitSlug: string;
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
}): Promise<NextResponse> {
  const { unitCode, cwid, action, ext, unitSlug, realCwid, impersonatedCwid, requestId } = p;

  const existing = await db.read.centerMembership.findUnique({
    where: { centerCode_cwid: { centerCode: unitCode, cwid } },
    select: SNAPSHOT_SELECT,
  });

  // Leadership is a `CenterLeader` row (#2542), a separate table, so add/remove
  // keep their original meaning here: this row IS the membership, nothing else
  // rides on it, and removing it cannot vacate a leadership role.
  if (action === "add" && existing) return editOk({ unitCode, cwid, action, changed: false });
  if (action === "remove" && !existing) return editOk({ unitCode, cwid, action, changed: false });

  // The set of columns this write applies — only fields present in the body.
  const applied: Record<string, unknown> = {};
  if (ext.membershipType.present) {
    // #2542 — the roster editor still posts `membershipType`; the role key is
    // the stored fact and the enum is DERIVED from it, never written
    // independently. `null` ("unclassified") becomes the `member` role, which
    // derives straight back to a null enum — so the public badge and the type
    // facet, which both read `membershipType`, are unchanged.
    applied.membershipRoleKey = ext.membershipType.value ?? MEMBER_ROLE_KEY;
    applied.membershipType = deriveMembershipType(ext.membershipType.value);
  }
  if (ext.programCode.present) applied.programCode = ext.programCode.value;
  if (ext.startDate.present) applied.startDate = ext.startDate.value;
  if (ext.endDate.present) applied.endDate = ext.endDate.value;

  try {
    await db.write.$transaction(async (tx) => {
      const before = existing ? snapshot(existing) : null;
      let after: Record<string, unknown> | null;

      if (action !== "remove") {
        // `membership_role_key` FKs to `center_role`, which is empty for the
        // pre-existing centers until the Phase 1 backfill runs. Seed this
        // center's defaults first — idempotent, never clobbers a renamed label,
        // and removes the ordering dependency between the deploy and the
        // backfill entirely.
        await tx.orgUnitRole.createMany({
          data: orgUnitRoleSeedRows(CENTER_ENTITY_TYPE),
          skipDuplicates: true,
        });
      }

      if (action === "remove") {
        await tx.centerMembership.delete({
          where: { centerCode_cwid: { centerCode: unitCode, cwid } },
        });
        after = null;
      } else if (action === "set") {
        const row = await tx.centerMembership.upsert({
          where: { centerCode_cwid: { centerCode: unitCode, cwid } },
          // A row created by the roster editor IS a roster member, so it gets a
          // membership role even when the body carried no `membershipType`
          // (`applied` overrides this when it did).
          create: {
            centerCode: unitCode,
            cwid,
            source: "manual-ui",
            membershipRoleKey: MEMBER_ROLE_KEY,
            ...applied,
          },
          update: applied,
          select: SNAPSHOT_SELECT,
        });
        after = snapshot(row);
      } else {
        // add (row does not exist — guarded above)
        const row = await tx.centerMembership.create({
          data: {
            centerCode: unitCode,
            cwid,
            source: "manual-ui",
            membershipRoleKey: MEMBER_ROLE_KEY,
            ...applied,
          },
          select: SNAPSHOT_SELECT,
        });
        after = snapshot(row);
      }

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center",
        targetEntityId: unitCode,
        action: "roster_change",
        fieldsChanged: null,
        beforeValues: before,
        afterValues: after,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectUnitChange({ unitKind: "center", unitSlug });
  return editOk({ unitCode, cwid, action, changed: true });
}

// ---------------------------------------------------------------------------
// #2519 PR 1 — Cornell (Ithaca) external-member add
// (`docs/2026-08-26-cornell-ithaca-membership-SPEC.md` §5). A separate
// identifier path from the WCM `handleCenter`/`handleDivision` above: the
// membership `cwid` is resolved server-side (either an active Scholar.cwid the
// netid bridges to, or the netid itself), so the unit-existence + authz
// preamble is intentionally re-run here rather than shared with the WCM path,
// to avoid touching that path's tested behavior at all.
// ---------------------------------------------------------------------------

async function handleCornellAdd(p: {
  unitType: "center" | "division";
  unitCode: string;
  netid: unknown;
  session: EditSession;
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
}): Promise<NextResponse> {
  const { unitType, unitCode, netid, session, realCwid, impersonatedCwid, requestId } = p;

  if (!isCornellDirectoryMembersEnabled()) {
    return new NextResponse(null, { status: 404 });
  }
  if (typeof netid !== "string" || !CWID_PATTERN.test(netid)) {
    return editError(400, "invalid_netid", "netid");
  }

  // --- unit existence + manually-owned check (mirrors the WCM path above) ---
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
      return editError(400, "no_manual_roster", "unitType");
    }
    unitSlug = division.slug;
    parentDeptCode = division.deptCode;
    parentDeptSlug = division.department?.slug ?? undefined;
  }

  // --- authz: Curator/Owner of the unit (cascade for division), or Superuser ---
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
      targetCwid: netid,
      path: PATH,
      reason: authz.reason,
      targetEntityType: unitType,
      targetEntityId: unitCode,
    });
    return editError(403, authz.reason);
  }

  // --- resolve the Cornell person server-side (§5) ---
  const resolution = await resolveCornellRosterAdd(netid, {
    fetchByNetid: fetchCornellPersonByNetid,
    findActiveScholarByCwid: (activeCwid) =>
      db.read.scholar.findFirst({
        where: { cwid: activeCwid, deletedAt: null, status: "active" },
        select: { cwid: true },
      }),
  });

  if (resolution.kind === "not_found") {
    return editError(404, "cornell_person_not_found", "netid");
  }
  if (resolution.kind === "disjoint_violation") {
    return editError(409, "cuid_disjointness_violation", "netid");
  }

  const finalCwid = resolution.kind === "wcm" ? resolution.cwid : resolution.cuid;
  const membershipSource = resolution.kind === "wcm" ? "manual-ui" : "cornell-ithaca";

  if (unitType === "division") {
    const existing = await db.read.divisionMembership.findUnique({
      where: { divisionCode_cwid: { divisionCode: unitCode, cwid: finalCwid } },
      select: { cwid: true },
    });
    if (existing) return editOk({ unitCode, cwid: finalCwid, action: "add", changed: false });

    try {
      await db.write.$transaction(async (tx) => {
        if (resolution.kind === "external") {
          await tx.externalMember.upsert({
            where: { cuid: resolution.cuid },
            create: { cuid: resolution.cuid, ...resolution.snapshot },
            update: { ...resolution.snapshot },
          });
        }
        await tx.divisionMembership.create({
          data: { divisionCode: unitCode, cwid: finalCwid, source: membershipSource },
        });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "division",
          targetEntityId: unitCode,
          action: "roster_change",
          fieldsChanged: null,
          beforeValues: null,
          afterValues: { cwid: finalCwid, source: membershipSource },
          ts: new Date(),
          requestId,
        });
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    await reflectUnitChange({ unitKind: "division", unitSlug, parentDeptSlug });
    return editOk({ unitCode, cwid: finalCwid, action: "add", changed: true });
  }

  // center
  const existing = await db.read.centerMembership.findUnique({
    where: { centerCode_cwid: { centerCode: unitCode, cwid: finalCwid } },
    select: { cwid: true },
  });
  if (existing) return editOk({ unitCode, cwid: finalCwid, action: "add", changed: false });

  try {
    await db.write.$transaction(async (tx) => {
      if (resolution.kind === "external") {
        await tx.externalMember.upsert({
          where: { cuid: resolution.cuid },
          create: { cuid: resolution.cuid, ...resolution.snapshot },
          update: { ...resolution.snapshot },
        });
      }
      // #2542 — same lazy vocabulary seed as `handleCenter`: this is the THIRD
      // write path that references `center_role`, and `membership_role_key` is a
      // non-null literal here, so without it every Cornell add 500s on the FK
      // until the Phase 1 backfill has been run by hand.
      await tx.orgUnitRole.createMany({
        data: orgUnitRoleSeedRows(CENTER_ENTITY_TYPE),
        skipDuplicates: true,
      });
      await tx.centerMembership.create({
        // An added Cornell (Ithaca) member is a roster member like any other, so
        // it carries the `member` role. Its derived `membershipType` stays null,
        // exactly as this row's type column was before.
        data: {
          centerCode: unitCode,
          cwid: finalCwid,
          source: membershipSource,
          membershipRoleKey: MEMBER_ROLE_KEY,
        },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center",
        targetEntityId: unitCode,
        action: "roster_change",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: { cwid: finalCwid, source: membershipSource },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
  await reflectUnitChange({ unitKind: "center", unitSlug });
  return editOk({ unitCode, cwid: finalCwid, action: "add", changed: true });
}
