/**
 * POST /api/edit/method-service — a unit's method services (`method_service`):
 * a service (name + https link) a department or a core offers for one or more
 * method families. Body: `{ op: "create" | "update" | "delete", ... }`.
 *
 *   - create: `{ entityType, entityId, name, url, families, supportedPmids?,
 *     countStaffPapers? }`. `countStaffPapers` defaults to true for a core and
 *     false for a department.
 *   - update: `{ id, name?, url?, families?, supportedPmids?, excludedPmids?,
 *     countStaffPapers? }`. Only the fields present are changed. The owning
 *     unit of a row never changes: `entityType` / `entityId` in an update body
 *     are ignored.
 *   - delete: `{ id }`. Hard delete; the history is the audit log.
 *   - exclude: `{ id, pmid }`. "Not ours": adds one PMID to `excludedPmids`,
 *     which takes it off the unit's count, filter and badge on the method page.
 *   - restore: `{ id, pmid }`. The undo: removes it from `excludedPmids`.
 *     Both re-read the list inside the write's transaction under the row's
 *     lock (`SELECT ... FOR UPDATE`), so neither a stale editor nor a second
 *     request at the same moment can overwrite it, and both are a no-op
 *     (`changed: false`, no audit row) when the list already says so.
 *
 * GET /api/edit/method-service?id=<id> — the numbers under a saved service and
 * its "Review publications" list (`loadServiceReview`): `{ ok: true, review }`.
 * Read-only, so no audit row, but gated exactly as a write is: the same
 * identity (observer and content-editor views stripped) and the same unit
 * predicates, against the stored row. Always `no-store`.
 *
 * Authorization is the owning unit's own, the same predicates its edit page
 * and sibling routes use:
 *   - department: `getEffectiveUnitRole` + `canEditUnit` (Owner / Curator,
 *     Superuser, comms_steward, content editor), as `/api/edit/unit-leadership`;
 *   - core: `getCoreOwnerRole` + `authorizeCoreClaim` (Owner / Curator, Cores
 *     director, Superuser, comms_steward, content editor), as `/api/edit/core`.
 * For update and delete the unit is the STORED row's, never the body's. Any
 * other `entityType` is a 400; a unit that does not exist is a 404.
 *
 * Every family must be a real, publicly visible method family
 * (`findNonPublicFamilies`: a `scholar_family` row + the overlay gate a method
 * page uses), else 400 `unknown_family`.
 *
 * Each write is one MySQL transaction with a B03 audit row: `roster_change`
 * on the unit (`targetEntityType` "department" | "core", `targetEntityId` the
 * unit code / core id), `fieldsChanged: ["method_services"]`, before / after
 * the service row. PMID lists are summarised: see `auditShape`.
 *
 * The saved row is returned from the write itself. The public method page
 * reads services through a short-lived cache (`loadFamilyServiceCollaborations`),
 * which every write here clears (`bustMethodServiceCache`, on this task and,
 * by the shared signal, the others); the page and its feed route are
 * `force-dynamic`, so there is nothing else to revalidate. The section
 * refreshes its own edit page. 404 while
 * `isMethodServicesEnabled()` is false.
 */
import { NextResponse, type NextRequest } from "next/server";

