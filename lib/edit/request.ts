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

import { getEditSession, type EditSession } from "@/lib/auth/superuser";
import { verifyRequestOrigin } from "@/lib/edit/authz";

/** Reject a body larger than this without parsing — generous for a small JSON edit. */
const MAX_BODY_BYTES = 64 * 1024;

export interface EditRequestContext {
  /** B01 identity + the live B02 superuser verdict. */
  session: EditSession;
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
 * The shared `/api/edit/*` preamble. Returns the request context, or a ready
 * error response — `415` (non-JSON), `403` (cross-origin), `401` (no session,
 * empty body — `self-edit-spec.md` edge case 16), `413` (oversized body), or
 * `400` (unparseable / non-object body).
 */
export async function readEditRequest(request: NextRequest): Promise<EditRequestResult> {
  // Defense in depth beyond SameSite=Lax.
  const origin = verifyRequestOrigin(request);
  if (!origin.ok) {
    const status = origin.reason === "bad_content_type" ? 415 : 403;
    return { ok: false, response: editError(status, origin.reason) };
  }

  // The authoritative session check — the middleware's 401 is only a coarse
  // gate. `getEditSession()` also resolves the live `isSuperuser` verdict.
  const session = await getEditSession();
  if (!session) {
    return { ok: false, response: new NextResponse(null, { status: 401 }) };
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
    ctx: { session, body: parsed as Record<string, unknown>, requestId: randomUUID() },
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
