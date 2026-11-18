/**
 * POST /api/edit/unit-leadership — a department's Vice Chair roles
 * (`UnitLeadershipRole`). Actions: `add`, `update`, `remove`.
 *
 * Authorization is the unit's own: Superuser, Owner or Curator of the
 * department (`canEditUnit`). A scholar cannot grant themselves a title unless
 * they also hold one of those roles on the unit.
 *
 * Rows are live as soon as they are written; there is no review step.
 * Checks:
 *   - the holder is an active WCM scholar;
 *   - a holder who is not full-time faculty needs a `note` (400 `note_required`)
 *     — the card answers that by asking for the reason and resubmitting;
 *   - no second row with the same person, tier and function set (409);
 *   - field validation in `validateLeadershipFields`.
 *
 * Audited as `roster_change` on the department, like center leadership.
 */
import { type NextRequest, type NextResponse } from "next/server";

import {
  LEADERSHIP_ENTITY_TYPE,
  LEADERSHIP_HOLDER_SELECT,
  toLeadershipRoleView,
  validateLeadershipFields,
} from "@/lib/api/unit-leadership-roles";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { canEditUnit, getEffectiveUnitRole, logEditDenial, type UnitAdminLookup } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import { reflectOverviewEdit, reflectUnitChange } from "@/lib/edit/revalidation";
import { isUnitLeadershipEnabled } from "@/lib/edit/unit-leadership-flags";
import { CWID_PATTERN } from "@/lib/edit/validators";
import { isFullTimeFaculty } from "@/lib/unit-leadership";

const PATH = "/api/edit/unit-leadership";
const ACTIONS = ["add", "update", "remove"] as const;
type Action = (typeof ACTIONS)[number];

const ROW_SELECT = {
  id: true,
  cwid: true,
  entityType: true,
  entityId: true,
  displayTitle: true,
  tier: true,
  functions: true,
  areaText: true,
  site: true,
  startDate: true,
  source: true,
  sourceUrl: true,
  note: true,
} as const;

type Row = {
  cwid: string;
  displayTitle: string;
  tier: string;
  functions: string;
  areaText: string | null;
  site: string | null;
  startDate: Date | null;
  note: string | null;
};
const auditShape = (r: Row) => ({
  cwid: r.cwid,
  displayTitle: r.displayTitle,
  tier: r.tier,
  functions: r.functions,
  areaText: r.areaText,
  site: r.site,
  startDate: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
  note: r.note,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isUnitLeadershipEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { departmentCode, action } = body;
  if (typeof departmentCode !== "string" || departmentCode.length === 0) {
    return editError(400, "invalid_unit_code", "departmentCode");
  }
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return editError(400, "invalid_action", "action");
  }
  const act = action as Action;

  const department = await db.read.department.findUnique({
    where: { code: departmentCode },
    select: { code: true, slug: true },
  });
  if (!department) return editError(400, "unit_not_found", "departmentCode");

  // The department page lists the row and the holder's profile carries the
  // title line: refresh both.
  const reflect = async (holderCwid: string): Promise<void> => {
    await reflectUnitChange({ unitKind: "department", unitSlug: department.slug });
    const holderRow = await db.read.scholar.findUnique({ where: { cwid: holderCwid }, select: { slug: true } });
    if (holderRow) await reflectOverviewEdit(holderRow.slug);
  };

  const effective = await getEffectiveUnitRole(
    session,
    { kind: "department", code: departmentCode },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: typeof body.cwid === "string" ? body.cwid : departmentCode,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "department",
      targetEntityId: departmentCode,
    });
    return editError(403, authz.reason);
  }

  // The row being changed, for update / remove. It must belong to THIS
  // department: the authz above was for `departmentCode`, not for the row.
  let existing: (Row & { id: string }) | null = null;
  if (act !== "add") {
    if (typeof body.id !== "string" || body.id.length === 0) return editError(400, "invalid_value", "id");
    const found = await db.read.unitLeadershipRole.findUnique({ where: { id: body.id }, select: ROW_SELECT });
    if (!found || found.entityType !== LEADERSHIP_ENTITY_TYPE || found.entityId !== departmentCode) {
      return editError(400, "role_not_found", "id");
    }
    existing = found;
  }

  const audit = (
    tx: Parameters<typeof appendAuditRow>[0],
    before: Row | null,
    after: Row | null,
  ): Promise<void> =>
    appendAuditRow(tx, {
      actorCwid: realCwid,
      impersonatedCwid,
      targetEntityType: "department",
      targetEntityId: departmentCode,
      action: "roster_change",
      fieldsChanged: null,
      beforeValues: before ? { viceChair: auditShape(before) } : null,
      afterValues: after ? { viceChair: auditShape(after) } : null,
      ts: new Date(),
      requestId,
    });

  if (act === "remove" && existing) {
    const gone = existing;
    try {
      await db.write.$transaction(async (tx) => {
        await tx.unitLeadershipRole.delete({ where: { id: gone.id } });
        await audit(tx, gone, null);
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }
    await reflect(gone.cwid);
    return editOk({ departmentCode, action: act, id: gone.id, changed: true });
  }

  // add / update
  const cwid = existing ? existing.cwid : body.cwid;
  if (typeof cwid !== "string" || !CWID_PATTERN.test(cwid)) return editError(400, "invalid_cwid", "cwid");

  const valid = validateLeadershipFields(body);
  if (!valid.ok) return editError(400, valid.error, valid.field);
  const fields = valid.fields;

  const holder = await db.read.scholar.findUnique({
    where: { cwid },
    select: { ...LEADERSHIP_HOLDER_SELECT, campus: true },
  });
  if (!holder || holder.deletedAt !== null || holder.status !== "active" || holder.campus !== "wcm") {
    return editError(400, "scholar_not_found", "cwid");
  }
  // The friction for a holder who is not full-time faculty: say why.
  if (!isFullTimeFaculty(holder.roleCategory, holder.primaryTitle, holder.edPrimaryTitle) && !fields.note) {
    return editError(400, "note_required", "note");
  }

  const sameHolder = await db.read.unitLeadershipRole.findMany({
    where: { entityType: LEADERSHIP_ENTITY_TYPE, entityId: departmentCode, cwid },
    select: { id: true, tier: true, functions: true },
  });
  if (sameHolder.some((r) => r.id !== existing?.id && r.tier === fields.tier && r.functions === fields.functions)) {
    return editError(409, "duplicate_role", "cwid");
  }

  let saved: Awaited<ReturnType<typeof db.write.unitLeadershipRole.create>>;
  try {
    saved = await db.write.$transaction(async (tx) => {
      const row = existing
        ? await tx.unitLeadershipRole.update({ where: { id: existing.id }, data: fields })
        : await tx.unitLeadershipRole.create({
            data: { ...fields, cwid, entityType: LEADERSHIP_ENTITY_TYPE, entityId: departmentCode, source: "steward" },
          });
      await audit(tx, existing, row);
      return row;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflect(cwid);
  return editOk({
    departmentCode,
    action: act,
    changed: true,
    role: toLeadershipRoleView({ ...saved, scholar: holder }),
  });
}
