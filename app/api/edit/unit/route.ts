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
 *      but is the authz key. Being ONLY an authz key, it is optional for a
 *      Superuser (#2541): nothing admits them by department, so a
 *      cross-campus center is created with none and audits `dept_code: null`.
 *      It stays required for a non-Superuser (it is what admits them), and
 *      for a division (a real NOT NULL FK). A non-Superuser creator is also
 *      seeded as Owner of the new center in the same transaction (#2544) —
 *      centers never cascade, so without that row the creator would hold no
 *      role on the center they just made.
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
import { CENTER_ENTITY_TYPE, DIRECTOR_ROLE_KEY, orgUnitRoleSeedRows } from "@/lib/org-unit-roles";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  canEditUnit,
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

/** The `edit_authz_denied` target when a create carries no parent dept (#2541).
 *  One constant for both keys, so the denial stream shows a single target for
 *  the condition rather than two spellings of the same absence. */
const NO_PARENT_DEPT_TARGET = "new-unit";

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

  // Omitting `deptCode` (absent or `null`) is allowed only for a Superuser
  // creating a center, where it is an authz key nobody needs (#2541). A
  // supplied value is validated exactly as before — "" or a non-string still
  // 400s, so a mistyped code can't be smuggled past the existence check below.
  let parentDeptCode: string | null = null;
  if (deptCode === undefined || deptCode === null) {
    if (unitType !== "center" || !session.isSuperuser) {
      return editError(400, "invalid_dept_code", "deptCode");
    }
  } else if (typeof deptCode !== "string" || deptCode.length === 0) {
    return editError(400, "invalid_dept_code", "deptCode");
  } else {
    parentDeptCode = deptCode;
  }

  // A supplied parent dept must exist — a 400 precedes any authz check.
  const parentDept =
    parentDeptCode === null
      ? null
      : await db.read.department.findUnique({
          where: { code: parentDeptCode },
          select: { code: true, slug: true },
        });
  if (parentDeptCode !== null && !parentDept) return editError(400, "dept_not_found", "deptCode");

  if (unitType === "center") {
    return createInformalCenter({
      session,
      realCwid,
      impersonatedCwid,
      requestId,
      name: nameResult.value,
      slug: slugResult.value,
      deptCode: parentDeptCode,
      centerType,
    });
  }
  // A division's `deptCode` is a real NOT NULL FK, so it is required for
  // everyone — the guard above already refused an omission here; this only
  // narrows the two values for tsc.
  if (parentDeptCode === null || parentDept === null) {
    return editError(400, "invalid_dept_code", "deptCode");
  }
  return createCodedDivision({
    session,
    realCwid,
    impersonatedCwid,
    requestId,
    name: nameResult.value,
    slug: slugResult.value,
    deptCode: parentDeptCode,
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
  /** The parent dept whose Owner this is — an authz key, never a stored parent
   *  (`Center` has no parent column). `null` = a Superuser created a center
   *  scoped to no department (#2541). */
  deptCode: string | null;
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
        targetCwid: deptCode ?? NO_PARENT_DEPT_TARGET,
        path: PATH,
        reason: "not_superuser",
        targetEntityType: "department",
        targetEntityId: deptCode ?? NO_PARENT_DEPT_TARGET,
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
        targetCwid: deptCode ?? NO_PARENT_DEPT_TARGET,
        path: PATH,
        reason: "not_superuser",
        targetEntityType: "department",
        targetEntityId: deptCode ?? NO_PARENT_DEPT_TARGET,
      });
      return editError(403, "not_superuser");
    }
  } else {
    // No parent dept means no ownership to inherit, so only the Superuser arm
    // of the predicate below can pass — which is exactly the #2541 contract.
    const effective =
      deptCode === null
        ? "none"
        : await getEffectiveUnitRole(
            session,
            { kind: "department", code: deptCode },
            db.read as unknown as UnitAdminLookup,
          );
    // Deliberately NOT `canManageAccess` — that predicate now also admits a
    // comms_steward (2026-08-26 policy widening, decision #3, scoped to
    // granting/revoking `unit_admin` rows), but org-unit CREATE stays
    // excluded from steward parity (`comms-steward-profile-editing-spec.md`
    // §3b: "adding/remove org units"). Inlined equivalent of the
    // pre-widening Owner-or-Superuser check.
    const authz: { ok: true } | { ok: false; reason: "not_unit_owner" } =
      session.isSuperuser || effective === "owner"
        ? { ok: true }
        : { ok: false, reason: "not_unit_owner" };
    if (!authz.ok) {
      logEditDenial({
        actorCwid: session.cwid,
        targetCwid: deptCode ?? NO_PARENT_DEPT_TARGET,
        path: PATH,
        reason: authz.reason,
        targetEntityType: "department",
        targetEntityId: deptCode ?? NO_PARENT_DEPT_TARGET,
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
          // #2542 Phase 1 — seed the default role vocabulary with the center, in
          // the same transaction. A center created without it has no `director`
          // key for a leadership assignment to reference, so its leadership
          // editor would FK-error forever.
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
          // Nullable (#2541): `null` records that a Superuser scoped this
          // center to no department. It is a key inside the `after_values`
          // JSON, not a column, and nothing reads it back — audit query C
          // (`scripts/backfills/audit-unit-curation.ts`) lists manual units
          // straight off `center`/`division`, never this row.
          dept_code: deptCode,
          name,
          slug,
          center_type: centerTypeValue,
          source: "manual",
        },
        ts: new Date(),
        requestId,
      });
      // Seed the creator as Owner of the center they just made (#2544).
      // `getEffectiveUnitRole` cascades to a parent department for DIVISIONS
      // only, and a Center has no parent column — so without this row a
      // non-Superuser Owner holds no role on their own center: they cannot
      // edit it, add members, or even self-grant (POST /api/edit/grant builds
      // `{kind:"center", code}`, gets `none` back, and 403s). The center would
      // be Superuser-only from the instant it existed.
      //
      // Superusers are excluded deliberately: they already pass every check
      // without a row, so minting one would only add noise to the
      // Administrators roster.
      if (!session.isSuperuser) {
        await tx.unitAdmin.create({
          data: {
            entityType: "center",
            entityId: created.code,
            cwid: session.cwid,
            role: "owner",
            grantedBy: session.cwid,
          },
        });
        // Second audit row, same transaction, mirroring /api/edit/grant's
        // shape — the grant is a real `unit_admin` write and the audit log is
        // the only history that table keeps.
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "center",
          targetEntityId: created.code,
          action: "grant_change",
          fieldsChanged: null,
          beforeValues: null,
          afterValues: { cwid: session.cwid, role: "owner", granted_by: session.cwid },
          ts: new Date(),
          requestId,
        });
      }
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
  // #2542 Phase 1 — `directorCwid` / `leaderInterim` no longer map to a center
  // column; they move the `director` assignment in `CenterLeader`, and
  // DUAL-WRITE the deprecated columns for one release.
  // The REQUEST contract is unchanged (same two field names, same two POSTs
  // from `unit-leader-card.tsx`, same `field_override` audit action and
  // `fieldsChanged` label), so only the storage moves — which is what keeps the
  // pre-#2542 center curation history queryable by the same key.
  let leadershipWrite: { setCwid: string | null } | { setInterim: boolean } | null = null;
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
    // "" = explicit vacancy — under #2542 that means dropping the `director`
    // assignment. DUAL-WRITTEN to the deprecated column for one release so the
    // pre-backfill fallback and an app-code rollback both stay correct.
    leadershipWrite = { setCwid: r.value === "" ? null : r.value };
    updatePayload = { directorCwid: r.value === "" ? null : r.value };
  } else if (fieldName === "leaderInterim") {
    const r = validateUnitLeaderInterim(value);
    if (!r.ok) return editError(400, r.error, "value");
    storedValue = r.value === "true";
    leadershipWrite = { setInterim: storedValue };
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
          centerType: true,
          // Dual-read fallback for the audit before-value: pre-backfill there is
          // no `CenterLeader` row yet. Goes with the column in the contract PR.
          directorCwid: true,
          leaderInterim: true,
        },
      });
      // #2542 — the current `director` assignment. Dual-read: pre-backfill
      // there is no CenterLeader row yet, so fall back to the column.
      const beforeLeader = await tx.orgUnitRoleAssignment.findFirst({
        where: { entityType: CENTER_ENTITY_TYPE, entityId, roleKey: DIRECTOR_ROLE_KEY },
        select: { cwid: true, interim: true },
        orderBy: { sortOrder: "asc" },
      });
      const beforeDirectorCwid = beforeLeader?.cwid ?? before?.directorCwid ?? null;
      const beforeInterim = beforeLeader?.interim ?? before?.leaderInterim ?? false;

      if (Object.keys(updatePayload).length > 0) {
        await tx.center.update({
          where: { code: entityId },
          data: updatePayload,
        });
      }
      if (leadershipWrite) {
        // The 11 pre-existing centers have no vocabulary until the Phase 1
        // backfill runs, and `center_leader.role_key` FKs to it — so seed this
        // center's defaults first. Idempotent (`skipDuplicates`), never
        // clobbers a renamed label, and removes the ordering dependency between
        // the deploy and the backfill entirely.
        await tx.orgUnitRole.createMany({
          data: orgUnitRoleSeedRows(CENTER_ENTITY_TYPE),
          skipDuplicates: true,
        });
      }
      if (leadershipWrite && "setCwid" in leadershipWrite) {
        // One `director` at a time: vacate whoever holds it, then grant.
        // `deleteMany` also covers the pre-backfill case of no row at all.
        await tx.orgUnitRoleAssignment.deleteMany({
          where: { entityType: CENTER_ENTITY_TYPE, entityId, roleKey: DIRECTOR_ROLE_KEY },
        });
        if (leadershipWrite.setCwid !== null) {
          // The interim qualifier rides with the ROLE, not the person —
          // `Center.leaderInterim` was a separate column that survived a
          // director change, so carry it onto the new holder.
          await tx.orgUnitRoleAssignment.create({
            data: {
              entityType: CENTER_ENTITY_TYPE,
              entityId,
              cwid: leadershipWrite.setCwid,
              roleKey: DIRECTOR_ROLE_KEY,
              interim: beforeInterim,
            },
          });
        }
      } else if (leadershipWrite && "setInterim" in leadershipWrite) {
        // No director => nothing to qualify, and `updateMany` is a clean no-op.
        // `unit-leader-card.tsx` always POSTs the cwid before the interim flag,
        // so on a real save the row exists by now. The column dual-write above
        // still records it either way.
        await tx.orgUnitRoleAssignment.updateMany({
          where: { entityType: CENTER_ENTITY_TYPE, entityId, roleKey: DIRECTOR_ROLE_KEY },
          data: { interim: leadershipWrite.setInterim },
        });
      }
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
                ? beforeDirectorCwid
                : fieldName === "leaderInterim"
                  ? beforeInterim
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
