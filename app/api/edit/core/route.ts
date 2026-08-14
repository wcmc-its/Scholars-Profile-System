/**
 * POST /api/edit/core — edit a core facility's description / URL / visibility /
 * leadership (cores-as-org-units P3, `core-as-org-unit-plan.md`).
 *
 * Body: `{ coreId, action, ... }`.
 *
 * A SIBLING route to `/api/edit/unit`, not a widen of it: `/api/edit/unit`'s
 * `op:"update"` is hardcoded to Center/Division columns (two closed field
 * allowlists, a `findUnit` dependency with no core branch, an `entityType`
 * guard that rejects `"core"` outright) and Core's shape — flat scalar
 * columns plus a related `CoreLeader` table, no `field_override` layer —
 * doesn't map onto either allowlist. This mirrors the #2409 pattern already
 * used for `/api/edit/grant`'s core widen: branch on core-specific existence
 * + role lookup, skip what doesn't apply. No ED-lock (no ED source ever
 * writes a core row); no `reflectUnitChange` (`/cores/[coreId]` is
 * `force-dynamic` — there is no ISR cache to purge for a core write, and
 * these fields aren't rendered there yet).
 *
 * Actions:
 *   - `set_description` / `set_url` / `set_visible` — in-row `Core` column
 *     update. No-op if the value is unchanged.
 *   - `add_leader` / `remove_leader` / `set_leader` — `CoreLeader` row CRUD
 *     (`cwid`, optional `role` / `interim` / `sortOrder`, each only mutated
 *     when present in the body) — mirrors `/api/edit/center-program`'s leader
 *     actions. `role` is an open string (`CoreLeader.role`, schema default
 *     `"director"`), not a closed enum like `CenterProgramLeader.role`.
 *
 * Authz: Owner / Curator of the core, or Superuser — `getCoreOwnerRole` +
 * `authorizeCoreClaim`, the SAME check `/edit/core/[coreId]` and
 * `/api/edit/core-claim` already use for this page's other owner-only
 * actions. Deliberately NOT `canEditUnit` — cores have no comms_steward
 * parity (a separate domain from profile-content stewardship, per
 * `authorizeCoreClaim`'s own doc comment).
 *
 * Each mutation is one MySQL transaction with a B03 audit row
 * (`targetEntityType: "core"`, `targetEntityId: coreId` — distinct from the
 * claim queue's `"{coreId}:{pmid}"` shape; there is no pmid dimension here):
 * `field_override` for the column writes, `roster_change` for leader
 * mutations (mirrors `/api/edit/center-program`'s action choice for the same
 * two shapes of write).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  authorizeCoreClaim,
  getCoreOwnerRole,
  logEditDenial,
  type CoreOwnerLookup,
} from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { CWID_PATTERN, validateUnitDescription, validateUnitUrl } from "@/lib/edit/validators";

const PATH = "/api/edit/core";

const CORE_ACTIONS = [
  "set_description",
  "set_url",
  "set_visible",
  "add_leader",
  "remove_leader",
  "set_leader",
] as const;
type CoreAction = (typeof CORE_ACTIONS)[number];
function isCoreAction(value: string): value is CoreAction {
  return (CORE_ACTIONS as readonly string[]).includes(value);
}

const MAX_SORT_ORDER = 9_999; // mirrors /api/edit/center-program's cap
/** `CoreLeader.role` is an open string (schema default "director"), not a
 *  closed enum — mirrors `CenterProgramLeader.role`'s shape minus the fixed
 *  vocabulary. Bounded to the column width (`@db.VarChar(32)`). */
const ROLE_MAX_CHARS = 32;

