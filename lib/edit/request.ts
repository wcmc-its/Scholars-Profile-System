/**
 * Self-edit v1 — the shared `/api/edit/*` request preamble (#356).
 *
 * The three write endpoints (`field`, `suppress`, `revoke`) share the same
 * front matter: the same-origin / `Content-Type` guard, the authoritative
 * session + live `isSuperuser` re-check, a size-bounded JSON body parse, and a
 * per-request correlation id. `readEditRequest()` runs it once and returns
 * either the request context or a ready error response.
 *
 * (`lib/edit/request.ts` is not in `self-edit-spec.md`'s file map — it is the
 * de-duplicated preamble those three routes would otherwise each repeat.)
 */
import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { nowSeconds } from "@/lib/auth/session";
import { getSession } from "@/lib/auth/session-server";
import { type EditSession } from "@/lib/auth/superuser";
import {
  getEffectiveEditSession,
  impersonationActive,
} from "@/lib/auth/effective-identity";
import { verifyRequestOrigin } from "@/lib/edit/authz";

/** Reject a body larger than this without parsing — generous for a small JSON edit. */
const MAX_BODY_BYTES = 64 * 1024;

export interface EditRequestContext {
  /**
   * The EFFECTIVE edit identity + live superuser verdict — the target while a
   * "View as" overlay is live, otherwise the real signed-in user (#637 §3). All
   * authorization predicates (`authorize*`, `canEditUnit`, `canGrant`, …) read
   * this, so an impersonator acts with exactly the target's permissions — incl.
   * editing the target's own self-only `overview`. Aliases {@link effective}.
   */
  session: EditSession;
  /**
   * The EFFECTIVE edit identity (same object as {@link session}). Named
   * explicitly so a write handler can read "who am I acting as" without relying
   * on the historical `session` name (#637 §3 read/write split).
   */
  effective: EditSession;
  /**
   * The REAL signed-in CWID — the human behind the request, always accountable.
   * Written to `manual_edit_audit.actor_cwid`; **never** the impersonation
   * target (#637 R3/T2). Equals `effective.cwid` when not impersonating.
   */
  realCwid: string;
  /**
   * The impersonation target CWID when a "View as" overlay is live, else `null`
   * (#637 §3). Written to the audit row's `impersonated_cwid` so an impersonated
   * edit records "on behalf of whom" while `actor_cwid` stays the real human.
   */
  impersonatedCwid: string | null;
  /** The parsed JSON body — a plain object; the route validates its shape. */
  body: Record<string, unknown>;
  /** Per-request correlation id — written to the audit row and the structured logs. */
  requestId: string;
}

export type EditRequestResult =
  | { ok: true; ctx: EditRequestContext }
  | { ok: false; response: NextResponse };

/** A `200` success body: `{ ok: true, ...payload }`. */
export function editOk(payload: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: true, ...payload });
}

/**
 * An error body `{ ok: false, error, field? }` at `status`. Never echoes a
 * session token or another scholar's data (`self-edit-spec.md` § Surfaces).
 */
export function editError(status: number, error: string, field?: string): NextResponse {
  return NextResponse.json(
    field ? { ok: false, error, field } : { ok: false, error },
    { status },
  );
}

/**
 * A `429` rate-limit response with a `Retry-After` header (whole seconds until
 * the window clears). The body is the same `{ ok: false, error }` shape as
 * {@link editError}; the header is what {@link editError} cannot set.
 */
export function editRateLimited(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { ok: false, error: "rate_limited" },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );
}

/** Whether impersonated edits are blocked at write time (#637 §3, default off). */
function impersonationReadonly(): boolean {
  return process.env.IMPERSONATION_READONLY === "true";
}

/**
 * The shared `/api/edit/*` preamble. Returns the request context, or a ready
 * error response — `415` (non-JSON), `403` (cross-origin), `401` (no session,
 * empty body — `self-edit-spec.md` edge case 16), `413` (oversized body), or
 * `400` (unparseable / non-object body).
 *
 * The returned context carries BOTH identities (#637 §3): `effective` (the
 * impersonation target while a "View as" overlay is live, else the real user) is
 * what every authorization predicate reads; `realCwid` is the human written to
 * `manual_edit_audit.actor_cwid`; `impersonatedCwid` is the overlay target (or
 * `null`) written to the new `impersonated_cwid` column. When
 * `IMPERSONATION_READONLY=true` AND an overlay is live, every write is refused
 * here with `403 impersonation_readonly` before any handler mutates.
 */
export async function readEditRequest(request: NextRequest): Promise<EditRequestResult> {
  // Defense in depth beyond SameSite=Lax.
  const origin = verifyRequestOrigin(request);
  if (!origin.ok) {
    const status = origin.reason === "bad_content_type" ? 415 : 403;
    return { ok: false, response: editError(status, origin.reason) };
  }

  // The authoritative session check — the middleware's 401 is only a coarse
  // gate. `getEffectiveEditSession()` resolves the live `isSuperuser` verdict of
  // the EFFECTIVE cwid; the raw session gives the REAL cwid for attribution and
  // the live-overlay check. Both read the same cookie, decoded once each.
  const effective = await getEffectiveEditSession();
  const real = await getSession();
  if (!effective || !real) {
    return { ok: false, response: new NextResponse(null, { status: 401 }) };
  }
  const realCwid = real.cwid;
  // The overlay target this write happens on behalf of — `null` when not
  // impersonating (or the feature/flag is off, or the overlay has expired).
  const impersonatedCwid = impersonationActive(real, nowSeconds())
    ? (real.impersonating?.targetCwid ?? null)
    : null;

  // R3 optional view-only mode: while impersonating, refuse the write up front
  // (the default is edit-enabled — see #637 §3). Placed before the body read so
  // an oversized/garbage body still 403s rather than 413/400.
  if (impersonatedCwid !== null && impersonationReadonly()) {
    return { ok: false, response: editError(403, "impersonation_readonly") };
  }

  // Size-bounded body read — declared length first, then a post-read backstop.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: editError(413, "body_too_large") };
  }
  let parsed: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return { ok: false, response: editError(413, "body_too_large") };
    }
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: editError(400, "invalid_json") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: editError(400, "invalid_body") };
  }

  return {
    ok: true,
    ctx: {
      // `session` aliases `effective` — authz call sites already read this name
      // and now transparently act with the effective (target) identity. NOTE:
      // manual-layer "last writer" metadata written off `session.cwid` (e.g.
      // `FieldOverride.actorCwid` in `app/api/edit/field/route.ts`) therefore
      // records the EFFECTIVE (impersonated) cwid by design — the edit is made
      // *as them* (#637 §3). That column is never an authorization input; the
      // non-repudiable record of the real human is the immutable, hashed
      // `manual_edit_audit.actor_cwid` (+ `impersonated_cwid`). So an auditor
      // reading only the override table sees the profile owner, while the audit
      // log shows who actually acted.
      session: effective,
      effective,
      realCwid,
      impersonatedCwid,
      body: parsed as Record<string, unknown>,
      requestId: randomUUID(),
    },
  };
}

/** Log a failed write transaction as one structured line — the `5xx` path. */
export function logEditFailure(path: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "edit_write_failed",
      path,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
