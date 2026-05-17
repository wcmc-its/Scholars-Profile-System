import { NextResponse, type NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";

/**
 * B01 — SSO gate for the editing surfaces (issue #100).
 *
 * Coarse gate over `/edit/*` and `/api/edit/*`: an unauthenticated page
 * request is sent to SSO login; an unauthenticated `/api/edit/*` request gets
 * a bare 401. An authenticated request passes through. This is the redirect /
 * 401 layer — every `/api/edit/*` handler and `/edit/*` page also validates
 * the session server-side (the authoritative check, #100 AC). B02 #101 layers
 * the superuser predicate on top.
 *
 * Edge-safe: imports only `lib/auth/session.ts` (iron-session + config), never
 * `saml.ts` (Node-only) or `session-server.ts` (`next/headers`).
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  let authenticated = false;
  try {
    authenticated = (await getSessionFromRequest(request)) !== null;
  } catch {
    // Misconfigured (e.g. SESSION_COOKIE_SECRET unset) — fail toward
    // "unauthenticated" so the gate stays closed rather than 500ing the page.
    authenticated = false;
  }
  if (authenticated) return NextResponse.next();

  // Unauthenticated below this point.
  if (request.nextUrl.pathname.startsWith("/api/edit")) {
    // API route: 401, empty body — no redirect, no leakage
    // (#100 AC; self-edit-spec.md edge case 16).
    return new NextResponse(null, { status: 401 });
  }

  // Page route: redirect to SSO login, remembering the intended destination.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/api/auth/saml/login";
  loginUrl.search = "";
  loginUrl.searchParams.set(
    "return",
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return NextResponse.redirect(loginUrl, 302);
}

export const config = {
  matcher: ["/edit", "/edit/:path*", "/api/edit", "/api/edit/:path*"],
};