function validateLeaderRole(input: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof input !== "string") return { ok: false };
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > ROLE_MAX_CHARS) return { ok: false };
  return { ok: true, value: trimmed };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { coreId, action } = body;
  if (typeof coreId !== "string" || coreId.length === 0 || coreId.length > 32) {
    return editError(400, "invalid_core_id", "coreId");
  }
  if (typeof action !== "string" || !isCoreAction(action)) {
    return editError(400, "invalid_action", "action");
  }

  // --- core existence (core-claim-route's convention: 404, not 400 — this is
  // a core-only route, not a multi-unit-kind one) ---
  const core = await db.read.core.findUnique({
    where: { id: coreId },
    select: { id: true, description: true, url: true, visible: true },
  });
  if (!core) return editError(404, "core_not_found", "coreId");

  // --- authz: Owner/Curator of the core, or Superuser — same predicate the
  // claim queue page + /api/edit/core-claim already use. ---
  const coreRole = await getCoreOwnerRole(session, coreId, db.read as unknown as CoreOwnerLookup);
  const authz = authorizeCoreClaim(session, coreRole);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: coreId,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "core",
      targetEntityId: coreId,
    });
    return editError(403, authz.reason);
  }

  const isLeaderAction =
    action === "add_leader" || action === "remove_leader" || action === "set_leader";

  // ------------------------------------------------------------------ leaders
  if (isLeaderAction) {
    if (typeof body.cwid !== "string" || !CWID_PATTERN.test(body.cwid)) {
      return editError(400, "invalid_cwid", "cwid");
    }
    const cwid = body.cwid;

    // role / interim / sortOrder apply to add_leader + set_leader; each is
    // optional and only mutated when present in the body (mirrors
    // /api/edit/center-program's partial-update shape).
    const rolePresent = (action === "add_leader" || action === "set_leader") && "role" in body;
    const interimPresent =
      (action === "add_leader" || action === "set_leader") && "interim" in body;
    const sortOrderPresent =
      (action === "add_leader" || action === "set_leader") && "sortOrder" in body;

    let role = "director"; // Core.leader's schema default
    let interim = false;
    let sortOrder = 0;
    if (rolePresent) {
      const r = validateLeaderRole(body.role);
      if (!r.ok) return editError(400, "invalid_value", "role");
      role = r.value;
    }
    if (interimPresent) {
      if (typeof body.interim !== "boolean") return editError(400, "invalid_value", "interim");
      interim = body.interim;
    }
    if (sortOrderPresent) {
      if (
        typeof body.sortOrder !== "number" ||
        !Number.isInteger(body.sortOrder) ||
        body.sortOrder < 0 ||
        body.sortOrder > MAX_SORT_ORDER
      ) {
        return editError(400, "invalid_value", "sortOrder");
      }
      sortOrder = body.sortOrder;
    }

    const existing = await db.read.coreLeader.findUnique({
      where: { coreId_cwid: { coreId, cwid } },
      select: { cwid: true, role: true, interim: true, sortOrder: true },
    });

    if (action === "add_leader" && existing) {
      return editOk({ coreId, cwid, action, changed: false });
    }
    if (action === "remove_leader" && !existing) {
      return editOk({ coreId, cwid, action, changed: false });
    }
    if (action === "set_leader" && !existing) {
      return editError(400, "leader_not_found", "cwid");
    }

    try {
      await db.write.$transaction(async (tx) => {
        const before = existing
          ? {
              cwid: existing.cwid,
              role: existing.role,
              interim: existing.interim,
              sortOrder: existing.sortOrder,
            }
          : null;
        let after: Record<string, unknown> | null;

        if (action === "remove_leader") {
          await tx.coreLeader.delete({ where: { coreId_cwid: { coreId, cwid } } });
          after = null;
        } else if (action === "add_leader") {
          const row = await tx.coreLeader.create({
            data: { coreId, cwid, role, interim, sortOrder },
            select: { cwid: true, role: true, interim: true, sortOrder: true },
          });
          after = { cwid: row.cwid, role: row.role, interim: row.interim, sortOrder: row.sortOrder };
        } else {
          // set_leader — update only the fields present in the body.
          const row = await tx.coreLeader.update({
            where: { coreId_cwid: { coreId, cwid } },
            data: {
              ...(rolePresent ? { role } : {}),
              ...(interimPresent ? { interim } : {}),
              ...(sortOrderPresent ? { sortOrder } : {}),
            },
            select: { cwid: true, role: true, interim: true, sortOrder: true },
          });
          after = { cwid: row.cwid, role: row.role, interim: row.interim, sortOrder: row.sortOrder };
        }

        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "core",
          targetEntityId: coreId,
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

    return editOk({ coreId, cwid, action, changed: true });
  }

  // -------------------------------------------------------------- column fields
  let updatePayload: Record<string, unknown>;
  let beforeValue: unknown;
  let afterValue: unknown;
  let fieldName: string;

  if (action === "set_description") {
    if (typeof body.description !== "string") {
      return editError(400, "invalid_value", "description");
    }
    const r = validateUnitDescription(body.description);
    if (!r.ok) return editError(400, r.error, "description");
    const value = r.value === "" ? null : r.value;
    if (core.description === value) return editOk({ coreId, action, changed: false });
    fieldName = "description";
    beforeValue = core.description;
    afterValue = value;
    updatePayload = { description: value };
  } else if (action === "set_url") {
    if (typeof body.url !== "string") return editError(400, "invalid_value", "url");
    const r = validateUnitUrl(body.url);
    if (!r.ok) return editError(400, r.error, "url");
    const value = r.value === "" ? null : r.value;
    if (core.url === value) return editOk({ coreId, action, changed: false });
    fieldName = "url";
    beforeValue = core.url;
    afterValue = value;
    updatePayload = { url: value };
  } else {
    // set_visible
    if (typeof body.visible !== "boolean") return editError(400, "invalid_value", "visible");
    if (core.visible === body.visible) return editOk({ coreId, action, changed: false });
    fieldName = "visible";
    beforeValue = core.visible;
    afterValue = body.visible;
    updatePayload = { visible: body.visible };
  }

  try {
    await db.write.$transaction(async (tx) => {
      await tx.core.update({ where: { id: coreId }, data: updatePayload });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "core",
        targetEntityId: coreId,
        action: "field_override",
        fieldsChanged: [fieldName],
        beforeValues: { [fieldName]: beforeValue },
        afterValues: { [fieldName]: afterValue },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ coreId, action, changed: true });
}
