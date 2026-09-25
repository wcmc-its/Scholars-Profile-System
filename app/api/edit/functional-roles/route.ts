/**
 * POST /api/edit/functional-roles — record, re-scope or revoke a manual
 * functional role assignment (`functional_role_grant`), or re-run the import
 * that mirrors existing holders, from the Administrators page's Functional
 * roles tab (`lib/edit/functional-roles.server.ts`).
 *
 * Body: `{ op, role?, cwid?, scopes?, name? }`.
 *   - `op`: "grant" | "set_scopes" | "revoke" | "import";
 *   - `role`: a `FUNCTIONAL_ROLES` key (not read for "import");
 *   - `cwid`: lowercased, then `/^[a-z][a-z0-9]{1,11}$/` (not for "import");
 *   - `scopes` ("grant", "set_scopes"): a non-empty string array, each key
 *     one of the role's scope options; normalized ("*" swallows the rest);
 *   - `name` ("grant", optional): the picker's directory display name,
 *     stored as `grantee_name` when 1–255 chars, else null (never a 400).
 *
 * Gate order (mirrors `/api/edit/report-access`): the shared preamble →
 * not a superuser ⇒ 403 `not_superuser` BEFORE any body field is read →
 * validation ⇒ 400 → the write, one transaction with its audit row
 * (`actorCwid` is always the real human). "set_scopes" on a person with no
 * manual row ⇒ 404 `not_found` (an imported row is never addressable here).
 * Responds with the full list the write re-read on the writer.
 *
 * Registry only: nothing here changes who can open anything (see the lib).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { logEditDenial } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import {
  isFunctionalRole,
  normalizeScopes,
  type FunctionalRoleRow,
} from "@/lib/edit/functional-roles";
import {
  canManageFunctionalRoles,
  grantFunctionalRole,
  importFunctionalRoles,
  revokeFunctionalRole,
  setFunctionalRoleScopes,
  validScopes,
} from "@/lib/edit/functional-roles.server";

const PATH = "/api/edit/functional-roles";
const GRANTEE_PATTERN = /^[a-z][a-z0-9]{1,11}$/;
const GRANTEE_NAME_MAX = 255;
const MAX_SCOPES = 50;

function granteeNameFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= GRANTEE_NAME_MAX ? trimmed : null;
}

function scopesFrom(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPES) return null;
  if (!value.every((v) => typeof v === "string")) return null;
  return normalizeScopes(value as string[]);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (!canManageFunctionalRoles(session)) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: "not_superuser",
    });
    return editError(403, "not_superuser");
  }

  const { op } = body;
  if (op !== "grant" && op !== "set_scopes" && op !== "revoke" && op !== "import") {
    return editError(400, "invalid_op", "op");
  }

  const actor = { actorCwid: realCwid, impersonatedCwid, requestId };

  if (op === "import") {
    try {
      const result = await importFunctionalRoles(actor);
      return editOk({
        op,
        changed: result.added + result.updated + result.removed > 0,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        rows: result.rows,
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
  }

  const { role } = body;
  if (!isFunctionalRole(role)) {
    return editError(400, "invalid_role", "role");
  }
  const cwid = typeof body.cwid === "string" ? body.cwid.trim().toLowerCase() : "";
  if (!GRANTEE_PATTERN.test(cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }
  let scopes: string[] = [];
  if (op !== "revoke") {
    const parsed = scopesFrom(body.scopes);
    if (!parsed || !validScopes(role, parsed)) {
      return editError(400, "invalid_scopes", "scopes");
    }
    scopes = parsed;
  }

  let changed: boolean;
  let rows: FunctionalRoleRow[];
  try {
    if (op === "grant") {
      ({ changed, rows } = await grantFunctionalRole({
        ...actor,
        role,
        cwid,
        scopes,
        granteeName: granteeNameFrom(body.name),
      }));
    } else if (op === "set_scopes") {
      const result = await setFunctionalRoleScopes({ ...actor, role, cwid, scopes });
      if (!result.found) return editError(404, "not_found");
      ({ changed, rows } = result);
    } else {
      ({ changed, rows } = await revokeFunctionalRole({ ...actor, role, cwid }));
    }
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ op, changed, rows });
}
