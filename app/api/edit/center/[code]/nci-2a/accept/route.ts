/**
 * POST /api/edit/center/[code]/nci-2a/accept
 *
 * Bulk Accept for report 2 (NCI Table 2a, PR 2b): confirm the AI-suggested
 * Cancer-relevant % of several awards at once, as they are. The per-row Accept
 * is the PATCH beside this (`[awardId]/route.ts`) sending the same value; this
 * is that, for up to `NCI2A_ACCEPT_CAP` (50) awards per call.
 *
 * Body: { awardIds: string[] } — 1 to 50 distinct ids.
 *
 * Gate: exactly the PATCH's — `canEditUnit` on the center, checked before the
 * body is looked at.
 *
 * One MySQL transaction. The rows are read INSIDE it (the writer, not the read
 * replica, which can lag a reviewer's own save), and each flip is a guarded
 * `updateMany` on `source = 'llm'`, so a PATCH that lands in between is never
 * overwritten. Each accepted award gets one audit row, reusing
 * `cancer_funding_override` with `before === after` (the value is unchanged;
 * the act is the confirmation) — no new audit action, no ENUM edit.
 *
 * Skipped and reported back, never an error: an id outside this center
 * (`not_found`), a row a human already reviewed (`already_reviewed`), and a
 * row with no percent (`no_percent` — there is nothing to accept).
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
import { NCI2A_ACCEPT_CAP, type Nci2aAcceptResult } from "@/lib/edit/nci-2a-report";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/center/[code]/nci-2a/accept";

function parseAwardIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) return null;
  const ids = [...new Set(v as string[])];
  return ids.length <= NCI2A_ACCEPT_CAP ? ids : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  const { code } = await params;
  const center = await db.read.center.findUnique({ where: { code }, select: { code: true } });
  if (!center) return editError(404, "unit_not_found", "code");

  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: center.code },
    db.read as unknown as UnitAdminLookup,
  );
  const authz = canEditUnit(session, effective);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: center.code,
      path: PATH,
      reason: authz.reason,
      targetEntityType: "center",
      targetEntityId: center.code,
    });
    return editError(403, authz.reason);
  }

  const awardIds = parseAwardIds(body.awardIds);
  if (!awardIds) return editError(400, "invalid_value", "awardIds");

  let result: Nci2aAcceptResult;
  try {
    result = await db.write.$transaction(async (tx) => {
      const rows = await tx.cancerCenterFundingAward.findMany({
        where: { id: { in: awardIds }, centerCode: center.code },
        select: { id: true, cancerRelevantPercent: true, cancerRelevantPercentSource: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const out: Nci2aAcceptResult = { accepted: [], skipped: [] };
      const ts = new Date();
      for (const awardId of awardIds) {
        const row = byId.get(awardId);
        if (!row) {
          out.skipped.push({ awardId, reason: "not_found" });
          continue;
        }
        if (row.cancerRelevantPercentSource === "human") {
          out.skipped.push({ awardId, reason: "already_reviewed" });
          continue;
        }
        if (row.cancerRelevantPercent == null) {
          out.skipped.push({ awardId, reason: "no_percent" });
          continue;
        }
        const pct = Number(row.cancerRelevantPercent);
        // Guarded on the value just read: a PATCH committed since then (a
        // different value, or already human) matches nothing and is left alone.
        const { count } = await tx.cancerCenterFundingAward.updateMany({
          where: {
            id: awardId,
            centerCode: center.code,
            cancerRelevantPercentSource: "llm",
            cancerRelevantPercent: row.cancerRelevantPercent,
          },
          data: { cancerRelevantPercentSource: "human" },
        });
        if (count === 0) {
          out.skipped.push({ awardId, reason: "already_reviewed" });
          continue;
        }
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "cancer_funding_award",
          targetEntityId: awardId,
          action: "cancer_funding_override",
          fieldsChanged: ["cancerRelevantPercent"],
          beforeValues: { cancerRelevantPercent: pct },
          afterValues: { cancerRelevantPercent: pct },
          ts,
          requestId,
        });
        out.accepted.push({ awardId, cancerRelevantPercent: pct });
      }
      return out;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk(result);
}
