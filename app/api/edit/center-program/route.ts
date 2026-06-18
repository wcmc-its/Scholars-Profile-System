/**
 * POST /api/edit/center-program — edit a center program's leaders + description
 * (#1117, the write path the per-program page (#1105) was missing).
 *
 * Body: `{ centerCode, programCode, action, ... }`.
 *
 * A center program may be CO-LED, so leaders are rows in `CenterProgramLeader`
 * (0..N), not a single column. Actions:
 *   - `add_leader`     — insert a leader (`cwid`, optional `interim` / `sortOrder`).
 *                        No-op if the leader already exists.
 *   - `remove_leader`  — delete a leader (`cwid`). No-op if absent.
 *   - `set_leader`     — update an existing leader's `interim` / `sortOrder`
 *                        (partial; absent fields unchanged). 400 if absent.
 *   - `set_description`— in-row update of `CenterProgram.description`
 *                        (`""` → null).
 *
 * Authz mirrors the roster editor (`/api/edit/roster`): Curator / Owner of the
 * center, or Superuser / comms_steward — `canEditUnit`. These are CONTENT fields,
 * not structural, so they are not Superuser-only.
 *
 * Each mutation is one MySQL transaction with a B03 audit row. There is no
 * `centerProgram` member in the audit ENUM, so the row is logged against the
 * center (`targetEntityType: "center"`, `targetEntityId: "<centerCode>:<programCode>"`)
 * — `roster_change` for the leader mutations (a membership-style row changed),
 * `field_override` for the description. `before`/`after` carry the program-scoped
 * snapshot so the history is self-describing. Post-commit: `reflectUnitChange`
 * purges the center page (it lists programs) + the program page reflects on next
 * read (revalidated via the center slug).
 */
import { type NextRequest, type NextResponse } from "next/server";

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
import { CWID_PATTERN, validateUnitDescription } from "@/lib/edit/validators";

const PATH = "/api/edit/center-program";

const PROGRAM_ACTIONS = [
  "add_leader",
  "remove_leader",
  "set_leader",
  "set_description",
] as const;
type ProgramAction = (typeof PROGRAM_ACTIONS)[number];
function isProgramAction(value: string): value is ProgramAction {
  return (PROGRAM_ACTIONS as readonly string[]).includes(value);
}

const MAX_SORT_ORDER = 9_999;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { centerCode, programCode, action } = body;
  if (typeof centerCode !== "string" || centerCode.length === 0) {
    return editError(400, "invalid_unit_code", "centerCode");
  }
  if (typeof programCode !== "string" || programCode.length === 0 || programCode.length > 16) {
    return editError(400, "invalid_program_code", "programCode");
  }
  if (typeof action !== "string" || !isProgramAction(action)) {
    return editError(400, "invalid_action", "action");
  }

  // --- parse + validate the per-action fields ---
  const isLeaderAction = action !== "set_description";

  let cwid = "";
  if (isLeaderAction) {
    if (typeof body.cwid !== "string" || !CWID_PATTERN.test(body.cwid)) {
      return editError(400, "invalid_cwid", "cwid");
    }
    cwid = body.cwid;
  }

  // interim / sortOrder apply to add_leader + set_leader; each is optional and
  // only mutated when present in the body.
  const interimPresent = (action === "add_leader" || action === "set_leader") && "interim" in body;
  const sortOrderPresent =
    (action === "add_leader" || action === "set_leader") && "sortOrder" in body;
  let interim = false;
  let sortOrder = 0;
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

  let description: string | null = null;
  if (action === "set_description") {
    if (typeof body.description !== "string") return editError(400, "invalid_value", "description");
    const r = validateUnitDescription(body.description);
    if (!r.ok) return editError(400, r.error, "description");
    description = r.value === "" ? null : r.value;
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
      targetCwid: cwid || programCode,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: centerCode,
    });
    return editError(403, authz.reason);
  }

  // --- program must exist for THIS center ---
  const program = await db.read.centerProgram.findUnique({
    where: { centerCode_code: { centerCode, code: programCode } },
    select: { code: true, description: true },
  });
  if (!program) return editError(400, "invalid_program_code", "programCode");

  const auditTargetId = `${centerCode}:${programCode}`;

  // ------------------------------------------------------------------ leaders
  if (isLeaderAction) {
    const existing = await db.read.centerProgramLeader.findUnique({
      where: {
        centerCode_programCode_cwid: { centerCode, programCode, cwid },
      },
      select: { cwid: true, interim: true, sortOrder: true },
    });

    if (action === "add_leader" && existing) {
      return editOk({ centerCode, programCode, cwid, action, changed: false });
    }
    if (action === "remove_leader" && !existing) {
      return editOk({ centerCode, programCode, cwid, action, changed: false });
    }
    if (action === "set_leader" && !existing) {
      return editError(400, "leader_not_found", "cwid");
    }

    try {
      await db.write.$transaction(async (tx) => {
        const before = existing
          ? { programCode, cwid: existing.cwid, interim: existing.interim, sortOrder: existing.sortOrder }
          : null;
        let after: Record<string, unknown> | null;

        if (action === "remove_leader") {
          await tx.centerProgramLeader.delete({
            where: { centerCode_programCode_cwid: { centerCode, programCode, cwid } },
          });
          after = null;
        } else if (action === "add_leader") {
          const row = await tx.centerProgramLeader.create({
            data: { centerCode, programCode, cwid, interim, sortOrder },
            select: { cwid: true, interim: true, sortOrder: true },
          });
          after = { programCode, cwid: row.cwid, interim: row.interim, sortOrder: row.sortOrder };
        } else {
          // set_leader — update only the fields present in the body.
          const row = await tx.centerProgramLeader.update({
            where: { centerCode_programCode_cwid: { centerCode, programCode, cwid } },
            data: {
              ...(interimPresent ? { interim } : {}),
              ...(sortOrderPresent ? { sortOrder } : {}),
            },
            select: { cwid: true, interim: true, sortOrder: true },
          });
          after = { programCode, cwid: row.cwid, interim: row.interim, sortOrder: row.sortOrder };
        }

        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "center",
          targetEntityId: auditTargetId,
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

    await reflectUnitChange({ unitKind: "center", unitSlug: center.slug, programCode });
    return editOk({ centerCode, programCode, cwid, action, changed: true });
  }

  // -------------------------------------------------------------- description
  if (program.description === description) {
    return editOk({ centerCode, programCode, action, changed: false });
  }

  try {
    await db.write.$transaction(async (tx) => {
      await tx.centerProgram.update({
        where: { centerCode_code: { centerCode, code: programCode } },
        data: { description },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "center",
        targetEntityId: auditTargetId,
        action: "field_override",
        fieldsChanged: ["description"],
        beforeValues: { programCode, description: program.description },
        afterValues: { programCode, description },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await reflectUnitChange({ unitKind: "center", unitSlug: center.slug, programCode });
  return editOk({ centerCode, programCode, action, changed: true });
}
