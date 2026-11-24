/**
 * POST /api/edit/request-change — send one "Request a change" to the office that
 * owns the data (#160 Phase 2,
 * `docs/self-edit-request-change-server-mailer-plan.md`): a ServiceNow ticket for
 * ITS Support when `REQUEST_CHANGE_SERVICENOW` is on (#520), an email otherwise.
 *
 * Body: `{ attribute, issueId, itemId?, detail?, targetCwid? }`. The recipient
 * is resolved server-side from the trusted `REQUEST_A_CHANGE` config (the client
 * never names an address); only `route` / `fallbackEmail` issues send. Dormant
 * behind `SELF_EDIT_REQUEST_CHANGE_SEND` + `SCHOLARS_MAIL_FROM` — when off it
 * returns `500` and the dialog falls back to the Phase-1 `mailto:` (#494). A
 * failed ticket does the same; it is never retried or re-sent as a server email.
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
import { runAfterResponse } from "@/lib/edit/after-response";
import { canAccessScholarEditPage, logEditDenial } from "@/lib/edit/authz";
import { isMailerConfigured, sendMail } from "@/lib/edit/mailer";
import { resolvePersonNames } from "@/lib/edit/person-names";
import { recordRequestChangeAttempt } from "@/lib/edit/rate-limit";
import { REQUEST_DETAIL_MAX } from "@/lib/edit/request-a-change";
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
import { createScholarProfileRequest, serviceNowConfig } from "@/lib/edit/servicenow";

const PATH = "/api/edit/request-change";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

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
  if (typeof detail === "string" && detail.length > REQUEST_DETAIL_MAX) {
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
  const ticketing = resolved.ticketable ? serviceNowConfig() : null;
  if (!ticketing && !isMailerConfigured()) return editError(500, "send_disabled");

  // --- per-cwid rate limit (SPEC § 5 abuse controls / § 6 threat model). Placed
  //     AFTER the dormant gate so a 500 consumes no quota (no rows accrue until
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

  // --- look up the target scholar's name server-side (never client-supplied —
  //     a spoofed name in the office-bound email would be a social-engineering
  //     vector) so the recipient can identify whose profile this is about.
  //     A request about no scholar (org unit: no targetCwid) is the filer's own. ---
  const subject = typeof targetCwid === "string" ? target : realCwid;
  const targetScholar = await db.read.scholar.findUnique({
    where: { cwid: subject },
    select: { preferredName: true },
  });
  // The person who acted is always the REAL signed-in user: under "View as" the
  // ticket, its signature and the receipt must not name the persona. They (and a
  // profile-less target) are named via Scholar → WCM directory; never throws.
  const names = await resolvePersonNames([subject, realCwid]);

  // --- send (the request fails only if the send itself fails) ---
  const text = composeBody({
    attribute,
    targetCwid: subject,
    targetName: targetScholar?.preferredName ?? names.get(subject.toLowerCase()) ?? null,
    issueLabel: resolved.issueLabel,
    itemLabel: typeof itemId === "string" ? itemId : undefined,
    sourceSystem: resolved.sourceSystem,
    detail: typeof detail === "string" ? detail : undefined,
    actorCwid: realCwid,
    actorName: names.get(realCwid.toLowerCase()) ?? null,
  });
  let messageId: string | null = null;
  let ticket: { request: string; ritm: string } | null = null;
  try {
    if (ticketing) {
      ticket = await createScholarProfileRequest(ticketing, {
        requestor: subject,
        details: text,
        watchList: realCwid.toLowerCase() === subject.toLowerCase() ? [] : [realCwid],
      });
    } else {
      const sent = await sendMail({
        to: resolved.to,
        cc: resolved.cc,
        subject: subjectFor(resolved.attributeLabel),
        text,
      });
      messageId = sent.messageId;
    }
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, ticketing ? "ticket_failed" : "send_failed");
  }

  // --- best-effort B03 audit AFTER the send (must not roll back a sent email).
  //     Always keyed on the scholar (type=scholar, id=cwid) so "every change to
  //     scholar X" includes their change requests; the attribute + item live in
  //     after_values. ---
  try {
    await db.write.$transaction(async (tx) => {
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: target,
        action: "request_change",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: {
          attribute,
          issue_id: issueId,
          office: resolved.office,
          to: ticket ? "servicenow" : resolved.to,
          source_system: resolved.sourceSystem ?? null,
          item_id: typeof itemId === "string" ? itemId : null,
          message_id: messageId,
          ...(ticket ? { servicenow_request: ticket.request, servicenow_ritm: ticket.ritm } : {}),
        },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    // The mail or ticket already went out; an audit gap (e.g. the #493 INSERT grant not
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
  //     (e.g. a superuser not in the scholar table). Never fails the request, and
  //     never delays it: past CloudFront's 30s the dialog would open the mailto:
  //     for a ticket that already exists. A ticket's receipt does not wait on
  //     SELF_EDIT_REQUEST_CHANGE_SEND, which governs the office emails. ---
  if (noReceipt !== true) {
    runAfterResponse(async () => {
      try {
        const actor = await db.read.scholar.findUnique({
          where: { cwid: realCwid },
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
              ritm: ticket?.ritm,
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
    });
  }

  return editOk({ sent: true, ritm: ticket?.ritm ?? null });
}
