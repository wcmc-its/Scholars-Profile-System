/**
 * POST /api/edit/slug-request/[id]/decision (#497 PR-3, SPEC § 5.4) —
 * superuser-only.
 *
 * Body: `{ decision: "approve" | "reject", note? }`.
 *   approve → in ONE transaction: upsert the authoritative `field_override(slug)`
 *             + `reconcileScholarSlug` (so the new URL resolves and the old one
 *             301s) + mark the request `approved`. The `slug_guard` UNIQUE +
 *             `Scholar.slug @unique` are the collision authority — a conflict
 *             rolls the whole thing back and returns 409 `collision` so the
 *             reviewer declines.
 *   reject  → mark `rejected` with the (required) reviewer note.
 * Both write a B03 row, then send a best-effort requester notification.
 *
 * Flag-gated behind `SELF_EDIT_SLUG_REQUEST` (off ⇒ 404).
 */
import { type NextRequest, type NextResponse } from "next/server";

import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { isMailerConfigured, sendMail } from "@/lib/edit/mailer";
import { editError, editOk, logEditFailure, readEditRequest } from "@/lib/edit/request";
import {
  composeApprovedEmail,
  composeRejectedEmail,
  isSlugRequestEnabled,
} from "@/lib/edit/slug-request";
import { reconcileScholarSlug } from "@/lib/slug";

const PATH = "/api/edit/slug-request/[id]/decision";
const MAX_NOTE = 1000;

/** Prisma unique-constraint violation (the slug collision backstop). */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!isSlugRequestEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, realCwid, impersonatedCwid, body, requestId } = req.ctx;

  // --- authorization (403): superuser only ---
  if (!session.isSuperuser) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: session.cwid, path: PATH, reason: "not_superuser" });
    return editError(403, "not_superuser");
  }

  const { id } = await params;
  const { decision, note } = body;
  if (decision !== "approve" && decision !== "reject") {
    return editError(400, "invalid_decision", "decision");
  }
  if (note !== undefined && note !== null && typeof note !== "string") {
    return editError(400, "invalid_note", "note");
  }
  if (typeof note === "string" && note.length > MAX_NOTE) {
    return editError(400, "note_too_long", "note");
  }
  const trimmedNote = typeof note === "string" ? note.trim() : "";
  // A rejection MUST carry a reason — it is shown to the requester.
  if (decision === "reject" && trimmedNote.length === 0) {
    return editError(400, "note_required", "note");
  }

  // --- load the request; only a pending request is decidable ---
  const slugRequest = await db.read.slugRequest.findUnique({
    where: { id },
    select: { id: true, cwid: true, requestedSlug: true, status: true },
  });
  if (!slugRequest) return editError(404, "not_found");
  if (slugRequest.status !== "pending") return editError(409, "already_decided");

  const { cwid, requestedSlug } = slugRequest;

  if (decision === "approve") {
    // --- approve: override upsert + reconcile + status, one transaction ---
    try {
      await db.write.$transaction(async (tx) => {
        const key = {
          entityType_entityId_fieldName: {
            entityType: "scholar" as const,
            entityId: cwid,
            fieldName: "slug",
          },
        };
        const existing = await tx.fieldOverride.findUnique({ where: key, select: { value: true } });
        await tx.fieldOverride.upsert({
          where: key,
          create: {
            entityType: "scholar",
            entityId: cwid,
            fieldName: "slug",
            value: requestedSlug,
            actorCwid: session.cwid,
          },
          update: { value: requestedSlug, actorCwid: session.cwid },
        });
        // Drive routing now (PR-1 §5.1): set Scholar.slug + write slug_history so
        // the old URL 301s. No-op if the scholar's ED record hasn't arrived yet
        // (the override is still the pin the ETL honors).
        await reconcileScholarSlug(tx, cwid, requestedSlug);
        await tx.slugRequest.update({
          where: { id },
          data: { status: "approved", decidedBy: session.cwid, decidedAt: new Date() },
        });
        await appendAuditRow(tx, {
          actorCwid: realCwid,
          impersonatedCwid,
          targetEntityType: "scholar",
          targetEntityId: cwid,
          action: "slug_request_approved",
          fieldsChanged: ["slug"],
          beforeValues: { slug: existing?.value ?? null },
          afterValues: { slug: requestedSlug, request_id: id },
          ts: new Date(),
          requestId,
        });
      });
    } catch (err) {
      // The slug was taken between request and approval — the UNIQUE guards
      // caught it. Surface 409 so the reviewer declines and asks for another.
      if (isUniqueViolation(err)) return editError(409, "collision");
      logEditFailure(PATH, err);
      return editError(500, "write_failed");
    }

    await notifyRequester(cwid, composeApprovedEmail(requestedSlug), id, requestId);
    return editOk({ id, status: "approved", slug: requestedSlug });
  }

  // --- reject: mark rejected + note, one transaction ---
  try {
    await db.write.$transaction(async (tx) => {
      await tx.slugRequest.update({
        where: { id },
        data: {
          status: "rejected",
          decidedBy: session.cwid,
          decidedAt: new Date(),
          decisionNote: trimmedNote,
        },
      });
      await appendAuditRow(tx, {
        actorCwid: realCwid,
        impersonatedCwid,
        targetEntityType: "scholar",
        targetEntityId: cwid,
        action: "slug_request_rejected",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: { requested_slug: requestedSlug, request_id: id, decision_note: trimmedNote },
        ts: new Date(),
        requestId,
      });
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  await notifyRequester(cwid, composeRejectedEmail(requestedSlug, trimmedNote), id, requestId);
  return editOk({ id, status: "rejected" });
}

/**
 * Best-effort requester notification — resolved from the local `Scholar.email`
 * (avoids the VPC↔WCM LDAP gap, like the request-change receipt). Never fails
 * the decision: a send error (or dormant mailer) is logged, not surfaced.
 */
async function notifyRequester(
  cwid: string,
  email: { subject: string; text: string },
  slugRequestId: string,
  requestId: string,
): Promise<void> {
  if (!isMailerConfigured()) return;
  try {
    const scholar = await db.read.scholar.findUnique({
      where: { cwid },
      select: { email: true },
    });
    if (scholar?.email) {
      await sendMail({ to: scholar.email, subject: email.subject, text: email.text });
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "slug_request_notify_failed",
        path: PATH,
        request_id: requestId,
        slug_request_id: slugRequestId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
