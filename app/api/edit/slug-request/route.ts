/**
 * /api/edit/slug-request (#497 PR-3, docs/slug-personalization-spec.md § 5.4).
 *
 *   POST — a scholar files a slug request for THEIR OWN profile. Validates §6,
 *          does an advisory collision pre-check, supersedes any prior pending
 *          request for the same cwid, and is per-cwid rate-limited. The request
 *          is the queue entry; approval (the decision endpoint) writes the
 *          authoritative override.
 *   GET  — the superuser approval queue (`?status=pending`, oldest first), each
 *          row carrying a server-computed collision / reserved warning.
 *
 * Flag-gated behind `SELF_EDIT_SLUG_REQUEST` (off ⇒ 404), mirroring the
 * request-change mailer's dormancy.
 */
import { type NextRequest, type NextResponse } from "next/server";

import { getEditSession } from "@/lib/auth/superuser";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { logEditDenial } from "@/lib/edit/authz";
import { recordRequestChangeAttempt } from "@/lib/edit/rate-limit";
import {
  editError,
  editOk,
  editRateLimited,
  logEditFailure,
  readEditRequest,
} from "@/lib/edit/request";
import { isSlugRequestEnabled } from "@/lib/edit/slug-request";
import { checkSlugCollision, RESERVED_SLUGS, validateRequestedSlug } from "@/lib/edit/validators";

const PATH = "/api/edit/slug-request";
/** A short free-text justification; rejects an abusive payload. */
const MAX_REASON = 1000;

// ---------------------------------------------------------------------------
// POST — file a request (self)
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSlugRequestEnabled()) return editError(404, "not_found");

  const req = await readEditRequest(request);
  if (!req.ok) return req.response;
  const { session, body, requestId } = req.ctx;

  // --- body shape ---
  const { requestedSlug, reason } = body;
  if (typeof requestedSlug !== "string") {
    return editError(400, "invalid_slug", "requestedSlug");
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return editError(400, "invalid_reason", "reason");
  }
  if (typeof reason === "string" && reason.length > MAX_REASON) {
    return editError(400, "reason_too_long", "reason");
  }

  // --- the target is ALWAYS the actor: a scholar requests only their own slug
  //     (SPEC § 5.4). A superuser who wants to set another scholar's slug uses
  //     POST /api/edit/field directly, not this queue. ---
  const cwid = session.cwid;

  // --- format / reserved / numeric / profanity (400) ---
  const format = validateRequestedSlug(requestedSlug);
  if (!format.ok) return editError(400, format.error, "requestedSlug");
  const slug = format.value;

  // --- advisory checks (400, friendly): already your live slug, or taken. The
  //     authoritative collision guard is the slug_guard UNIQUE at approval. ---
  const current = await db.read.scholar.findUnique({
    where: { cwid },
    select: { slug: true },
  });
  if (current?.slug === slug) return editError(400, "already_current", "requestedSlug");
  const collision = await checkSlugCollision(slug, cwid, db.read);
  if (!collision.ok) return editError(400, "collision", "requestedSlug");

  // --- per-cwid rate limit (reused bucket; superusers exempt). After validation
  //     so a malformed request consumes no quota; before the write so it gates. ---
  if (!session.isSuperuser) {
    const rate = await recordRequestChangeAttempt(cwid);
    if (!rate.allowed) {
      console.warn(
        JSON.stringify({
          event: "slug_request_rate_limited",
          path: PATH,
          request_id: requestId,
          actor_cwid: cwid,
          count: rate.count,
          limit: rate.limit,
        }),
      );
      return editRateLimited(rate.retryAfterSeconds);
    }
  }

  // --- write: supersede prior pending + insert the new request + B03 audit ---
  let created: { id: string };
  try {
    created = await db.write.$transaction(async (tx) => {
      await tx.slugRequest.updateMany({
        where: { cwid, status: "pending" },
        data: { status: "superseded" },
      });
      const row = await tx.slugRequest.create({
        data: {
          cwid,
          requestedSlug: slug,
          reason: typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null,
          requestedBy: session.cwid,
          status: "pending",
        },
        select: { id: true },
      });
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: "scholar",
        targetEntityId: cwid,
        action: "slug_request",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: { requested_slug: slug, request_id: row.id },
        ts: new Date(),
        requestId,
      });
      return row;
    });
  } catch (err) {
    logEditFailure(PATH, err);
    return editError(500, "write_failed");
  }

  return editOk({ id: created.id, status: "pending", requestedSlug: slug });
}

// ---------------------------------------------------------------------------
// GET — the superuser approval queue
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isSlugRequestEnabled()) return editError(404, "not_found");

  // Reads don't mutate (no CSRF surface) and cross-origin reads can't see the
  // response (CORS), so the gate is the session + live isSuperuser re-check.
  const session = await getEditSession();
  if (!session) return editError(401, "unauthenticated");
  if (!session.isSuperuser) {
    logEditDenial({ actorCwid: session.cwid, targetCwid: session.cwid, path: PATH, reason: "not_superuser" });
    return editError(403, "not_superuser");
  }

  const status = request.nextUrl.searchParams.get("status") ?? "pending";
  if (status !== "pending") return editError(400, "invalid_status", "status");

  const rows = await db.read.slugRequest.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      cwid: true,
      requestedSlug: true,
      reason: true,
      createdAt: true,
    },
  });

  // Resolve target scholar + a live collision/reserved warning per row. The
  // pending queue is small; N lookups are acceptable.
  const requests = await Promise.all(
    rows.map(async (r) => {
      const scholar = await db.read.scholar.findUnique({
        where: { cwid: r.cwid },
        select: { slug: true, preferredName: true, fullName: true },
      });
      let warning: "collision" | "reserved" | null = null;
      if (RESERVED_SLUGS.has(r.requestedSlug)) {
        warning = "reserved";
      } else {
        const collision = await checkSlugCollision(r.requestedSlug, r.cwid, db.read);
        if (!collision.ok) warning = "collision";
      }
      return {
        id: r.id,
        cwid: r.cwid,
        requestedSlug: r.requestedSlug,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        currentSlug: scholar?.slug ?? null,
        name: scholar?.preferredName ?? scholar?.fullName ?? null,
        warning,
      };
    }),
  );

  return editOk({ requests });
}
