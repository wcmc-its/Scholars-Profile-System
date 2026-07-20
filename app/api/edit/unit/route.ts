/**
 * POST /api/edit/unit — create a new unit, or update a Center in-row.
 * #540 Phase 5b (SPEC § /api/edit/* and § Manual unit creation).
 *
 * Two operations:
 *
 *  - **`op: "create"`** — create a new manually-owned subunit. Two flavors:
 *    - **Informal center** (default; `unitType: "center"` with no `code`):
 *      mints a synthetic `code` (`man-<hex>`) on the `Center` table with
 *      `source='manual'`. Authz: `ownerOf(deptCode)` OR Superuser (SPEC
 *      line 213). The `deptCode` carried in the body is the parent dept
 *      whose Owner this is — it does NOT persist on the Center row (no FK),
 *      but is the authz key.
 *    - **Coded division** (`unitType: "division"` with a real LDAP `code`):
 *      Superuser-only (SPEC line 214 — structural; a wrong code is
 *      permanently unadoptable; audit query C is the back-office guard).
 *      Inserts into `Division` with `source='manual'`, the supplied N-code,
 *      and the named parent `deptCode`.
 *
 *  - **`op: "update"`** — update a `Center` in-row (centers do NOT use
 *    `field_override`; they edit in place). Field-level authz: `description`
 *    / `url` (#1021) / `directorCwid` / `leaderInterim` are Curator/Owner-
 *    editable; `slug` and `centerType` are Superuser-only (SPEC § Authorization).
 *
 * Every write is one MySQL transaction with the B03 audit row. Post-commit
 * reflection: `reflectUnitChange` on the unit page + `/browse`.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canEditUnit,
  canManageAccess,
  getEffectiveUnitRole,
  logEditDenial,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import { mintSyntheticUnitCode } from "@/lib/edit/mint-code";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectUnitChange } from "@/lib/edit/revalidation";
import { isOrgUnitCreateSuperuserOnly } from "@/lib/edit/unit-create-flags";
import {
  checkUnitSlugAvailable,
  findUnit,
  isCenterType,
  validateLdapCode,
  validateSlugFormat,
  validateUnitDescription,
  validateUnitLeaderCwid,
  validateUnitLeaderInterim,
  validateUnitName,
  validateUnitUrl,
} from "@/lib/edit/validators";

const PATH = "/api/edit/unit";

/** The set of Center fields a per-field update touches. */
const CENTER_UPDATE_FIELDS = [
  "name",
  "description",
  "url",
  "slug",
  "directorCwid",
  "leaderInterim",
  "centerType",
] as const;
type CenterUpdateField = (typeof CENTER_UPDATE_FIELDS)[number];

function isCenterUpdateField(value: string): value is CenterUpdateField {
  return (CENTER_UPDATE_FIELDS as readonly string[]).includes(value);
}

/** Structural Center fields — Superuser-only (SPEC § Authorization).
 *
 *  `name` is deliberately NOT here. A rename is content curation, not structure:
 *  it moves no URL (the slug is edited separately and stays stable across
 *  renames) and breaks no link. It therefore rides the normal `canEditUnit`
 *  path — Superuser, comms_steward, Owner, or Curator — which is what lets the
 *  comms office action a name change without a code deploy. */
const CENTER_STRUCTURAL_FIELDS: ReadonlySet<CenterUpdateField> = new Set([
  "slug",
  "centerType",
]);

/** The only field a manually-created Division exposes to a per-field update.
 *
 *  Ownership, not entity kind, is the boundary: a unit whose name SPS owns is
 *  renamable here, and an ED-sourced one is not (its `name` is the directory's
 *  and the next `etl/ed` run would clobber any edit). Same predicate the roster
 *  route gates on (`division.source !== "manual"` → 400) and the same one
 *  `unit-edit-context` uses for `hasRoster`. Divisions carry no
 *  `officialName`/`compactName` columns, so `name` is the whole surface. */
