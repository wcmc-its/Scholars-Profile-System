/**
 * "View as" impersonation — start / stop (#637, impersonation-spec.md §6/§7,
 * R1/R2/R4/R5).
 *
 * `POST` begins a session: a superuser (R1, the REAL `session.cwid` — never the
 * effective cwid) starts viewing/acting as a non-superuser scholar (R2, the
 * down-only escalation guard). `DELETE` ends it ("Return to my view"),
 * idempotent. Both re-seal the existing cookie in place (`withImpersonation` /
 * `withoutImpersonation`, `lib/auth/session.ts`) — the real `cwid`/`iat`/`exp`
 * are preserved, the 8h `exp` is the authoritative cap (R6); no second cookie.
 *
 * Each transition writes one standalone-tx B03 audit row to
 * `scholars_audit.manual_edit_audit` (`appendAuditRow`) AND emits one structured
 * CloudWatch line (R5 — enter AND exit), so "who acted as whom" is recorded at
 * both ends, tamper-evident (`actor_cwid` = real human, `impersonated_cwid` =
 * target, both inside `row_hash` recipe v2). The audit row is its own one-
 * statement transaction here — there is no manual-layer write to bind it to, so
 * a standalone `$transaction` keeps the `appendAuditRow` "must run in a tx"
 * contract without inventing a second write.
 *
 * The whole route is gated by `IMPERSONATION_ENABLED` (default off): flag-off ⇒
 * 404 (spec §5, the feature lands dark). The route-level R1/R2 enforcement here
 * mirrors `/api/edit/*` — the Edge middleware is only a coarse session/flag gate
 * (it cannot run the LDAPS `isSuperuser` check; `lib/auth/superuser.ts` is
 * Node-only). Node runtime by construction: imports `effective-identity.ts`
 * (LDAP) and Prisma.
 */
import { NextResponse, type NextRequest } from "next/server";

import { getSession } from "@/lib/auth/session-server";
import {
  nowSeconds,
  withImpersonation,
  withoutImpersonation,
  type SerializedSessionCookie,
} from "@/lib/auth/session";
import { assertImpersonable, canImpersonate } from "@/lib/auth/effective-identity";
import { isCommsSteward } from "@/lib/auth/comms-steward";
import { db } from "@/lib/db";
import { appendAuditRow } from "@/lib/edit/audit";
import { verifyRequestOrigin } from "@/lib/edit/authz";
import { editError } from "@/lib/edit/request";

export const dynamic = "force-dynamic";

const PATH = "/api/impersonation";

/** Whether the impersonation feature is enabled at all (default off, spec §5). */
function impersonationEnabled(): boolean {
  return process.env.IMPERSONATION_ENABLED === "true";
}

/**
 * Apply a freshly-resealed cookie to a 204 response. The re-seal helpers return
 * `{ name, value, options }` ready for `cookies.set`; the cookie is the only
 * state this route mutates (the overlay rides inside the AEAD seal).
 */
function noContentWithCookie(cookie: SerializedSessionCookie): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

