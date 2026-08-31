/**
 * PATCH/POST /api/edit/roles — the steward-owned `OrgUnitRole` vocabulary
 * editor (#2542 Phase 3, `lib/org-unit-roles.ts`). Read + update + CREATE.
 * There is no DELETE: the FK from `OrgUnitRoleAssignment` is `onDelete:
 * NoAction` and there is no holder-reassignment flow yet to make deleting a
 * vocabulary entry with live holders safe.
 *
 * PATCH updates one existing entry, identified by (`entityType`, `key`) in the
 * body. Only `label` / `sortOrder` / `profileTitle` are editable; the body may
 * carry no other top-level field — `roleGroup` / `scope` / `singleHolder` are
 * immutable by design (closed at creation) and `key` is matched on by NCI
 * reporting predicates (`deriveMembershipType`), so it can never be renamed
 * through this route at all.
 *
 * POST creates one new entry for a known unit kind. `key` is validated
 * lowercase snake_case and unique within its `entityType`; `source` is always
 * `"manual"` so a later reseed (`orgUnitRoleSeedRows`, `skipDuplicates: true`)
 * can never clobber it.
 *
 * Gate order, both handlers (mirrors `/api/edit/methods/families/tier`):
 *   (a) ORG_UNIT_ROLE_CONSOLE off  => 404 (whole surface dark)
 *   (b) no session                 => 401 (via the shared preamble)
 *   (c) not comms_steward/superuser => 403 (`not_comms_steward`, logged)
 * (c) runs BEFORE any field of the body is read — only the generic JSON parse
 * `readEditRequest` already did.
 *
 * Every write is one MySQL transaction with a `role_vocabulary_update` /
 * `role_vocabulary_create` B03 audit row, `targetEntityType: "org_unit_role"`,
 * `targetEntityId: "{entityType}:{key}"`. `actorCwid` is always `realCwid` —
 * never `session.cwid`, which aliases the impersonation target under "View as"
 * (`lib/edit/request.ts`) and would forge the row as the target.
 * `logEditDenial`'s `targetEntityType` cannot carry `org_unit_role` (it types
 * `UnitKind | "core"`), so denials are logged actor-only, exactly as the
 * Method-Family routes do.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { authorizeCommsStewardAction, logEditDenial } from "@/lib/edit/authz";
import { apiError } from "@/lib/api/error-response";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { isOrgUnitRoleConsoleEnabled } from "@/lib/edit/org-unit-role-flags";
import {
  DEFAULT_ORG_UNIT_ROLES,
  type OrgUnitRoleEntityType,
  type OrgUnitRoleGroup,
  type OrgUnitRoleScope,
} from "@/lib/org-unit-roles";

const PATH = "/api/edit/roles";

/** Every literal `OrgUnitRoleEntityType` value — sourced from the seed table's
 *  keys (the same five kinds `lib/org-unit-roles.ts` declares) rather than a
 *  second hardcoded list. */
function isOrgUnitRoleEntityType(value: unknown): value is OrgUnitRoleEntityType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(DEFAULT_ORG_UNIT_ROLES, value)
  );
}

const ROLE_GROUPS = ["leadership", "membership"] as const;
function isRoleGroup(value: unknown): value is OrgUnitRoleGroup {
  return typeof value === "string" && (ROLE_GROUPS as readonly string[]).includes(value);
}

const ROLE_SCOPES = ["unit", "program"] as const;
function isRoleScope(value: unknown): value is OrgUnitRoleScope {
  return typeof value === "string" && (ROLE_SCOPES as readonly string[]).includes(value);
}

// `key` is lowercase snake_case, starting with a letter. NOTE: the ticket asked
// for a max of 40 chars, but `OrgUnitRole.key` is `@db.VarChar(32)`
// (prisma/schema.prisma) — validating to 40 would let a 33-40 char key pass
// this check and then fail as a raw MySQL "Data too long for column" error
// instead of a clean 400. Capped at the real column width instead.
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_KEY_LENGTH = 32;
const MAX_LABEL_LENGTH = 255; // OrgUnitRole.label is @db.VarChar(255).
const MAX_SORT_ORDER = 9_999; // mirrors app/api/edit/center-program/route.ts.

function isValidSortOrder(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SORT_ORDER
  );
}

