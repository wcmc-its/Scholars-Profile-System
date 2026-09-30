/**
 * POST /api/edit/center-leadership — the vocabulary-driven center leadership
 * editor (#2542 Phase C, plan section D3).
 *
 * Before this route, only `director` was assignable (the `directorCwid` /
 * `leaderInterim` fields on `POST /api/edit/unit`), hardcoded to
 * `DIRECTOR_ROLE_KEY` and enforcing single-holder by construction (a
 * vacate-then-grant `deleteMany`+`create` pair, not a `singleHolder`-driven
 * check). The center vocabulary carries three leadership roles (`director`,
 * `co_director`, `associate_director`, `lib/org-unit-roles.ts`); this route
 * generalizes to ANY `leadership`-group `OrgUnitRole` entry for `center`, and
 * is what closes `isRoleAllowedAtUnit`'s "director path is not gated" gap
 * (`lib/api/org-unit-role-scope.ts`'s docblock) and what actually ENFORCES
 * `OrgUnitRole.singleHolder` for the first time (previously declared, never
 * checked — that model's own docblock says so).
 *
 * Body: `{ centerCode, roleKey, action, cwid, interim?, replace? }`.
 *
 * Actions:
 *   - `add`         — insert a `(roleKey, cwid)` holder. `interim` is
 *                      optional and defaults to `false` — a newly added or
 *                      replacing holder is never interim unless the request
 *                      says so; the incumbent's `interim` flag (if any) is
 *                      NOT inherited (a replacement director is presumed
 *                      permanent unless the caller states otherwise). No-op
 *                      if the person already holds this exact role. For a
 *                      `singleHolder` role that already has a DIFFERENT
 *                      holder: `409 role_single_holder_conflict` (naming the
 *                      incumbent via `incumbentCwid`) unless the body also
 *                      carries `replace: true`, in which case the incumbent
 *                      is vacated and the new holder granted in the SAME
 *                      transaction. A non-`singleHolder` role never
 *                      conflicts — it simply gains another holder.
 *   - `remove`      — delete a holder. No-op if absent.
 *   - `set_interim` — toggle `interim` on an existing holder. `400
 *                      holder_not_found` if the person doesn't hold this role.
 *
 * Authz mirrors `/api/edit/center-program`: Curator / Owner of the center, or
 * Superuser / comms_steward (`canEditUnit`). These are content fields, not
 * structural, so they are not Superuser-only.
 *
 * Each mutation is one MySQL transaction: a lazy `OrgUnitRole` vocabulary
 * seed (idempotent, `skipDuplicates` — same reasoning as the director path
 * and `/api/edit/center-program`: the FIRST-EVER write to any center's
 * leadership must not 500 waiting on a backfill), an `isRoleAllowedAtUnit`
 * scope check (`400 role_not_allowed_at_unit`, same shape the roster editor
 * already enforces for membership roles), the `singleHolder` count-and-refuse
 * logic above, the write itself, and a B03 audit row in the same transaction
 * — `roster_change` for `add` / `remove` / a `replace`'s single combined row,
 * `field_override` for `set_interim`; both EXISTING `AuditAction` values
 * (`lib/edit/audit.ts`), `targetEntityType: "center"`, no ENUM change needed.
 * Post-commit: `reflectUnitChange` purges the center page (it lists leaders).
 *
 * Response: `add`/`replace`/`set_interim` return the resulting holder as
 * `{ ok: true, holder: { cwid, name, title, interim }, ... }` — `name`/
 * `title` resolved the same way `lib/api/unit-edit-context.ts`'s loader
 * resolves every other cwid on this page (`resolveScholarNames`, exported
 * from there for this reuse). `remove` returns `{ ok: true, ... }` with no
 * holder. The client renders this returned state rather than assuming any
 * flag client-side (a replacement holder's `interim` is whatever the server
 * actually wrote, not inherited from the incumbent — see `add` above).
 */
import { type NextRequest, NextResponse } from "next/server";

import { isRoleAllowedAtUnit } from "@/lib/api/org-unit-role-scope";
import { resolveScholarNames } from "@/lib/api/unit-edit-context";
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
import { CWID_PATTERN } from "@/lib/edit/validators";
import { CENTER_ENTITY_TYPE, orgUnitRoleSeedRows } from "@/lib/org-unit-roles";

const PATH = "/api/edit/center-leadership";

const CENTER_LEADERSHIP_ACTIONS = ["add", "remove", "set_interim"] as const;
type CenterLeadershipAction = (typeof CENTER_LEADERSHIP_ACTIONS)[number];
function isCenterLeadershipAction(value: string): value is CenterLeadershipAction {
  return (CENTER_LEADERSHIP_ACTIONS as readonly string[]).includes(value);
}

