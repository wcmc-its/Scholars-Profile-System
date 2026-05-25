import { NextResponse } from "next/server";
import { clearedSessionCookie } from "@/lib/auth/session";

/**
 * POST /api/auth/logout — end the session (B01 #100).
 *
 * Clears the session cookie and redirects home. v1 is a local cookie clear
 * only — no SAML Single Logout (B01 plan OQ4): the user stays signed in at the
 * IdP, so a later `/edit` visit re-authenticates without a fresh credential
 * prompt. Idempotent — a POST with no active session simply re-clears.
 */
export const dynamic = "force-dynamic";

export function POST(): NextResponse {
  // Relative Location (see callback route): request.url is the container's
  // internal address behind the proxy, so absolutizing against it breaks the
  // post-logout redirect. The browser resolves "/" against the public origin.
  const response = new NextResponse(null, {
    status: 302,
    headers: { Location: "/" },
  });
  const cookie = clearedSessionCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
