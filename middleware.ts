import { NextResponse, type NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import vivoRedirectCwids from "@/data/vivo-redirects.json";

/**
 * B14 — legacy VIVO URL redirect set.
 *
 * Static import of the build-time-generated CWID list from
 * `scripts/etl/generate-vivo-redirect-set.ts`. Wrapped in a Set so lookups are
 * O(1) per request. Edge-safe: no runtime dependency, ~3-4 k strings (~50 KB
 * uncompressed), evaluated once at cold start.
 */
const VIVO_CWID_SET = new Set<string>(vivoRedirectCwids as readonly string[]);

/**
 * Legacy VIVO path shapes -- after the CNAME cutover, all three land on the
 * new CloudFront. `/display/cwid-*` is the documented form; `/individual/*`
 * and `/profile/*` are defensive coverage for well-known VIVO route schemes
 * (per plan D1).
 */
const VIVO_PATH_RE = /^\/(?:display|individual|profile)\/cwid-([A-Za-z0-9._\-]+)\/?$/;

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
 * B14 legacy-URL redirects (issue #113) run before the SSO gate: matching
 * `/display/cwid-{cwid}` (and `/individual/`, `/profile/` variants) 301 to
 * `/scholars/by-cwid/{cwid}` when the CWID is in the academic-faculty set;
 * non-matching paths fall through. The `/scholars/by-cwid/` page then chains
 * a second 301 to the current canonical slug, keeping slug currency /
 * aliasing in `lib/url-resolver.ts` (a single source of truth).
 *
 * Edge-safe: imports only `lib/auth/session.ts` (iron-session + config), never
 * `saml.ts` (Node-only) or `session-server.ts` (`next/headers`).
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  // ------------------------------------------------------------------
  // B14 legacy-URL redirect layer. Runs before the SSO gate because the
  // legacy paths are public and should never trigger an SSO redirect
  // (they neither overlap the matcher's `/edit*` prefixes nor require a
  // session). Unknown CWIDs fall through to the existing 404 handling.
  // ------------------------------------------------------------------
  const vivoMatch = VIVO_PATH_RE.exec(request.nextUrl.pathname);
  if (vivoMatch) {
    const cwid = vivoMatch[1];
    if (cwid && VIVO_CWID_SET.has(cwid)) {
      // Relative Location: behind CloudFront -> ALB -> Fargate, request.nextUrl
      // carries the container's internal host, so an absolute redirect would
      // send the browser to an unreachable address (ip-...:3000). The browser
      // resolves a relative Location against the public URL it requested. cwid
      // is regex-constrained ([A-Za-z0-9._-]) so it is safe in the header.
      return new NextResponse(null, {
        status: 301,
        headers: { Location: `/scholars/by-cwid/${cwid}` },
      });
    }
    // Out-of-set CWID -- not in the academic-faculty roster. Fall through
    // so the existing 404 handling renders without a redirect.
    return NextResponse.next();
  }

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
  // Relative Location (see the VIVO branch above + the SAML callback route):
  // request.nextUrl is the container's internal host behind the proxy, so an
  // absolute redirect is unreachable. encodeURIComponent keeps the return value
  // safe in the header; the login route re-validates it via safeReturnPath.
  const returnTo = request.nextUrl.pathname + request.nextUrl.search;

  // Local-dev guard. Under `next dev` with no IdP configured, the SAML login
  // route 503s and — worse — the dev middleware adapter rejects a RELATIVE
  // Location with "Invalid URL" (the prod edge runtime accepts it, which is why
  // the line below stays relative). Bounce to the local dev-login route with an
  // ABSOLUTE URL the dev adapter accepts. Scoped to NODE_ENV==="development" +
  // unset SAML so the test and prod paths stay byte-identical; the dev-login
  // route is itself local-only (404s in production).
  if (process.env.NODE_ENV === "development" && !process.env.SAML_IDP_SSO_URL) {
    const devLogin = new URL("/api/auth/dev-login", request.nextUrl.origin);
    devLogin.searchParams.set("return", returnTo);
    return NextResponse.redirect(devLogin, 302);
  }

  return new NextResponse(null, {
    status: 302,
    headers: { Location: `/api/auth/saml/login?return=${encodeURIComponent(returnTo)}` },
  });
}

export const config = {
  matcher: [
    "/edit",
    "/edit/:path*",
    "/api/edit",
    "/api/edit/:path*",
    // B14 legacy VIVO paths (issue #113).
    "/display/:path*",
    "/individual/:path*",
    "/profile/:path*",
  ],
};
