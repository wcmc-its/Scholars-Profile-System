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
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import {
  composeBody,
  isRequestAttribute,
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
  const { attribute, issueId, itemId, detail, targetCwid } = body;
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

  return editOk({ sent: true });
}