const MAX_ROLE_KEY_LENGTH = 32;

/** `roleKey` (of kind `center`) names a leadership entry with NO matching
 *  `OrgUnitRole` row, or one whose `roleGroup` is `membership` — thrown
 *  INSIDE the transaction, after the lazy seed, before any write. */
class InvalidRole extends Error {}

/** `roleKey` has an explicit `OrgUnitRoleScope` allowlist and `centerCode`
 *  isn't on it (#2557 Phase E) — same gate the roster editor already enforces
 *  for membership roles, now closing the leadership gap that helper's own
 *  docblock calls out. */
class RoleNotAllowedAtUnit extends Error {}

/** `roleKey` is `singleHolder` and a DIFFERENT cwid already holds it, and the
 *  request did not carry `replace: true`. */
class SingleHolderConflict extends Error {
  constructor(public readonly incumbentCwid: string) {
    super("single_holder_conflict");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { centerCode, roleKey, action, cwid } = body;
  if (typeof centerCode !== "string" || centerCode.length === 0) {
    return editError(400, "invalid_unit_code", "centerCode");
  }
  if (typeof roleKey !== "string" || roleKey.length === 0 || roleKey.length > MAX_ROLE_KEY_LENGTH) {
    return editError(400, "invalid_role", "roleKey");
  }
  if (typeof action !== "string" || !isCenterLeadershipAction(action)) {
    return editError(400, "invalid_action", "action");
  }
  if (typeof cwid !== "string" || !CWID_PATTERN.test(cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }

  // `set_interim` REQUIRES `interim`. `add` accepts it as an OPTIONAL flag
  // (default false) — a newly added or replacing holder is never interim
  // unless the request says so; the incumbent's flag is never inherited.
  let interim = false;
  if (action === "set_interim") {
    if (typeof body.interim !== "boolean") return editError(400, "invalid_value", "interim");
    interim = body.interim;
  } else if (action === "add" && "interim" in body) {
    if (typeof body.interim !== "boolean") return editError(400, "invalid_value", "interim");
    interim = body.interim;
  }
  let replace = false;
  if (action === "add" && "replace" in body) {
    if (typeof body.replace !== "boolean") return editError(400, "invalid_value", "replace");
    replace = body.replace;
  }

  // --- center existence ---
  const center = await db.read.center.findUnique({
    where: { code: centerCode },
    select: { code: true, slug: true },
  });
  if (!center) return editError(400, "unit_not_found", "centerCode");

  // --- authz: Curator/Owner of the center, or Superuser/comms_steward ---
  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: centerCode },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: cwid,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: centerCode,
    });
    return editError(403, authz.reason);
  }

  // --- this exact (roleKey, cwid) holder, read before the transaction so a
  // pure no-op (re-adding an existing holder, removing an absent one) never
  // opens a write transaction at all — same convention as
  // `/api/edit/center-program`'s `add_leader`/`remove_leader`.
  const existing = await db.read.orgUnitRoleAssignment.findUnique({
    where: {
      entityType_entityId_cwid_roleKey: {
        entityType: CENTER_ENTITY_TYPE,
        entityId: centerCode,
        cwid,
        roleKey,
      },
    },
    select: { cwid: true, interim: true },
  });

  if (action === "add" && existing) {
    return editOk({ centerCode, roleKey, cwid, action, changed: false });
  }
  if (action === "remove" && !existing) {
    return editOk({ centerCode, roleKey, cwid, action, changed: false });
  }
  if (action === "set_interim" && !existing) {
    return editError(400, "holder_not_found", "cwid");
  }

  let replacedCwid: string | null = null;
  // The interim value actually written for add/replace/set_interim, so the
  // response can report ground truth instead of the client's assumption.
  let resultInterim: boolean | null = null;

  try {
    await db.write.$transaction(async (tx) => {
      // The 11 pre-existing centers (and any center whose first-ever
      // leadership write is this one) have no vocabulary until this seed
      // runs — idempotent, never clobbers a renamed label, and removes the
      // ordering dependency between a deploy and a backfill entirely.
      await tx.orgUnitRole.createMany({
        data: orgUnitRoleSeedRows(CENTER_ENTITY_TYPE),
        skipDuplicates: true,
      });

      const role = await tx.orgUnitRole.findUnique({
        where: { entityType_key: { entityType: CENTER_ENTITY_TYPE, key: roleKey } },
        select: { roleGroup: true, singleHolder: true },
      });
      if (!role || role.roleGroup !== "leadership") throw new InvalidRole();

      const allowed = await isRoleAllowedAtUnit({
        entityType: CENTER_ENTITY_TYPE,
        roleKey,
        entityId: centerCode,
        client: tx,
      });
      if (!allowed) throw new RoleNotAllowedAtUnit();

      let before: Record<string, unknown> | null = existing
        ? { roleKey, cwid: existing.cwid, interim: existing.interim }
        : null;
      let after: Record<string, unknown> | null = null;
      let auditAction: "roster_change" | "field_override" = "roster_change";
      let fieldsChanged: string[] | null = null;

      if (action === "remove") {
        await tx.orgUnitRoleAssignment.delete({
          where: {
            entityType_entityId_cwid_roleKey: {
              entityType: CENTER_ENTITY_TYPE,
              entityId: centerCode,
              cwid,
              roleKey,
            },
          },
        });
        after = null;
      } else if (action === "set_interim") {
        const row = await tx.orgUnitRoleAssignment.update({
          where: {
            entityType_entityId_cwid_roleKey: {
              entityType: CENTER_ENTITY_TYPE,
              entityId: centerCode,
              cwid,
              roleKey,
            },
          },
          data: { interim },
          select: { cwid: true, interim: true },
        });
        after = { roleKey, cwid: row.cwid, interim: row.interim };
        auditAction = "field_override";
        fieldsChanged = ["interim"];
        resultInterim = row.interim;
      } else {
        // add
        if (role.singleHolder) {
          const holders = await tx.orgUnitRoleAssignment.findMany({
            where: { entityType: CENTER_ENTITY_TYPE, entityId: centerCode, roleKey },
            select: { cwid: true, interim: true },
          });
          if (holders.length > 0) {
            if (!replace) throw new SingleHolderConflict(holders[0].cwid);
            // Vacate every existing holder (the invariant admits at most one;
            // loop defensively) then grant — one combined `roster_change` row.
            for (const holder of holders) {
              await tx.orgUnitRoleAssignment.delete({
                where: {
                  entityType_entityId_cwid_roleKey: {
                    entityType: CENTER_ENTITY_TYPE,
                    entityId: centerCode,
                    cwid: holder.cwid,
                    roleKey,
                  },
                },
              });
            }
            replacedCwid = holders[0].cwid;
            before = { roleKey, cwid: holders[0].cwid, interim: holders[0].interim };
            // A replacement holder is NOT interim unless the request asked
            // for it — the incumbent's `interim` flag belongs to the PERSON
            // who is leaving, not the role, so it is never inherited here.
            const row = await tx.orgUnitRoleAssignment.create({
              data: {
                entityType: CENTER_ENTITY_TYPE,
                entityId: centerCode,
                cwid,
                roleKey,
                interim,
              },
              select: { cwid: true, interim: true },
            });
            after = { roleKey, cwid: row.cwid, interim: row.interim };
            resultInterim = row.interim;
          } else {
            const row = await tx.orgUnitRoleAssignment.create({
              data: { entityType: CENTER_ENTITY_TYPE, entityId: centerCode, cwid, roleKey, interim },
              select: { cwid: true, interim: true },
            });
            after = { roleKey, cwid: row.cwid, interim: row.interim };
            resultInterim = row.interim;
          }
        } else {
          const row = await tx.orgUnitRoleAssignment.create({
            data: { entityType: CENTER_ENTITY_TYPE, entityId: centerCode, cwid, roleKey, interim },
            select: { cwid: true, interim: true },
          });
          after = { roleKey, cwid: row.cwid, interim: row.interim };
          resultInterim = row.interim;
        }
      }

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center",
        targetEntityId: centerCode,
        action: auditAction,
        fieldsChanged,
        beforeValues: before,
        afterValues: after,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    if (err instanceof InvalidRole) {
      return editError(400, "invalid_role", "roleKey");
    }
    if (err instanceof RoleNotAllowedAtUnit) {
      return editError(400, "role_not_allowed_at_unit", "roleKey");
    }
    if (err instanceof SingleHolderConflict) {
      return NextResponse.json(
        { ok: false, error: "role_single_holder_conflict", field: "cwid", incumbentCwid: err.incumbentCwid },
        { status: 409 },
      );
    }
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectUnitChange({ unitKind: "center", unitSlug: center.slug });

  if (action === "remove") {
    return editOk({ centerCode, roleKey, cwid, action, changed: true });
  }

  // add / set_interim (the only branches that reach here without throwing):
  // resolve the holder's display name/title the same way the loader resolves
  // every other cwid on this page, and report the interim value ACTUALLY
  // written — never an assumption the client would otherwise have to make.
  const nameMap = await resolveScholarNames([cwid], db.read);
  const resolved = nameMap.get(cwid);
  const holder = {
    cwid,
    name: resolved?.name ?? null,
    title: resolved?.title ?? null,
    interim: resultInterim ?? false,
  };
  return editOk({ centerCode, roleKey, cwid, action, changed: true, replacedCwid, holder });
}