/** Prisma unique-constraint violation — the `(entityType, key)` collision backstop. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

// ---------------------------------------------------------------------------
// PATCH — update label / sortOrder / profileTitle on an existing entry.
// ---------------------------------------------------------------------------

const PATCH_FIELDS = new Set(["entityType", "key", "label", "sortOrder", "profileTitle"]);

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!isOrgUnitRoleConsoleEnabled()) return apiError("not_found", 404);

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const authz = authorizeCommsStewardAction(session);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  // `roleGroup` / `scope` / `singleHolder` are closed at creation and never
  // editable; `key` / `entityType` identify the row (used only in the WHERE
  // below, never written). Any other top-level field is a 400, not a silent
  // ignore — this is the enforcement point for "key is never edited."
  for (const field of Object.keys(body)) {
    if (!PATCH_FIELDS.has(field)) {
      return editError(400, "immutable_field", field);
    }
  }

  const { entityType, key, label, sortOrder, profileTitle } = body;
  if (!isOrgUnitRoleEntityType(entityType)) {
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (typeof key !== "string" || key.length === 0) {
    return editError(400, "invalid_key", "key");
  }

  const hasLabel = "label" in body;
  const hasSortOrder = "sortOrder" in body;
  const hasProfileTitle = "profileTitle" in body;
  if (!hasLabel && !hasSortOrder && !hasProfileTitle) {
    return editError(400, "no_fields_to_update");
  }

  let trimmedLabel = "";
  if (hasLabel) {
    if (typeof label !== "string") return editError(400, "invalid_label", "label");
    trimmedLabel = label.trim();
    if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LENGTH) {
      return editError(400, "invalid_label", "label");
    }
  }
  if (hasSortOrder && !isValidSortOrder(sortOrder)) {
    return editError(400, "invalid_sort_order", "sortOrder");
  }
  if (hasProfileTitle && typeof profileTitle !== "boolean") {
    return editError(400, "invalid_profile_title", "profileTitle");
  }

  const existing = await db.read.orgUnitRole.findUnique({
    where: { entityType_key: { entityType, key } },
  });
  if (!existing) return editError(404, "not_found");

  const data: { label?: string; sortOrder?: number; profileTitle?: boolean } = {};
  const beforeValues: Record<string, unknown> = {};
  const afterValues: Record<string, unknown> = {};
  if (hasLabel) {
    data.label = trimmedLabel;
    beforeValues.label = existing.label;
    afterValues.label = trimmedLabel;
  }
  if (hasSortOrder) {
    data.sortOrder = sortOrder as number;
    beforeValues.sortOrder = existing.sortOrder;
    afterValues.sortOrder = sortOrder;
  }
  if (hasProfileTitle) {
    data.profileTitle = profileTitle as boolean;
    beforeValues.profileTitle = existing.profileTitle;
    afterValues.profileTitle = profileTitle;
  }
  const fieldsChanged = Object.keys(data);

  try {
    await db.write.$transaction(async (tx) => {
      await tx.orgUnitRole.update({
        where: { entityType_key: { entityType, key } },
        data,
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "org_unit_role",
        targetEntityId: `${entityType}:${key}`,
        action: "role_vocabulary_update",
        fieldsChanged,
        beforeValues,
        afterValues,
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ entityType, key, ...afterValues });
}

// ---------------------------------------------------------------------------
// POST — create one new entry for a known unit kind.
// ---------------------------------------------------------------------------

const POST_FIELDS = new Set([
  "entityType",
  "key",
  "label",
  "roleGroup",
  "scope",
  "sortOrder",
  "singleHolder",
  "profileTitle",
]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isOrgUnitRoleConsoleEnabled()) return apiError("not_found", 404);

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const authz = authorizeCommsStewardAction(session);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  for (const field of Object.keys(body)) {
    if (!POST_FIELDS.has(field)) {
      return editError(400, "unexpected_field", field);
    }
  }

  const { entityType, key, label, roleGroup, scope, sortOrder, singleHolder, profileTitle } =
    body;

  if (!isOrgUnitRoleEntityType(entityType)) {
    return editError(400, "invalid_entity_type", "entityType");
  }
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    !KEY_PATTERN.test(key)
  ) {
    return editError(400, "invalid_key", "key");
  }
  if (typeof label !== "string") return editError(400, "invalid_label", "label");
  const trimmedLabel = label.trim();
  if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LENGTH) {
    return editError(400, "invalid_label", "label");
  }
  if (!isRoleGroup(roleGroup)) return editError(400, "invalid_role_group", "roleGroup");
  if (!isRoleScope(scope)) return editError(400, "invalid_scope", "scope");
  if (!isValidSortOrder(sortOrder)) {
    return editError(400, "invalid_sort_order", "sortOrder");
  }
  if (singleHolder !== undefined && typeof singleHolder !== "boolean") {
    return editError(400, "invalid_single_holder", "singleHolder");
  }
  if (profileTitle !== undefined && typeof profileTitle !== "boolean") {
    return editError(400, "invalid_profile_title", "profileTitle");
  }

  const resolvedSingleHolder = singleHolder ?? false;
  // Matches the seed convention (`lib/org-unit-roles.ts`): a title on the
  // profile for leading a unit, never for merely belonging to one.
  const resolvedProfileTitle = profileTitle ?? roleGroup === "leadership";

  const existing = await db.read.orgUnitRole.findUnique({
    where: { entityType_key: { entityType, key } },
    select: { key: true },
  });
  if (existing) return editError(409, "key_collision", "key");

  try {
    await db.write.$transaction(async (tx) => {
      await tx.orgUnitRole.create({
        data: {
          entityType,
          key,
          label: trimmedLabel,
          roleGroup,
          scope,
          singleHolder: resolvedSingleHolder,
          sortOrder,
          profileTitle: resolvedProfileTitle,
          source: "manual",
        },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "org_unit_role",
        targetEntityId: `${entityType}:${key}`,
        action: "role_vocabulary_create",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          label: trimmedLabel,
          roleGroup,
          scope,
          singleHolder: resolvedSingleHolder,
          sortOrder,
          profileTitle: resolvedProfileTitle,
          source: "manual",
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return editError(409, "key_collision", "key");
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({
    entityType,
    key,
    label: trimmedLabel,
    roleGroup,
    scope,
    singleHolder: resolvedSingleHolder,
    sortOrder,
    profileTitle: resolvedProfileTitle,
    source: "manual",
  });
}