import { bustMethodServiceCache } from "@/lib/api/method-service-collaborations";
import { loadServiceReview } from "@/lib/api/method-service-review";
import {
  METHOD_SERVICE_SELECT,
  findNonPublicFamilies,
  toMethodServiceView,
  type MethodServiceRow,
} from "@/lib/api/method-services";
import { stripContentEditorView, stripObserverView } from "@/lib/auth/observer-view";
import type { EditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import {
  authorizeCoreClaim,
  canEditUnit,
  getCoreOwnerRole,
  getEffectiveUnitRole,
  logEditDenial,
  type AuthzResult,
  type CoreOwnerLookup,
  type UnitAdminLookup,
} from "@/lib/edit/authz";
import {
  editError,
  editOk,
  logEditFailure,
  readEditRequest,
  resolveEditIdentity,
} from "@/lib/edit/request";
import { isMethodServicesEnabled } from "@/lib/method-services/flags";
import {
  SERVICE_PMIDS_MAX,
  defaultCountStaffPapers,
  isMethodServiceEntityType,
  methodFamilyKey,
  validatePmidList,
  validateServiceFamilies,
  validateServiceName,
  validateServiceUrl,
  type MethodServiceEntityType,
  type MethodServiceFamily,
} from "@/lib/method-services/validation";

const PATH = "/api/edit/method-service";
const OPS = ["create", "update", "delete", "exclude", "restore"] as const;
type Op = (typeof OPS)[number];
/** 5000 PMIDs is about 60 KB of JSON, right at `readEditRequest`'s default cap. */
const MAX_BODY_BYTES = 256 * 1024;
/** A PMID list this short is written to the audit row in full; a longer one is
 *  recorded as its count only. */
const AUDIT_PMID_LIST_MAX = 100;

/**
 * The service as the audit row records it. The two PMID lists can each hold
 * thousands of entries, and an audit row is immutable and hashed, so a list of
 * more than {@link AUDIT_PMID_LIST_MAX} PMIDs is recorded as its count alone;
 * a shorter one is kept in full beside the count.
 */
function auditShape(row: MethodServiceRow): Record<string, unknown> {
  const view = toMethodServiceView(row);
  const supported = view?.supportedPmids ?? [];
  const excluded = view?.excludedPmids ?? [];
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    families: view?.families ?? [],
    countStaffPapers: row.countStaffPapers,
    supportedPmidCount: supported.length,
    ...(supported.length <= AUDIT_PMID_LIST_MAX ? { supportedPmids: supported } : {}),
    excludedPmidCount: excluded.length,
    ...(excluded.length <= AUDIT_PMID_LIST_MAX ? { excludedPmids: excluded } : {}),
  };
}

/** Shared gate: the unit exists (404) and the caller may edit it (403).
 *  Returns a response to send, or `null` to proceed. */
async function gate(
  session: EditSession,
  entityType: MethodServiceEntityType,
  entityId: string,
): Promise<NextResponse | null> {
  let authz: AuthzResult;
  if (entityType === "department") {
    const department = await db.read.department.findUnique({
      where: { code: entityId },
      select: { code: true },
    });
    if (!department) return editError(404, "unit_not_found", "entityId");
    const role = await getEffectiveUnitRole(
      session,
      { kind: "department", code: entityId },
      db.read as unknown as UnitAdminLookup,
    );
    authz = canEditUnit(session, role);
  } else {
    const core = await db.read.core.findUnique({ where: { id: entityId }, select: { id: true } });
    if (!core) return editError(404, "core_not_found", "entityId");
    const role = await getCoreOwnerRole(session, entityId, db.read as unknown as CoreOwnerLookup);
    authz = authorizeCoreClaim(session, role);
  }
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
  return null;
}

type Fields = {
  name?: string;
  url?: string;
  families?: MethodServiceFamily[];
  supportedPmids?: string[];
  excludedPmids?: string[];
  countStaffPapers?: boolean;
};

/** Validate the fields PRESENT in the body. Returns the clean values, or the
 *  error response. */
function readFields(
  body: Record<string, unknown>,
): { ok: true; fields: Fields } | { ok: false; response: NextResponse } {
  const fields: Fields = {};
  const fail = (error: string, field: string) => ({
    ok: false as const,
    response: editError(400, error, field),
  });
  if ("name" in body) {
    const r = validateServiceName(body.name);
    if (!r.ok) return fail(r.error, "name");
    fields.name = r.value;
  }
  if ("url" in body) {
    const r = validateServiceUrl(body.url);
    if (!r.ok) return fail(r.error, "url");
    fields.url = r.value;
  }
  if ("families" in body) {
    const r = validateServiceFamilies(body.families);
    if (!r.ok) return fail(r.error, "families");
    fields.families = r.value;
  }
  for (const key of ["supportedPmids", "excludedPmids"] as const) {
    if (key in body) {
      const r = validatePmidList(body[key]);
      if (!r.ok) return fail(r.error, key);
      fields[key] = r.value;
    }
  }
  if ("countStaffPapers" in body) {
    if (typeof body.countStaffPapers !== "boolean") return fail("invalid_value", "countStaffPapers");
    fields.countStaffPapers = body.countStaffPapers;
  }
  return { ok: true, fields };
}

/** Whether a validated field equals what is stored. Families are compared by
 *  key: MySQL re-orders the keys of a stored JSON object. */
