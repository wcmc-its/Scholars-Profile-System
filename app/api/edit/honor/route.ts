/**
 * /api/edit/honor — CRUD for a scholar's honors & distinctions (`honor`, #1760):
 * academy memberships, investigatorships, and prizes — NOT endowed chairs (see
 * the `HonorCategory` note in schema.prisma). Curator/self entry on /edit is the
 * whole ingest for Phase 1; no feed writes this table yet.
 *
 *   GET  ?cwid=<target>  — list the target scholar's rows (defaults to self).
 *   POST { action, ... } — a single write endpoint (mirrors /api/edit/appointment):
 *       - `create` — `{ cwid, category, name, organization, year?, sourceRef?,
 *                       showOnProfile? }`
 *       - `update` — `{ id, <same field set> }` (full replace of the mutable fields)
 *       - `delete` — `{ id }`
 *
 * Authorization rides the SAME `authorizeOverviewWrite` predicate as the bio +
 * section-visibility + self-asserted-appointment surfaces (#1554/#1557/#1568):
 * self OR superuser OR comms_steward OR granted proxy (#779) OR org-unit
 * owner/curator (#728), keyed on the OWNING scholar. For `create` the owner is
 * the posted `cwid`; for `update` / `delete` it is the existing row's `cwid` (so
 * a scholar can never touch another scholar's row). Each mutation is one
 * transaction with a B03 audit row (its own store → its own `honor_*` action,
 * never `field_override`). The owner's profile page is reflected post-commit.
 *
 * PHASE 1 SCOPE — `status` is never read from a request body. `create` pins
 * `published`; `update` leaves the stored value untouched (as it does `source` /
 * `enteredByCwid`). The `HonorStatus` enum carries `pending`/`rejected` so the
 * Phase 3 feed + its approval queue need no migration, but this route exposes NO
 * approval affordance and cannot move a row between states.
 *
 * UNLIKE `profile_appointment`, `honor` rows are NOT profile-only by
 * construction — the spec permits a later department/search rollup. Phase 1
 * ships NO aggregate surface: only the owner's profile reads this table, so
 * `reflectOwnerProfile` is a complete reflection today. A serializer added to an
 * aggregate surface later must extend the reflection with it.
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
import { type HonorInput, validateHonorInput } from "@/lib/edit/honor";
import { reflectVisibilityChange, resolveAffectedProfiles } from "@/lib/edit/revalidation";

const PATH = "/api/edit/honor";

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
  name: string;
  organization: string;
  year: number | null;
  status: string;
  showOnProfile: boolean;
  source: string;
  sourceRef: string | null;
  enteredByCwid: string;
  createdAt: Date;
  updatedAt: Date;
};

/** The wire shape for one honor (timestamps as ISO). */
function serialize(row: StoredRow) {
  return {
    id: row.id,
    cwid: row.cwid,
    category: row.category,
    name: row.name,
    organization: row.organization,
    year: row.year,
    status: row.status,
    showOnProfile: row.showOnProfile,
    source: row.source,
    sourceRef: row.sourceRef,
    enteredByCwid: row.enteredByCwid,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The mutable content the audit before/after values capture (no id/timestamps).
 *  `status` is included: this route never changes it, so an audit row that ever
 *  shows it moving is evidence of a write from outside this surface. */
function snapshot(row: StoredRow): Record<string, unknown> {
  return {
    category: row.category,
    name: row.name,
    organization: row.organization,
    year: row.year,
    status: row.status,
    showOnProfile: row.showOnProfile,
    source: row.source,
    sourceRef: row.sourceRef,
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
// GET — list the target scholar's honors (editor view: ALL rows — hidden AND
// non-`published` included, so a curator sees exactly what is stored).
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
    // No `sortOrder` column (deliberately cut): the order is derived. `category`
    // is a MySQL ENUM, so `asc` sorts by DECLARATION order — the same grouping
    // order the profile renders. Then newest honor first; `year` NULLs sort last
    // under `desc`, so undated rows land at the foot of their group. `createdAt`
    // breaks ties so paging/render order is stable.
    const rows = await db.read.honor.findMany({
      where: { cwid: targetCwid },
      orderBy: [{ category: "asc" }, { year: "desc" }, { createdAt: "asc" }],
    });
    return editOk({ honors: rows.map(serialize) });
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

  const parsed = validateHonorInput(body);
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
      const row = await tx.honor.create({
        data: {
          ...buildData(parsed.value),
          cwid: targetCwid,
          // Phase 1: a human entered it on /edit, so it is published on arrival.
          // Pinned here rather than left to the column default so the policy is
          // legible at the write site when Phase 3 adds a `pending` feed writer.
          status: "published",
          source,
          // Provenance, set once at entry: the roster URL a curator cites here
          // is the key Phase 3 de-dups on. Create-only — see `buildData`.
          sourceRef: parsed.value.sourceRef,
          enteredByCwid: realCwid,
        },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "honor",
        targetEntityId: row.id,
        action: "honor_create",
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
  return editOk({ action: "create", honor: serialize(created) });
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
  const existing = (await db.read.honor.findUnique({
    where: { id: rowId },
  })) as StoredRow | null;
  if (!existing) return editError(404, "honor_not_found", "id");

  // For `update`, validate the new field set BEFORE authz work (a malformed body
  // is a 400 regardless of who is asking).
  let parsed: HonorInput | null = null;
  if (action === "update") {
    const result = validateHonorInput(body);
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
        await tx.honor.delete({ where: { id: rowId } });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "honor",
          targetEntityId: rowId,
          action: "honor_delete",
          fieldsChanged: null,
          beforeValues: withUnitAttribution(before, authz.viaUnitAdminUnit),
          afterValues: null,
          ts: new Date(),
          requestId,
        });
        return null;
      }
      // update — replace the mutable fields (`status`, `source`, `sourceRef`
      // and `enteredByCwid` are the original entry's provenance and are left
      // untouched; `buildData` omits all four).
      const row = await tx.honor.update({
        where: { id: rowId },
        data: buildData(parsed as HonorInput),
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "honor",
        targetEntityId: rowId,
        action: "honor_update",
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
    : editOk({ action, honor: serialize(updated as StoredRow) });
}

/** The mutable-field `data` shared by create + update (create additionally
 *  spreads the ownership/provenance columns `cwid` / `status` / `source` /
 *  `sourceRef` / `enteredByCwid`, none of which an update may move).
 *
 *  `sourceRef` is provenance, NOT a mutable field: it is the roster URL a Phase 3
 *  feed de-dups on. The card does not expose it as an input and does not echo it
 *  back, so an absent `body.sourceRef` normalises to null — if this returned it,
 *  every curator edit of a feed-surfaced row would silently wipe the URL and the
 *  next annual sweep would re-emit that honor as a brand-new `pending` row. */
function buildData(input: HonorInput) {
  return {
    category: input.category,
    name: input.name,
    organization: input.organization,
    year: input.year,
    showOnProfile: input.showOnProfile,
  };
}

/** Reflect the owner's profile page post-commit — the only surface these rows
 *  render on in Phase 1 (no aggregate serializer reads `honor` yet). */
async function reflectOwnerProfile(cwid: string): Promise<void> {
  const affected = await resolveAffectedProfiles("scholar", cwid, null);
  await reflectVisibilityChange(affected.map((a) => a.slug));
}
