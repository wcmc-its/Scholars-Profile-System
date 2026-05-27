/**
 * POST /api/edit/request-change — send one "Request a change" email to the
 * office that owns the data (#160 Phase 2,
 * `docs/self-edit-request-change-server-mailer-plan.md`).
 *
 * Body: `{ attribute, issueId, itemId?, detail?, targetCwid? }`. The recipient
 * is resolved server-side from the trusted `REQUEST_A_CHANGE` config (the client
 * never names an address); only `route` / `fallbackEmail` issues send. Dormant
 * behind `SELF_EDIT_REQUEST_CHANGE_SEND` + `SCHOLARS_MAIL_FROM` — when off it
 * returns `503` and the dialog falls back to the Phase-1 `mailto:` (#494).
 *
 * Ordering (decision 2026-05-26): **send first, then a best-effort B03 audit
 * row**. The audit INSERT does NOT gate the send — the `scholars_audit` INSERT
 * grant (#493) may still be unapplied, and a mail already delivered must never
 * be "rolled back" by an audit-table permission gap. A failed audit is logged,
 * not surfaced.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { canAccessScholarEditPage, logEditDenial } from "@/lib/edit/authz";
import { isMailerConfigured, sendMail } from "@/lib/edit/mailer";
import { recordRequestChangeAttempt } from "@/lib/edit/rate-limit";
import {
  editError,
  editOk,
  editRateLimited,
  logEditFailure,
  readEditRequest,
} from "@/lib/edit/request";
import {
  composeBody,
  composeReceiptBody,
  isRequestAttribute,
  receiptSubjectFor,
  resolveRequestChange,
  subjectFor,
} from "@/lib/edit/request-change";

const PATH = "/api/edit/request-change";
/** Generous for a free-text correction note; rejects an abusive payload. */
const MAX_DETAIL = 4000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, body, requestId } = req.ctx;

  // --- body shape ---
  const { attribute, issueId, itemId, detail, targetCwid, noReceipt } = body;
  if (!isRequestAttribute(attribute)) return editError(400, "invalid_attribute", "attribute");
  if (typeof issueId !== "string" || issueId.length === 0) {
    return editError(400, "invalid_issue", "issueId");
  }
  if (itemId !== undefined && itemId !== null && typeof itemId !== "string") {
    return editError(400, "invalid_item", "itemId");
  }
  if (detail !== undefined && detail !== null && typeof detail !== "string") {
    return editError(400, "invalid_detail", "detail");
  }
  if (typeof detail === "string" && detail.length > MAX_DETAIL) {
    return editError(400, "detail_too_long", "detail");
  }
  if (noReceipt !== undefined && typeof noReceipt !== "boolean") {
    return editError(400, "invalid_receipt_flag", "noReceipt");
  }
  // `targetCwid` is the scholar the request concerns — self in self-mode, the
  // edited scholar in superuser-mode. Defaults to the actor.
  let target: string;
  if (targetCwid === undefined || targetCwid === null) {
    target = session.cwid;
  } else if (typeof targetCwid === "string" && targetCwid.length > 0) {
    target = targetCwid;
  } else {
    return editError(400, "invalid_target", "targetCwid");
  }

  // --- authorization (403): the same self-or-superuser gate as the edit page.
  //     Request-a-change grants no new capability (SPEC § 6) — it just refuses a
  //     non-superuser submitting about a scholar that isn't them. ---
  if (!canAccessScholarEditPage(session, target)) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: target, path: PATH, reason: "not_self" });
    return editError(403, "not_self");
  }

  // --- resolve the recipient server-side; non-routable shapes never send ---
  const resolved = resolveRequestChange(attribute, issueId);
  if (resolved.kind === "no-send") return editError(400, "not_routable", "issueId");

  // --- dormant unless enabled + configured: the client falls back to mailto: ---
  if (!isMailerConfigured()) return editError(503, "send_disabled");

  // --- per-cwid rate limit (SPEC § 5 abuse controls / § 6 threat model). Placed
  //     AFTER the dormant gate so a 503 consumes no quota (no rows accrue until
  //     the feature is live) and BEFORE the send so the count actually gates it.
  //     Superusers — trusted staff who may legitimately triage many scholars —
  //     are exempt. Every 429 is logged with cwid + count so the env-tuned limit
  //     can be ratcheted from data rather than guessed. ---
  if (!session.isSuperuser) {
    const rate = await recordRequestChangeAttempt(session.cwid);
    if (!rate.allowed) {
      console.warn(
        JSON.stringify({
          event: "request_change_rate_limited",
          path: PATH,
          request_id: requestId,
          actor_cwid: session.cwid,
          count: rate.count,
          limit: rate.limit,
        }),
      );
      return editRateLimited(rate.retryAfterSeconds);
    }
  }

  // --- send (the request fails only if the send itself fails) ---
  let messageId: string;
  try {
    const sent = await sendMail({
      to: resolved.to,
      cc: resolved.cc,
      subject: subjectFor(resolved.attributeLabel),
      text: composeBody({
        issueLabel: resolved.issueLabel,
        itemLabel: typeof itemId === "string" ? itemId : undefined,
        sourceSystem: resolved.sourceSystem,
        detail: typeof detail === "string" ? detail : undefined,
        actorCwid: session.cwid,
        targetCwid: target,
      }),
    });
    messageId = sent.messageId;
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(502, "send_failed");
  }

  // --- best-effort B03 audit AFTER the send (must not roll back a sent email).
  //     Always keyed on the scholar (type=scholar, id=cwid) so "every change to
  //     scholar X" includes their change requests; the attribute + item live in
  //     after_values. ---
  try {
    await db.write.$transaction(async (tx) => {
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: "scholar",
        targetEntityId: target,
        action: "request_change",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          attribute,
          issue_id: issueId,
          office: resolved.office,
          to: resolved.to,
          source_system: resolved.sourceSystem ?? null,
          item_id: typeof itemId === "string" ? itemId : null,
          message_id: messageId,
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    // The mail already went out; an audit gap (e.g. the #493 INSERT grant not
    // yet applied) is logged, never surfaced as a request failure.
    console.error(
      JSON.stringify({
        event: "request_change_audit_failed",
        path: PATH,
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // --- best-effort courtesy receipt to the submitter (opt-out; default on).
  //     Resolved from the local Scholar record -- always reachable, avoids the
  //     VPC<->WCM LDAP gap. Skipped on opt-out, or when the actor has no email
  //     (e.g. a superuser not in the scholar table). Never fails the request. ---
  if (noReceipt !== true) {
    try {
      const actor = await db.read.scholar.findUnique({
        where: { cwid: session.cwid },
        select: { email: true },
      });
      if (actor?.email) {
        await sendMail({
          to: actor.email,
          subject: receiptSubjectFor(resolved.attributeLabel),
          text: composeReceiptBody({
            issueLabel: resolved.issueLabel,
            itemLabel: typeof itemId === "string" ? itemId : undefined,
            office: resolved.office,
            detail: typeof detail === "string" ? detail : undefined,
          }),
        });
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "request_change_receipt_failed",
          path: PATH,
          request_id: requestId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return editOk({ sent: true });
}