function sameValue(a: Fields[keyof Fields], b: Fields[keyof Fields]): boolean {
  const norm = (v: Fields[keyof Fields]) =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : methodFamilyKey(x))) : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isMethodServicesEnabled()) return editError(404, "not_found");

  const identity = await resolveEditIdentity();
  if (!identity) return new NextResponse(null, { status: 401 });
  // The identity a write is authorized against (`resolveEditIdentityForWrite`):
  // whoever may change the service is who may review it.
  const session = stripContentEditorView(stripObserverView(identity.session));

  const idRaw = request.nextUrl.searchParams.get("id") ?? "";
  if (!/^[1-9]\d{0,8}$/.test(idRaw)) return editError(400, "invalid_value", "id");
  // The stored row decides which unit this is. Read on the writer, as the POST
  // does: the section asks straight after it creates a service.
  const existing = await db.write.methodService.findUnique({
    where: { id: Number(idRaw) },
    select: METHOD_SERVICE_SELECT,
  });
  if (!existing) return editError(404, "service_not_found", "id");
  const view = toMethodServiceView(existing);
  if (!view) return editError(400, "invalid_entity_type", "id");
  const denied = await gate(session, view.entityType, view.entityId);
  if (denied) return denied;

  try {
    const review = await loadServiceReview(view);
    return NextResponse.json({ ok: true, review }, { headers: NO_STORE });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "read_failed");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isMethodServicesEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request, { maxBytes: MAX_BODY_BYTES });
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  if (typeof body.op !== "string" || !(OPS as readonly string[]).includes(body.op)) {
    return editError(400, "invalid_op", "op");
  }
  const op = body.op as Op;

  const audit = (
    tx: Parameters<typeof appendAuditRow>[0],
    unit: { entityType: MethodServiceEntityType; entityId: string },
    before: MethodServiceRow | null,
    after: MethodServiceRow | null,
    /** The one PMID an exclude / restore moved: a long list is audited as its
     *  count alone (`auditShape`), which would not say which paper. */
    moved?: { excludedPmid: string } | { restoredPmid: string },
  ): Promise<void> =>
    appendAuditRow(tx, {
      actorCwid: realCwid,
      impersonatedCwid,
      targetEntityType: unit.entityType,
      targetEntityId: unit.entityId,
      action: "roster_change",
      fieldsChanged: ["method_services"],
      beforeValues: before ? auditShape(before) : null,
      afterValues: after ? { ...auditShape(after), ...moved } : null,
      ts: new Date(),
      requestId,
    });

  // ------------------------------------------------------------------ create
  if (op === "create") {
    const { entityType, entityId } = body;
    if (!isMethodServiceEntityType(entityType)) {
      return editError(400, "invalid_entity_type", "entityType");
    }
    if (typeof entityId !== "string" || entityId.length === 0 || entityId.length > 64) {
      return editError(400, "invalid_unit_code", "entityId");
    }
    const denied = await gate(session, entityType, entityId);
    if (denied) return denied;

    if ("excludedPmids" in body) return editError(400, "invalid_value", "excludedPmids");
    const read = readFields(body);
    if (!read.ok) return read.response;
    const { name, url, families } = read.fields;
    if (name === undefined) return editError(400, "name_required", "name");
    if (url === undefined) return editError(400, "url_required", "url");
    if (families === undefined) return editError(400, "families_required", "families");
    if ((await findNonPublicFamilies(families)).length > 0) {
      return editError(400, "unknown_family", "families");
    }

    let saved: MethodServiceRow;
    try {
      saved = await db.write.$transaction(async (tx) => {
        const row = await tx.methodService.create({
          data: {
            entityType,
            entityId,
            name,
            url,
            families,
            supportedPmids: read.fields.supportedPmids ?? [],
            excludedPmids: [],
            countStaffPapers: read.fields.countStaffPapers ?? defaultCountStaffPapers(entityType),
            addedBy: session.cwid,
          },
          select: METHOD_SERVICE_SELECT,
        });
        await audit(tx, { entityType, entityId }, null, row);
        return row;
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    bustMethodServiceCache();
    return editOk({ op, changed: true, service: toMethodServiceView(saved) });
  }

  // ---------------------------------------------------------- update / delete
  if (typeof body.id !== "number" || !Number.isInteger(body.id) || body.id <= 0) {
    return editError(400, "invalid_value", "id");
  }
  // The stored row decides which unit this is. Read on the writer: a service
  // created a moment ago may not have reached the reader yet.
  const existing = await db.write.methodService.findUnique({
    where: { id: body.id },
    select: METHOD_SERVICE_SELECT,
  });
  if (!existing) return editError(404, "service_not_found", "id");
  if (!isMethodServiceEntityType(existing.entityType)) {
    return editError(400, "invalid_entity_type", "id");
  }
  const unit = { entityType: existing.entityType, entityId: existing.entityId };
  const denied = await gate(session, unit.entityType, unit.entityId);
  if (denied) return denied;

  if (op === "delete") {
    try {
      await db.write.$transaction(async (tx) => {
        await tx.methodService.delete({ where: { id: existing.id } });
        await audit(tx, unit, existing, null);
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    bustMethodServiceCache();
    return editOk({ op, id: existing.id, changed: true });
  }

  // exclude / restore — one PMID on or off the stored excluded list. The read,
  // the decision and the write share one transaction that holds the row's
  // lock, so two requests for the same service run one after the other and the
  // second starts from what the first wrote.
  if (op === "exclude" || op === "restore") {
    const parsed = validatePmidList(typeof body.pmid === "string" ? [body.pmid] : null);
    if (!parsed.ok || parsed.value.length !== 1) return editError(400, "invalid_pmids", "pmid");
    const pmid = parsed.value[0];

    type Outcome =
      | { kind: "gone" }
      | { kind: "full" }
      | { kind: "unchanged"; row: MethodServiceRow }
      | { kind: "saved"; row: MethodServiceRow };
    let outcome: Outcome;
    try {
      outcome = await db.write.$transaction(async (tx): Promise<Outcome> => {
        await tx.$queryRaw`SELECT id FROM method_service WHERE id = ${existing.id} FOR UPDATE`;
        const locked = await tx.methodService.findUnique({
          where: { id: existing.id },
          select: METHOD_SERVICE_SELECT,
        });
        if (!locked) return { kind: "gone" };
        const list = toMethodServiceView(locked)?.excludedPmids ?? [];
        if (list.includes(pmid) === (op === "exclude")) return { kind: "unchanged", row: locked };
        if (op === "exclude" && list.length >= SERVICE_PMIDS_MAX) return { kind: "full" };
        const next = op === "exclude" ? [...list, pmid] : list.filter((p) => p !== pmid);
        const row = await tx.methodService.update({
          where: { id: existing.id },
          data: { excludedPmids: next },
          select: METHOD_SERVICE_SELECT,
        });
        await audit(
          tx,
          unit,
          locked,
          row,
          op === "exclude" ? { excludedPmid: pmid } : { restoredPmid: pmid },
        );
        return { kind: "saved", row };
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    if (outcome.kind === "gone") return editError(404, "service_not_found", "id");
    if (outcome.kind === "full") return editError(400, "too_many_pmids", "pmid");
    if (outcome.kind === "saved") bustMethodServiceCache();
    return editOk({
      op,
      changed: outcome.kind === "saved",
      service: toMethodServiceView(outcome.row),
    });
  }

  // update — only the fields present, and only those that differ.
  const read = readFields(body);
  if (!read.ok) return read.response;
  const current = toMethodServiceView(existing);
  const data: Fields = {};
  for (const key of Object.keys(read.fields) as Array<keyof Fields>) {
    if (!sameValue(read.fields[key], current?.[key])) {
      Object.assign(data, { [key]: read.fields[key] });
    }
  }
  if (Object.keys(data).length === 0) return editOk({ op, changed: false, service: current });
  if (data.families && (await findNonPublicFamilies(data.families)).length > 0) {
    return editError(400, "unknown_family", "families");
  }

  let saved: MethodServiceRow;
  try {
    saved = await db.write.$transaction(async (tx) => {
      const row = await tx.methodService.update({
        where: { id: existing.id },
        data,
        select: METHOD_SERVICE_SELECT,
      });
      await audit(tx, unit, existing, row);
      return row;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
  bustMethodServiceCache();
  return editOk({ op, changed: true, service: toMethodServiceView(saved) });
}