const DIVISION_UPDATE_FIELDS = ["name"] as const;
type DivisionUpdateField = (typeof DIVISION_UPDATE_FIELDS)[number];

function isDivisionUpdateField(value: string): value is DivisionUpdateField {
  return (DIVISION_UPDATE_FIELDS as readonly string[]).includes(value);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { op } = body;
  if (op === "create") return handleCreate(session, realCwid, impersonatedCwid, body, requestId);
  if (op === "update") return handleUpdate(session, realCwid, impersonatedCwid, body, requestId);
  return editError(400, "invalid_op", "op");
}

// ---------------------------------------------------------------------------
// op:"create"
// ---------------------------------------------------------------------------

async function handleCreate(
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean },
  realCwid: string,
  impersonatedCwid: string | null,
  body: Record<string, unknown>,
  requestId: string | null,
): Promise<NextResponse> {
  const { unitType, name, slug, deptCode, code, centerType } = body;

  if (unitType !== "center" && unitType !== "division") {
    return editError(400, "invalid_unit_type", "unitType");
  }
  if (typeof name !== "string") {
    return editError(400, "invalid_name", "name");
  }
  const nameResult = validateUnitName(name);
  if (!nameResult.ok) return editError(400, nameResult.error, "name");

  if (typeof slug !== "string") {
    return editError(400, "invalid_slug", "slug");
  }
  const slugResult = validateSlugFormat(slug);
  if (!slugResult.ok) return editError(400, slugResult.error, "slug");

  if (typeof deptCode !== "string" || deptCode.length === 0) {
    return editError(400, "invalid_dept_code", "deptCode");
  }

  // Parent dept must exist — a 400 precedes any authz check.
  const parentDept = await db.read.department.findUnique({
    where: { code: deptCode },
    select: { code: true, slug: true },
  });
  if (!parentDept) return editError(400, "dept_not_found", "deptCode");

  if (unitType === "center") {
    return createInformalCenter({
      session,
      realCwid,
      impersonatedCwid,
      requestId,
      name: nameResult.value,
      slug: slugResult.value,
      deptCode,
      centerType,
    });
  }
  return createCodedDivision({
    session,
    realCwid,
    impersonatedCwid,
    requestId,
    name: nameResult.value,
    slug: slugResult.value,
    deptCode,
    parentDeptSlug: parentDept.slug,
    code,
  });
}

