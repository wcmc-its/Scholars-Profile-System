/**
 * /api/edit/grant-recs/feedback — #1609, the "Grants for me" feedback loop
 * (`SELF_EDIT_GRANT_RECS`).
 *
 *   GET  ?cwid=<cwid>  → `{ ok, feedback: GrantRecFeedbackEntry[] }`, the
 *                        scholar's live Save / Not-relevant rows. The card
 *                        drops Not-relevant ids and pins Saved ones
 *                        (`applyGrantRecFeedback`).
 *   POST { cwid, opportunityId, status: "saved" | "not_relevant" | null,
 *          reason?: NotRelevantReason | null }
 *                      → sets (upsert) or clears (`status: null`, delete) the
 *                        one (cwid, opportunityId) row.
 *
 * Why a separate authed route instead of filtering inside the public forward
 * route (`/api/scholars/[cwid]/opportunities`): that route is public and
 * cookie-less by design, so anything it did with this table would publish a
 * scholar's private Save / dismiss choices to anyone who asks.
 *
 * Authorization mirrors the mentee-suggestion / COI-gap dismiss routes (and the
 * `/edit` pages' `includeMenteeSuggestions` gate that decides whether the card
 * renders the controls): the GENUINE scholar (real signed-in cwid === target,
 * no "View as" overlay) OR a GENUINE (non-impersonating) superuser. Anyone else
 * (another scholar, a proxy / unit-admin / comms_steward, an impersonating
 * superuser) gets a 404 — the same answer for every target, so the route never
 * confirms whose feedback exists. Flag off ⇒ 404 `grant_recs_disabled`, after
 * authz and before any read/write (the dark-ship posture).
 *
 * Each write lands with a B03 `grant_rec_feedback` audit row
 * (`target_entity_type='scholar'`, `target_entity_id` the cwid, before/after
 * `{ opportunityId, status, reason }`) in the same transaction. `actorCwid` on
 * the row is the real human, so superuser QA labels are separable from the
 * scholar's own.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isGrantRecsEnabled } from "@/lib/edit/grant-recs";
import {
  editError,
  editOk,
  logEditFailure,
  readEditRequest,
  resolveEditIdentity,
  type EditIdentity,
} from "@/lib/edit/request";
import {
  isFeedbackStatus,
  isNotRelevantReason,
  type GrantRecFeedbackEntry,
  type GrantRecFeedbackStatus,
  type NotRelevantReason,
} from "@/lib/grant-recs/feedback";

export const dynamic = "force-dynamic";

const PATH = "/api/edit/grant-recs/feedback";
const CWID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const MAX_OPPORTUNITY_ID = 128; // `opportunity.opportunity_id` VARCHAR(128)

/** Genuine self OR genuine superuser; logs + returns false otherwise. */
function authorized(id: EditIdentity, targetCwid: string): boolean {
  const genuine = id.impersonatedCwid === null;
  if (genuine && (id.realCwid === targetCwid || id.session.isSuperuser)) return true;
  logEditDenial({ actorCwid: id.realCwid, targetCwid, path: PATH, reason: "not_self" });
  return false;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const id = await resolveEditIdentity();
  if (!id) return editError(401, "unauthenticated");
  const cwid = request.nextUrl.searchParams.get("cwid") ?? "";
  if (!CWID_RE.test(cwid)) return editError(400, "invalid_cwid", "cwid");
  if (!authorized(id, cwid)) return editError(404, "not_found");
  if (!isGrantRecsEnabled()) return editError(404, "grant_recs_disabled");

  const rows = await db.read.grantRecFeedback.findMany({
    where: { cwid },
    select: { opportunityId: true, status: true, reason: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  const feedback: GrantRecFeedbackEntry[] = [];
  for (const r of rows) {
    if (!isFeedbackStatus(r.status)) continue; // unknown vocabulary — ignore, never surface
    feedback.push({
      opportunityId: r.opportunityId,
      status: r.status,
      reason: isNotRelevantReason(r.reason) ? r.reason : null,
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  const res = editOk({ feedback });
  res.headers.set("cache-control", "no-store");
  return res;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { realCwid, impersonatedCwid, session, requestId, body } = req.ctx;

  const cwid = typeof body.cwid === "string" ? body.cwid : "";
  if (!CWID_RE.test(cwid)) return editError(400, "invalid_cwid", "cwid");
  if (!authorized({ session, realCwid, impersonatedCwid }, cwid)) {
    return editError(404, "not_found");
  }
  if (!isGrantRecsEnabled()) return editError(404, "grant_recs_disabled");

  const opportunityId = typeof body.opportunityId === "string" ? body.opportunityId.trim() : "";
  if (!opportunityId || opportunityId.length > MAX_OPPORTUNITY_ID) {
    return editError(400, "invalid_opportunity_id", "opportunityId");
  }
  let status: GrantRecFeedbackStatus | null = null;
  if (body.status !== null) {
    if (!isFeedbackStatus(body.status)) return editError(400, "invalid_status", "status");
    status = body.status;
  }
  let reason: NotRelevantReason | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (status !== "not_relevant" || !isNotRelevantReason(body.reason)) {
      return editError(400, "invalid_reason", "reason");
    }
    reason = body.reason;
  }

  const key = { cwid_opportunityId: { cwid, opportunityId } };
  try {
    const result = await db.write.$transaction(async (tx) => {
      const before = await tx.grantRecFeedback.findUnique({
        where: key,
        select: { status: true, reason: true },
      });
      const beforeStatus = before?.status ?? null;
      const beforeReason = before?.reason ?? null;
      if (beforeStatus === status && beforeReason === reason) return { changed: false };

      const now = new Date();
      if (status === null) {
        // deleteMany, not delete: a concurrent clear (double-click, two tabs)
        // that already removed the row must not throw P2025 and 500.
        await tx.grantRecFeedback.deleteMany({ where: { cwid, opportunityId } });
      } else {
        await tx.grantRecFeedback.upsert({
          where: key,
          create: { cwid, opportunityId, status, reason, actorCwid: realCwid },
          update: { status, reason, actorCwid: realCwid },
        });
      }
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid, // always null — both allowed actors are genuine
        targetEntityType: "scholar",
        targetEntityId: cwid,
        action: "grant_rec_feedback",
        fieldsChanged: ["status", "reason"],
        beforeValues: { opportunityId, status: beforeStatus, reason: beforeReason },
        afterValues: { opportunityId, status, reason },
        ts: now,
        requestId,
      });
      return { changed: true };
    });
    return editOk({ opportunityId, status, reason, unchanged: !result.changed });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }
}
