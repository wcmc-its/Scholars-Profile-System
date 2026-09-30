/**
 * `/api/edit/opportunity-admin` — matcha-admin Phase 1b corpus administration.
 *
 * PATCH `{ opportunityId, action: "suppress" | "restore", reason? }` — set or
 * clear the manual suppression columns on one corpus `opportunity` row.
 * Suppress writes `{ suppressedAt: now, suppressedBy, suppressReason }`;
 * restore nulls all three. A suppressed row drops out of the browse list
 * (default view), the detail route (404), the reverse-matcher card, and — on
 * the next nightly rebuild — the `scholars-opportunities` index. The row's
 * data is untouched, so restore is lossless, and the nightly GRANT# upsert
 * never names the suppression columns, so a suppression survives re-ingest.
 *
 * Authorization mirrors `/api/edit/opportunity-intake` (the surface this lives
 * on): superuser OR development role. 404 while `MATCHA_ADMIN` is off — the
 * dark-ship posture. The audit row reuses `suppression_create` /
 * `suppression_revoke` with the new `opportunity` entity type (the
 * `dataset_deposit` precedent), appended in the same transaction as the
 * manual-layer write (B03 write contract).
 */
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isMatchaAdminEnabled } from "@/lib/edit/grant-recs";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";

const PATH = "/api/edit/opportunity-admin";

const OPPORTUNITY_ID_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!isMatchaAdminEnabled()) return new NextResponse(null, { status: 404 });
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, requestId, body } = req.ctx;

  if (!(session.isSuperuser || session.isDeveloper)) {
    logEditDenial({
      actorCwid: realCwid,
      targetCwid: "opportunity-admin",
      path: PATH,
      reason: "not_developer_patch",
    });
    return editError(403, "not_developer_patch");
  }

  // --- body shape ---
  const { opportunityId, action } = body;
  if (typeof opportunityId !== "string" || !OPPORTUNITY_ID_RE.test(opportunityId)) {
    return editError(400, "invalid_opportunity_id", "opportunityId");
  }
  if (action !== "suppress" && action !== "restore") {
    return editError(400, "invalid_action", "action");
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim().slice(0, 255)
      : null;

  const existing = await db.read.opportunity.findUnique({
    where: { opportunityId },
    select: { suppressedAt: true, suppressedBy: true, suppressReason: true },
  });
  if (!existing) return editError(404, "not_found");

  // Refuse the no-op loudly rather than silently re-stamping attribution.
  if (action === "suppress" && existing.suppressedAt !== null) {
    return editError(409, "already_suppressed");
  }
  if (action === "restore" && existing.suppressedAt === null) {
    return editError(409, "not_suppressed");
  }

  const now = new Date();
  // `session.cwid` (the EFFECTIVE identity) is the manual-layer "last writer"
  // by design; the non-repudiable human is the audit row's actor_cwid.
  const after =
    action === "suppress"
      ? { suppressedAt: now, suppressedBy: session.cwid, suppressReason: reason }
      : { suppressedAt: null, suppressedBy: null, suppressReason: null };
  try {
    await db.write.$transaction(async (tx) => {
      await tx.opportunity.update({ where: { opportunityId }, data: after });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "opportunity",
        targetEntityId: opportunityId,
        action: action === "suppress" ? "suppression_create" : "suppression_revoke",
        fieldsChanged: null,
        beforeValues: {
          suppressed_at: existing.suppressedAt?.toISOString() ?? null,
          suppressed_by: existing.suppressedBy,
          suppress_reason: existing.suppressReason,
        },
        afterValues: {
          suppressed_at: after.suppressedAt?.toISOString() ?? null,
          suppressed_by: after.suppressedBy,
          suppress_reason: after.suppressReason,
        },
        ts: now,
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(`${PATH}#${action}`, err);
    return editError(500, "write_failed");
  }

  return editOk({ opportunityId, action });
}