async function createInformalCenter(params: {
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean };
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  name: string;
  slug: string;
  deptCode: string;
  centerType: unknown;
}): Promise<NextResponse> {
  const { session, realCwid, impersonatedCwid, requestId, name, slug, deptCode, centerType } =
    params;

  // centerType is optional; default "center". Reject anything other than the
  // allowlist so an institute (Superuser-only structural field) can't be
  // smuggled in by an Owner.
  let centerTypeValue: "center" | "institute" = "center";
  if (centerType !== undefined) {
    if (typeof centerType !== "string" || !isCenterType(centerType)) {
      return editError(400, "invalid_center_type", "centerType");
    }
    if (centerType === "institute" && !session.isSuperuser) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: deptCode,
        path: PATH,
        reason: "not_superuser",
        targetEntityType: "department",
        targetEntityId: deptCode,
      });
      return editError(403, "not_superuser");
    }
    centerTypeValue = centerType;
  }

  // Authz. By default (flag off): Owner of the named parent dept, or Superuser
  // (SPEC line 213). With `SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY="on"` (#728
  // Phase D § 4.5): superuser-only, mirroring the institute carve-out above —
  // all org-unit creation becomes superuser-only. The lockdown is the explicit
  // requirement; the flag keeps the Owner-create behavior change opt-in (OQ-8a).
  if (isOrgUnitCreateSuperuserOnly()) {
    if (!session.isSuperuser) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: deptCode,
        path: PATH,
        reason: "not_superuser",
        targetEntityType: "department",
        targetEntityId: deptCode,
      });
      return editError(403, "not_superuser");
    }
  } else {
    const effective = await getEffectiveUnitRole(
      session,
      { kind: "department", code: deptCode },
      db.read as unknown as UnitAdminLookup,
    );
    const authz = canManageAccess(session, effective);
    if (!authz.ok) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: deptCode,
        path: PATH,
        reason: authz.reason,
        targetEntityType: "department",
        targetEntityId: deptCode,
      });
      return editError(403, authz.reason);
    }
  }

  // Slug uniqueness — friendly check; the `Center.slug @unique` is the
  // atomic backstop on a concurrent duplicate.
  const slugCheck = await checkUnitSlugAvailable(
    { kind: "center", slug },
    db.read,
  );
  if (!slugCheck.ok) return editError(400, slugCheck.error, "slug");

  // Mint a synthetic code; retry on the (rare) collision against the @id.
  let mintedCode = "";
  let createdId = "";
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = mintSyntheticUnitCode();
      const collision = await db.read.center.findUnique({
        where: { code: candidate },
        select: { code: true },
      });
      if (!collision) {
        mintedCode = candidate;
        break;
      }
    }
    if (mintedCode === "") {
      return editError(500, "code_mint_failed");
    }
    await db.write.$transaction(async (tx) => {
      const created = await tx.center.create({
        data: {
          code: mintedCode,
          name,
          slug,
          centerType: centerTypeValue,
          source: "manual",
        },
        select: { code: true },
      });
      createdId = created.code;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center",
        targetEntityId: created.code,
        action: "unit_create",
        fieldsChanged: ["name", "slug", "centerType"],
        beforeValues: null,
        afterValues: {
          unit_type: "center",
          dept_code: deptCode,
          name,
          slug,
          center_type: centerTypeValue,
          source: "manual",
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectUnitChange({ unitKind: "center", unitSlug: slug });
  return editOk({ code: createdId, slug });
}

async function createCodedDivision(params: {
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean };
  realCwid: string;
  impersonatedCwid: string | null;
  requestId: string | null;
  name: string;
  slug: string;
  deptCode: string;
  parentDeptSlug: string;
  code: unknown;
}): Promise<NextResponse> {
  const {
    session,
    realCwid,
    impersonatedCwid,
    requestId,
    name,
    slug,
    deptCode,
    parentDeptSlug,
    code,
  } = params;

  // Superuser-only (SPEC line 214 — structural). The check runs before the
  // code-format validation so a non-superuser cannot probe for collisions.
  if (!session.isSuperuser) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: deptCode,
      path: PATH,
      reason: "not_superuser",
      targetEntityType: "division",
      targetEntityId: typeof code === "string" ? code : deptCode,
    });
    return editError(403, "not_superuser");
  }

  if (typeof code !== "string") {
    return editError(400, "invalid_code", "code");
  }
  const codeResult = validateLdapCode(code);
  if (!codeResult.ok) return editError(400, codeResult.error, "code");

  // Code must not collide with an existing division (Division.code @id).
  const collision = await db.read.division.findUnique({
    where: { code: codeResult.value },
    select: { code: true },
  });
  if (collision) return editError(400, "code_taken", "code");

  // Slug uniqueness within the parent dept.
  const slugCheck = await checkUnitSlugAvailable(
    { kind: "division", slug, deptCode },
    db.read,
  );
  if (!slugCheck.ok) return editError(400, slugCheck.error, "slug");

  let createdCode = "";
  try {
    await db.write.$transaction(async (tx) => {
      const created = await tx.division.create({
        data: {
          code: codeResult.value,
          deptCode,
          name,
          slug,
          source: "manual",
        },
        select: { code: true },
      });
      createdCode = created.code;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "division",
        targetEntityId: created.code,
        action: "unit_create",
        fieldsChanged: ["name", "slug"],
        beforeValues: null,
        afterValues: {
          unit_type: "division",
          dept_code: deptCode,
          name,
          slug,
          source: "manual",
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectUnitChange({
    unitKind: "division",
    unitSlug: slug,
    parentDeptSlug,
  });
  return editOk({ code: createdCode, slug });
}

// ---------------------------------------------------------------------------
// op:"update"  (Center in-row edits)
// ---------------------------------------------------------------------------

async function handleUpdate(
  session: { cwid: string; isSuperuser: boolean; isCommsSteward: boolean },
  realCwid: string,
  impersonatedCwid: string | null,
  body: Record<string, unknown>,
  requestId: string | null,
): Promise<NextResponse> {
  const { entityType, entityId, fieldName, value } = body;

  // op:"update" writes unit COLUMNS, so it serves the units whose columns SPS
  // owns: centers (always manual) and manually-created divisions (`name` only).
  // Departments — and ED-sourced divisions — keep their directory-derived
  // values and route through /api/edit/field with a `field_override` row.
  if (entityType !== "center" && entityType !== "division") {
    return editError(400, "invalid_entity_type", "entityType");
  }
  const isDivision = entityType === "division";
  if (typeof entityId !== "string" || entityId.length === 0) {
    return editError(400, "invalid_entity_id", "entityId");
  }
  if (
    typeof fieldName !== "string" ||
    (isDivision ? !isDivisionUpdateField(fieldName) : !isCenterUpdateField(fieldName))
  ) {
    return editError(400, "invalid_field", "fieldName");
  }

  // Unit existence — 400 precedes 403.
  const unit = await findUnit(entityType, entityId, db.read);
  if (!unit.ok) return editError(400, "unit_not_found", "entityId");

  // An ED-sourced division's name belongs to the directory: the next etl/ed run
  // would overwrite anything written here, so refuse rather than accept an edit
  // that silently reverts overnight.
  if (isDivision) {
    const div = await db.read.division.findUnique({
      where: { code: entityId },
      select: { source: true },
    });
    if (div?.source !== "manual") {
      return editError(400, "unit_not_manual", "entityId");
    }
  }

  // Authz: structural fields are Superuser-only; everything else is
  // Curator/Owner of the center (no cascade — centers have no parent), or of
  // the division (which DOES cascade from its parent department).
  if (!isDivision && CENTER_STRUCTURAL_FIELDS.has(fieldName as CenterUpdateField)) {
    if (!session.isSuperuser) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: entityId,
        path: PATH,
        reason: "not_superuser",
        targetEntityType: entityType,
        targetEntityId: entityId,
      });
      return editError(403, "not_superuser");
    }
  } else {
    const effective = await getEffectiveUnitRole(
      session,
      unit.kind === "division"
        ? { kind: "division", code: entityId, parentDeptCode: unit.parentDeptCode }
        : { kind: "center", code: entityId },
      db.read as unknown as UnitAdminLookup,
    );
    const authz = canEditUnit(session, effective);
    if (!authz.ok) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: entityId,
        path: PATH,
        reason: authz.reason,
        targetEntityType: entityType,
        targetEntityId: entityId,
      });
      return editError(403, authz.reason);
    }
  }

  // Per-field validation + the column-mapped update payload.
  if (typeof value !== "string") {
    return editError(400, "invalid_value", "value");
  }
  let updatePayload: Record<string, unknown>;
  let storedValue: string | boolean;
  if (fieldName === "name") {
    const r = validateUnitName(value);
    if (!r.ok) return editError(400, r.error, "value");
    storedValue = r.value;
    // Non-nullable column — unlike description/url, "" is a validation error
    // (`invalid_name`), not a clear.
    updatePayload = { name: r.value };
  } else if (fieldName === "description") {
    const r = validateUnitDescription(value);
    if (!r.ok) return editError(400, r.error, "value");
    storedValue = r.value;
    updatePayload = { description: r.value === "" ? null : r.value };
  } else if (fieldName === "url") {
    const r = validateUnitUrl(value);
    if (!r.ok) return editError(400, r.error, "value");
    storedValue = r.value;
    // "" = curator cleared the link → null on the column (mirrors description).
    updatePayload = { url: r.value === "" ? null : r.value };
  } else if (fieldName === "slug") {
    const r = validateSlugFormat(value);
    if (!r.ok) return editError(400, r.error, "value");
    const conflict = await checkUnitSlugAvailable(
      { kind: "center", slug: r.value, excludeCode: entityId },
      db.read,
    );
    if (!conflict.ok) return editError(400, conflict.error, "value");
    storedValue = r.value;
    updatePayload = { slug: r.value };
  } else if (fieldName === "directorCwid") {
    const r = validateUnitLeaderCwid(value);
    if (!r.ok) return editError(400, r.error, "value");
    storedValue = r.value;
    // "" = explicit vacancy → null on the column (centers don't have a
    // three-state read-merge — the column is the only source).
    updatePayload = { directorCwid: r.value === "" ? null : r.value };
  } else if (fieldName === "leaderInterim") {
    const r = validateUnitLeaderInterim(value);
    if (!r.ok) return editError(400, r.error, "value");
    storedValue = r.value === "true";
    updatePayload = { leaderInterim: storedValue };
  } else {
    // centerType — Superuser-only, allowlist already validated indirectly
    // (the field name dispatches; the value still needs the enum check).
    if (!isCenterType(value)) {
      return editError(400, "invalid_center_type", "value");
    }
    storedValue = value;
    updatePayload = { centerType: value };
  }

  // Write — in-row update + B03 audit row, one transaction.
  try {
    await db.write.$transaction(async (tx) => {
      if (isDivision) {
        // `name` is the only division field here, so the before-snapshot is
        // one column and needs no field dispatch.
        const beforeDiv = await tx.division.findUnique({
          where: { code: entityId },
          select: { name: true },
        });
        await tx.division.update({ where: { code: entityId }, data: updatePayload });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "division",
          targetEntityId: entityId,
          action: "field_override",
          fieldsChanged: [fieldName],
          beforeValues: { [fieldName]: beforeDiv?.name ?? null },
          afterValues: { [fieldName]: storedValue },
          ts: new Date(),
          requestId,
        });
        return;
      }
      const before = await tx.center.findUnique({
        where: { code: entityId },
        select: {
          name: true,
          slug: true,
          description: true,
          url: true,
          directorCwid: true,
          leaderInterim: true,
          centerType: true,
        },
      });
      await tx.center.update({
        where: { code: entityId },
        data: updatePayload,
      });
      const beforeValue =
        fieldName === "name"
          ? before?.name
          : fieldName === "slug"
          ? before?.slug
          : fieldName === "description"
            ? before?.description
            : fieldName === "url"
              ? before?.url
              : fieldName === "directorCwid"
                ? before?.directorCwid
                : fieldName === "leaderInterim"
                  ? before?.leaderInterim
                  : before?.centerType;
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: entityType,
        targetEntityId: entityId,
        // `field_override` action — semantic stretch for centers (no
        // `field_override` row exists), but the audit's manifest of edits
        // is the same shape. SPEC § Audit queries D explicitly notes the
        // center curation history is the audit log alone.
        action: "field_override",
        fieldsChanged: [fieldName],
        beforeValues: { [fieldName]: beforeValue ?? null },
        afterValues: { [fieldName]: storedValue },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  // Post-commit reflection. A slug change flips the URL immediately
  // (Center.slug is the column; no ETL lag), so the previous slug page
  // needs busting too.
  if (unit.kind === "division") {
    // A rename moves no URL, so there is no previous slug to bust — but the
    // parent dept page lists the division by name and must refresh too.
    await reflectUnitChange({
      unitKind: "division",
      unitSlug: unit.slug,
      parentDeptSlug: unit.parentDeptSlug ?? undefined,
    });
  } else {
    await reflectUnitChange({
      unitKind: "center",
      unitSlug: fieldName === "slug" ? (storedValue as string) : unit.slug,
      previousSlug: fieldName === "slug" ? unit.slug : null,
    });
  }

  return editOk({ fieldName, value: storedValue });
}