/**
 * POST /api/impersonation `{ targetCwid }` — start a "View as" session.
 *
 * Enforced in order (fail-closed, each its own stable status/reason):
 *   1. flag off                → 404 (feature dark)
 *   2. no session              → 401
 *   3. cross-origin / non-JSON → 403 / 415 (R4, CSRF)
 *   4. real cwid not superuser → 403 `not_superuser` (R1 — REAL cwid, never effective)
 *   5. target not a scholar or comms_steward → 404 `target_not_found`
 *   6. target IS a superuser   → 403 `target_is_superuser` (R2, down-only)
 * On success: re-seal with the overlay, audit `impersonation_start`, 204.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!impersonationEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 401 });

  // R4 — same-origin + application/json (defense in depth beyond SameSite=Lax),
  // identical to the `/api/edit/*` preamble.
  const origin = verifyRequestOrigin(request);
  if (!origin.ok) {
    const status = origin.reason === "bad_content_type" ? 415 : 403;
    return editError(status, origin.reason);
  }

  // R1 — the initiator gate runs against the REAL `session.cwid`. Never the
  // effective cwid: an impersonated session must not be able to start a deeper
  // impersonation off the target's identity (threat T1).
  if (!(await canImpersonate(session.cwid))) {
    return editError(403, "not_superuser");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return editError(400, "invalid_json");
  }
  const targetCwid =
    body && typeof body === "object" && typeof (body as { targetCwid?: unknown }).targetCwid === "string"
      ? (body as { targetCwid: string }).targetCwid.trim()
      : "";
  if (!targetCwid) return editError(400, "invalid_target", "targetCwid");

  // Target must be a real, non-departed scholar OR a comms_steward
  // (role-aware-navigation-entry-points-spec.md broadens spec §7's
  // scholar-only rule). A steward is a global Method-Family role and may have no
  // Scholar row of its own (dwd2001), so a superuser previewing the steward view
  // needs them assumable too. This grants NO new capability: a superuser is a
  // superset of comms_steward, so "view as a steward" is a narrower preview, not
  // an escalation — and R2 below still rejects a target who is a superuser. The
  // steward check is flag-gated (`isCommsSteward` ⇒ false when COMMS_STEWARD is
  // off), so the broadening is inert on a dark deployment. Read-side; soft-
  // deleted scholars are not assumable.
  const target = await db.read.scholar
    .findFirst({ where: { cwid: targetCwid, deletedAt: null }, select: { cwid: true } })
    .catch(() => null);
  const targetIsSteward = target ? false : await isCommsSteward(targetCwid).catch(() => false);
  if (!target && !targetIsSteward) return editError(404, "target_not_found", "targetCwid");

  // R2 — down-only escalation guard. Rejects a target who is themselves a
  // superuser (no lateral admin→admin). Stable reason for the UI / log triage.
  const guard = await assertImpersonable(session.cwid, targetCwid);
  if (!guard.ok) return editError(403, guard.reason);

  const startedAt = nowSeconds();
  try {
    await db.write.$transaction(async (tx) => {
      await appendAuditRow(tx, {
        actorCwid: session.cwid,
        targetEntityType: "scholar",
        targetEntityId: targetCwid,
        action: "impersonation_start",
        fieldsChanged: null,
        beforeValues: null,
        afterValues: { startedAt },
        ts: new Date(),
        requestId: null,
        impersonatedCwid: targetCwid,
      });
    });
  } catch {
    return editError(500, "audit_write_failed");
  }

  // R5 — structured CloudWatch event (metric filter in observability-stack.ts).
  console.warn(
    JSON.stringify({
      event: "impersonation_started",
      actor_cwid: session.cwid,
      target_cwid: targetCwid,
      startedAt,
    }),
  );

  const cookie = await withImpersonation(session, targetCwid);
  return noContentWithCookie(cookie);
}

/**
 * DELETE /api/impersonation — end a "View as" session ("Return to my view").
 *
 * Gate flag → 404; no session → 401; R4 origin guard. Re-seals the overlay away
 * (idempotent — `withoutImpersonation` is a no-op when none is present). Only
 * when an overlay was actually dropped does it audit `impersonation_end` + emit
 * the CloudWatch line (spec test E8 — a DELETE with no overlay is a 204 with no
 * row). Always 204.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!impersonationEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const session = await getSession();
  if (!session) return new NextResponse(null, { status: 401 });

  const origin = verifyRequestOrigin(request);
  if (!origin.ok) {
    const status = origin.reason === "bad_content_type" ? 415 : 403;
    return editError(status, origin.reason);
  }

  // Capture the overlay BEFORE re-sealing: the audit/CloudWatch pair fires only
  // when there was a live target to leave (E8). `withoutImpersonation` preserves
  // `iat`/`exp` and is idempotent.
  const overlay = session.impersonating ?? null;
  const cookie = await withoutImpersonation(session);

  if (overlay) {
    const endedAt = nowSeconds();
    try {
      await db.write.$transaction(async (tx) => {
        await appendAuditRow(tx, {
          actorCwid: session.cwid,
          targetEntityType: "scholar",
          targetEntityId: overlay.targetCwid,
          action: "impersonation_end",
          fieldsChanged: null,
          beforeValues: null,
          // `startedAt` ties the exit row back to its `impersonation_start`; the
          // exit timestamp is the row's own `ts`.
          afterValues: { startedAt: overlay.startedAt },
          ts: new Date(),
          requestId: null,
          impersonatedCwid: overlay.targetCwid,
        });
      });
    } catch {
      // The cookie has already been computed; an audit failure on EXIT must not
      // trap the user in an impersonated session. Drop the overlay anyway and
      // surface the failure in logs rather than blocking "Return to my view".
      console.error(
        JSON.stringify({ event: "edit_write_failed", path: `${PATH} DELETE` }),
      );
      return noContentWithCookie(cookie);
    }

    console.warn(
      JSON.stringify({
        event: "impersonation_ended",
        actor_cwid: session.cwid,
        target_cwid: overlay.targetCwid,
        startedAt: overlay.startedAt,
      }),
    );
  }

  return noContentWithCookie(cookie);
}
