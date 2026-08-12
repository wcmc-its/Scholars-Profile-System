/**
 * PATCH /api/edit/center/[code]/nci-2a/[awardId]
 *
 * A reviewer overrides an LLM-proposed judgment column on one NCI Table 2A
 * award row (`2026-08-08-cancer-center-nci-table-2a-feature-plan.md`) — the
 * `/edit/reports/2` panel's write path. `[code]` is the raw `Center.code`,
 * matching `/edit/center/[code]/page.tsx`.
 *
 * Body (at least one of the two):
 *   cancerRelevantPercent: number in [0, 100]
 *   allocations: [{ programCode: string | null, programPercent: number }]
 *     — programPercent MUST sum to 100 (±0.01 for rounding); a programCode
 *       MUST be null or one of this center's live `CenterProgram` codes —
 *       NEVER a code the client invented, mirroring the same gate the
 *       Bedrock module itself enforces.
 *
 * Whichever field is sent gets `source: "human"` — which is what makes the
 * import script's non-clobber contract work (`scripts/backfills/*-cancer-
 * center-nci-2a-import.ts`): a later cycle re-import skips a "human"-sourced
 * value rather than overwriting it. Sending only `cancerRelevantPercent`
 * leaves `allocations` (and its sourcing) untouched, and vice versa.
 *
 * Authz + audit posture mirror `/api/edit/center-program`: Curator/Owner of
 * the center, or Superuser/comms_steward; one MySQL transaction with a B03
 * audit row (`cancer_funding_override`, `targetEntityType:
 * "cancer_funding_award"`), before/after carrying whichever field(s) changed.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { canEditUnit, getEffectiveUnitRole, logEditDenial, type UnitAdminLookup } from "@/lib/edit/authz";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/nci-2a/[awardId]";
const PERCENT_TOLERANCE = 0.01;

type AllocationInput = { programCode: string | null; programPercent: number };

function isValidAllocationsBody(value: unknown): value is AllocationInput[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((a) => {
    if (typeof a !== "object" || a === null) return false;
    const alloc = a as AllocationInput;
    if (alloc.programCode !== null && typeof alloc.programCode !== "string") return false;
    // Bounding each ROW to [0,100] is not redundant with the sum check below —
    // a {150, -50} pair sums to exactly 100 but is nonsense per-row (a >100%
    // share, a negative one), and the sum check alone would let it through.
    return typeof alloc.programPercent === "number" && Number.isFinite(alloc.programPercent) && alloc.programPercent >= 0 && alloc.programPercent <= 100;
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ code: string; awardId: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { code, awardId } = await params;
  const center = await db.read.center.findUnique({ where: { code }, select: { code: true } });
  if (!center) return editError(404, "unit_not_found", "code");

  // Authz FIRST, before any body-content validation — including the
  // per-field checks below, not just the DB-querying allocation-code check.
  // Validating first would let an unauthorized-but-authenticated caller use
  // 400-vs-403 as a side channel to probe which program codes are real (400
  // invalid_program_code vs 403), on data this route's own doc calls "gated
  // like every other unit-content edit surface, not a public read."
  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: center.code },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: awardId,
      path: PATH,
      reason: authz.reason,
      // The authz decision is against the CENTER (canEditUnit/getEffectiveUnitRole
      // above), not the award — logEditDenial's targetEntityType is UnitKind-typed
      // for exactly that reason; the award's own audit row (cancer_funding_award)
      // only gets written on a SUCCESSFUL override, below.
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return editError(403, authz.reason);
  }

  const wantsPercent = "cancerRelevantPercent" in body;
  const wantsAllocations = "allocations" in body;
  if (!wantsPercent && !wantsAllocations) {
    return editError(400, "invalid_value", "cancerRelevantPercent|allocations");
  }

  let cancerRelevantPercent: number | null = null;
  if (wantsPercent) {
    const v = body.cancerRelevantPercent;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      return editError(400, "invalid_value", "cancerRelevantPercent");
    }
    cancerRelevantPercent = v;
  }

  let allocations: AllocationInput[] = [];
  if (wantsAllocations) {
    if (!isValidAllocationsBody(body.allocations)) return editError(400, "invalid_value", "allocations");
    allocations = body.allocations;
    const sum = allocations.reduce((s, a) => s + a.programPercent, 0);
    if (Math.abs(sum - 100) > PERCENT_TOLERANCE) return editError(400, "allocations_must_sum_to_100", "allocations");

    const validCodes = new Set(
      (await db.read.centerProgram.findMany({ where: { centerCode: center.code }, select: { code: true } })).map(
        (p) => p.code,
      ),
    );
    const invented = allocations.find((a) => a.programCode !== null && !validCodes.has(a.programCode));
    if (invented) return editError(400, "invalid_program_code", "allocations");
  }

  const existing = await db.read.cancerCenterFundingAward.findUnique({
    where: { id: awardId, centerCode: center.code },
    include: { allocations: true },
  });
  if (!existing) return editError(404, "not_found", "awardId");

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const fieldsChanged: string[] = [];

  if (wantsPercent) {
    before.cancerRelevantPercent = existing.cancerRelevantPercent != null ? Number(existing.cancerRelevantPercent) : null;
    after.cancerRelevantPercent = cancerRelevantPercent;
    fieldsChanged.push("cancerRelevantPercent");
  }
  if (wantsAllocations) {
    before.allocations = existing.allocations.map((a) => ({ programCode: a.programCode, programPercent: Number(a.programPercent) }));
    after.allocations = allocations;
    fieldsChanged.push("allocations");
  }

  try {
    await db.write.$transaction(async (tx) => {
      await tx.cancerCenterFundingAward.update({
        where: { id: awardId },
        data: {
          ...(wantsPercent
            ? { cancerRelevantPercent, cancerRelevantPercentSource: "human" }
            : {}),
          ...(wantsAllocations
            ? {
                allocations: {
                  deleteMany: {},
                  create: allocations.map((a, i) => ({
                    centerCode: center.code,
                    programCode: a.programCode,
                    programPercent: a.programPercent,
                    source: "human",
                    sortOrder: i,
                  })),
                },
              }
            : {}),
        },
      });

      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "cancer_funding_award",
        targetEntityId: awardId,
        action: "cancer_funding_override",
        fieldsChanged,
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

  return editOk({ awardId, changed: true, fieldsChanged });
}
