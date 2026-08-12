/**
 * POST /api/edit/center/[code]/disease-assignments — a curator's confirm /
 * reject / clear call on one (cwid, diseaseCode) `CancerCenterDiseaseAssignment`
 * row (`2026-08-12-cancer-center-disease-assignment-edit-ui-plan.md` §4).
 *
 * Body: `{ cwid: string, diseaseCode: string, decision: "confirmed" | "rejected" | "clear" }`.
 *
 * `[code]` is the center whose roster the `/edit/center/[code]` panel is
 * scoped to (the raw `Center.code`, matching `/edit/center/[code]/page.tsx` —
 * NOT the public-facing slug); authz is Curator/Owner of THIS center, or
 * Superuser/comms_steward (`canEditUnit`) — same posture as `/api/edit/roster`
 * and the NCI 2A route. `CancerCenterDiseaseAssignment` /
 * `CancerCenterDiseaseDecision` carry no center column of their own (a
 * scholar's disease profile is not center-scoped data) — `[code]` is purely
 * the authz boundary here, the same role it plays for the un-FK'd award rows
 * on the NCI 2A route.
 *
 * `"confirmed"` / `"rejected"` upsert `CancerCenterDiseaseDecision`, snapshotting
 * `scoreAtDecision` / `confidenceAtDecision` off the CURRENT
 * `CancerCenterDiseaseAssignment` row for the pair, read inside the SAME
 * transaction as the write (a later reseed can then detect drift by diffing
 * against the live assignment row — plan §6). `404 assignment_not_found` when
 * that pair has no assignment row — there is nothing to snapshot a decision
 * against. `"clear"` is a REAL DELETE of the decision row, never a third
 * stored `decision` value — collapsing "no decision yet" into "explicitly
 * cleared" is the exact bug `FamilyTierDecision` (#1993/#2160) was built to
 * close, and this table copies that shape on purpose.
 *
 * `decidedBy` is always `realCwid` — the accountable human from
 * `resolveEditIdentity()` — never the effective/impersonated cwid. One
 * `db.write.$transaction` per call: the lookup + upsert-or-delete +
 * `appendAuditRow` (`action: "disease_assignment_decision"`,
 * `targetEntityType: "scholar"`) commit atomically. No `reflectUnitChange` —
 * this data is not ISR-cached anywhere.
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
import { CWID_PATTERN } from "@/lib/edit/validators";

const PATH = "/api/edit/center/[code]/disease-assignments";

const DECISIONS = ["confirmed", "rejected", "clear"] as const;
type Decision = (typeof DECISIONS)[number];

function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

/** No `CancerCenterDiseaseAssignment` row for the (cwid, diseaseCode) pair —
 *  thrown inside the transaction so a 404 rolls the write back cleanly
 *  instead of committing a decision with nothing to snapshot. */
class AssignmentNotFound extends Error {}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { cwid, diseaseCode, decision } = body;
  if (typeof cwid !== "string" || !CWID_PATTERN.test(cwid)) {
    return editError(400, "invalid_cwid", "cwid");
  }
  if (typeof diseaseCode !== "string" || diseaseCode.length === 0 || diseaseCode.length > 32) {
    return editError(400, "invalid_disease_code", "diseaseCode");
  }
  if (typeof decision !== "string" || !isDecision(decision)) {
    return editError(400, "invalid_decision", "decision");
  }

  const { code } = await params;
  const center = await db.read.center.findUnique({ where: { code }, select: { code: true } });
  if (!center) return editError(400, "unit_not_found", "code");

  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: center.code },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: cwid,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return editError(403, authz.reason);
  }

  if (decision === "clear") {
    // "clear" on an already-absent decision is a no-op — mirrors
    // `/api/edit/roster`'s remove-if-absent posture, and skips writing an
    // audit row for a delete that deletes nothing. The read result is reused
    // directly as the audit `beforeValues`, same as `handleDivision`'s
    // outside-the-transaction `existing` lookup.
    const existing = await db.read.cancerCenterDiseaseDecision.findUnique({
      where: { cwid_diseaseCode: { cwid, diseaseCode } },
      select: { decision: true, scoreAtDecision: true, confidenceAtDecision: true },
    });
    if (!existing) return editOk({ cwid, diseaseCode, decision, changed: false });

    try {
      await db.write.$transaction(async (tx) => {
        await tx.cancerCenterDiseaseDecision.delete({
          where: { cwid_diseaseCode: { cwid, diseaseCode } },
        });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "scholar",
          targetEntityId: cwid,
          action: "disease_assignment_decision",
          fieldsChanged: null,
          beforeValues: {
            diseaseCode,
            decision: existing.decision,
            scoreAtDecision: existing.scoreAtDecision,
            confidenceAtDecision: existing.confidenceAtDecision,
          },
          afterValues: null,
          ts: new Date(),
          requestId,
        });
      });
    } catch (err) {
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }

    return editOk({ cwid, diseaseCode, decision, changed: true });
  }

  // "confirmed" / "rejected" — upsert, snapshotting the assignment row's
  // CURRENT score/confidence inside the transaction (plan §4). The prior
  // decision (if any) is read outside the transaction, same as roster's
  // `handleCenter` before-snapshot, and carried through as `beforeValues`.
  const existingDecision = await db.read.cancerCenterDiseaseDecision.findUnique({
    where: { cwid_diseaseCode: { cwid, diseaseCode } },
    select: { decision: true, scoreAtDecision: true, confidenceAtDecision: true },
  });

  const decidedAt = new Date();
  try {
    const row = await db.write.$transaction(async (tx) => {
      const assignment = await tx.cancerCenterDiseaseAssignment.findUnique({
        where: { cwid_diseaseCode: { cwid, diseaseCode } },
        select: { score: true, confidence: true },
      });
      if (!assignment) throw new AssignmentNotFound();

      const decided = await tx.cancerCenterDiseaseDecision.upsert({
        where: { cwid_diseaseCode: { cwid, diseaseCode } },
        create: {
          cwid,
          diseaseCode,
          decision,
          decidedBy: realCwid,
          decidedAt,
          scoreAtDecision: assignment.score,
          confidenceAtDecision: assignment.confidence,
        },
        update: {
          decision,
          decidedBy: realCwid,
          decidedAt,
          scoreAtDecision: assignment.score,
          confidenceAtDecision: assignment.confidence,
        },
        select: { decision: true, scoreAtDecision: true, confidenceAtDecision: true },
      });

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: cwid,
        action: "disease_assignment_decision",
        fieldsChanged: null,
        beforeValues: existingDecision
          ? {
              diseaseCode,
              decision: existingDecision.decision,
              scoreAtDecision: existingDecision.scoreAtDecision,
              confidenceAtDecision: existingDecision.confidenceAtDecision,
            }
          : null,
        afterValues: {
          diseaseCode,
          decision: decided.decision,
          scoreAtDecision: decided.scoreAtDecision,
          confidenceAtDecision: decided.confidenceAtDecision,
        },
        ts: decidedAt,
        requestId,
      });

      return decided;
    });

    return editOk({
      cwid,
      diseaseCode,
      decision: row.decision,
      scoreAtDecision: row.scoreAtDecision,
      confidenceAtDecision: row.confidenceAtDecision,
    });
  } catch (err) {
    if (err instanceof AssignmentNotFound) {
      return editError(404, "assignment_not_found", "diseaseCode");
    }
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
