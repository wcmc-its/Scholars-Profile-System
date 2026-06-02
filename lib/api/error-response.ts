import { NextResponse } from "next/server";

/**
 * Standard JSON error response for `app/api/*` routes (#668 §5).
 *
 * Shape: `{ "error": "<code>" }` — the FLAT string form the codebase already
 * uses and that UI clients parse (the `/edit/*` cards and the feedback form read
 * `data.error` as a string via `mapErrorToMessage` / `humanizeError`). This
 * intentionally does NOT use a nested `{ error: { code, message } }` envelope:
 * that would break every existing client that treats `data.error` as a string.
 * (The SPEC originally proposed the nested shape; §5 was reconciled to this flat
 * form once the live client convention was confirmed.)
 *
 * The invariant this enforces is `Cache-Control: no-store` on every error
 * response — belt-and-suspenders behind the CloudFront uncacheable behaviors, so
 * a transient error body can never be edge-cached and replayed. (Note this is
 * the response-header no-store; it is unrelated to the #668 §4 CloudFront
 * `CustomErrorResponses`, which govern edge-side caching of origin 4xx/5xx.)
 */
export const API_NO_STORE = { "Cache-Control": "no-store" } as const;

export function apiError(
  /** A stable lowercase code (e.g. "unauthorized", "not_found") OR a short safe
   *  message. Clients map known codes to copy; unknown values fall back. Never
   *  pass raw error/driver text — that may leak internals. */
  error: string,
  status: number,
  init?: { headers?: HeadersInit },
): NextResponse {
  return NextResponse.json(
    { error },
    { status, headers: { ...API_NO_STORE, ...(init?.headers ?? {}) } },
  );
}
