import { NextResponse, type NextRequest } from "next/server";
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

export function POST(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL("/", request.url), 302);
  const cookie = clearedSessionCookie();
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
