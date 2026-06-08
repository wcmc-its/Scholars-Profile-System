import { NextResponse, type NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import {
  buildCspResponseHeaders,
  resolveCspMode,
} from "@/lib/security-headers";
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
 * #637 "View as" impersonation: `/api/impersonation*` joins the coarse gate
 * exactly like `/api/edit*` — an unauthenticated request gets a bare 401; the
 * route handler runs the authoritative R1 (`canImpersonate`, an LDAPS check
 * that cannot run in Edge) and the 404-when-flag-off. Middleware adds only a
 * cheap Edge-safe `IMPERSONATION_ENABLED` short-circuit: when the flag is unset
 * the feature is dark, so the route 404s before any handler work — `process.env`
 * is readable in the Edge runtime, but `isSuperuser` (`lib/auth/superuser.ts`,
 * Node-only `ldapts`) is NOT, and is deliberately never imported here.
 *
 * Edge-safe: imports only `lib/auth/session.ts` (iron-session + config), never
 * `saml.ts` (Node-only), `superuser.ts` (Node-only), or `session-server.ts`
 * (`next/headers`).
 */
/**
 * Attach the runtime Content-Security-Policy headers (#374) to a response.
 *
 * Emitted here, in middleware, rather than from `next.config.ts` `headers()`:
 * that function is evaluated at `next build` and frozen into the routes
 * manifest, so `SECURITY_CSP_MODE` read there can never flip a deployed image
 * (proven on staging 2026-06-08 — a task-def env change left the baked
 * report-only header unchanged). Middleware runs per request, so the env is
 * read live and a task-def flip + service roll promotes the policy with no
 * rebuild. See lib/security-headers.ts.
 *
 * Apply ONLY to document responses (`NextResponse.next()`). It must NOT wrap a
 * redirect: this middleware emits 301/302 responses with a **relative**
 * `Location` (the request host is the internal container address behind the
 * proxy, so an absolute redirect is unreachable — see the SSO branch). Setting
 * a header on an already-constructed redirect makes the edge runtime re-finalize
 * the response and re-parse that relative `Location` through `new URL()`, which
 * throws `TypeError: Invalid URL` and 500s the route (regressed `/edit` when it
 * first shipped). Redirects and bodyless 401/404s carry no document, so they
 * need no CSP anyway — return them directly. The browser gets the CSP on the
 * page it lands on, which is itself a `next()` response.
 */
function withSecurityHeaders(response: NextResponse): NextResponse {
  const cspHeaders = buildCspResponseHeaders({
    isProduction: process.env.NODE_ENV === "production",
    cspMode: resolveCspMode(process.env.SECURITY_CSP_MODE),
  });
  for (const { key, value } of cspHeaders) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * The path prefixes the SSO gate + legacy-redirect logic below acts on — the
 * original `config.matcher` set. The matcher is now broadened to every
 * non-static request so the CSP covers every document, which means this
 * function runs on public pages too; gating must therefore stay explicitly
 * scoped to these prefixes. A path outside them is a pass-through that only
 * receives the security headers — a public page must NEVER reach the gate.
 */
function isGatedOrLegacyPath(pathname: string): boolean {
  return (
    pathname === "/edit" ||
    pathname.startsWith("/edit/") ||
    pathname === "/api/edit" ||
    pathname.startsWith("/api/edit/") ||
    pathname === "/api/impersonation" ||
    pathname.startsWith("/api/impersonation/") ||
    pathname.startsWith("/display/") ||
    pathname.startsWith("/individual/") ||
    pathname.startsWith("/profile/")
  );
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Public fast path. The broadened matcher (for CSP coverage) runs this on
  // every non-static request, but the SSO gate + legacy redirects apply only to
  // the prefixes in isGatedOrLegacyPath. Everything else — every public page,
  // every non-edit API route — passes straight through with only the security
  // headers attached, never touching the session or the gate.
  if (!isGatedOrLegacyPath(request.nextUrl.pathname)) {
    return withSecurityHeaders(NextResponse.next());
  }

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
      // Redirect (relative Location): returned directly, NOT through
      // withSecurityHeaders — see its doc for why mutating a redirect 500s.
      return new NextResponse(null, {
        status: 301,
        headers: { Location: `/scholars/by-cwid/${cwid}` },
      });
    }
    // Out-of-set CWID -- not in the academic-faculty roster. Fall through
    // so the existing 404 handling renders without a redirect.
    return withSecurityHeaders(NextResponse.next());
  }

  // #637 — flag-off short-circuit. When `IMPERSONATION_ENABLED` is unset the
  // whole feature is dark: the route handlers 404, the switcher hides, any
  // overlay is ignored. Mirror the 404 at the edge so a flag-off deployment
  // never reaches the handler (cheap; `process.env` is Edge-readable). Runs
  // before the session gate so the response is a 404, not a 401, regardless of
  // auth state — exactly what the handler returns (spec §5/§7).
  if (
    request.nextUrl.pathname.startsWith("/api/impersonation") &&
    process.env.IMPERSONATION_ENABLED !== "true"
  ) {
    return new NextResponse(null, { status: 404 });
  }

  let authenticated = false;
  try {
    authenticated = (await getSessionFromRequest(request)) !== null;
  } catch {
    // Misconfigured (e.g. SESSION_COOKIE_SECRET unset) — fail toward
    // "unauthenticated" so the gate stays closed rather than 500ing the page.
    authenticated = false;
  }
  if (authenticated) return withSecurityHeaders(NextResponse.next());

  // Unauthenticated below this point.
  if (
    request.nextUrl.pathname.startsWith("/api/edit") ||
    request.nextUrl.pathname.startsWith("/api/impersonation")
  ) {
    // API route: 401, empty body — no redirect, no leakage
    // (#100 AC; self-edit-spec.md edge case 16; #637 §7 — "no session" ⇒ 401).
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

  // Redirect (relative Location): returned directly, NOT through
  // withSecurityHeaders — see its doc for why mutating a redirect 500s.
  return new NextResponse(null, {
    status: 302,
    headers: { Location: `/api/auth/saml/login?return=${encodeURIComponent(returnTo)}` },
  });
}

export const config = {
  // Run on every request except Next's own static output and the favicon, so the
  // runtime CSP (#374) covers every HTML document. This is deliberately broader
  // than the gated/legacy prefixes — the SSO gate stays scoped inside
  // middleware() via isGatedOrLegacyPath, so broadening the matcher widens only
  // header coverage, never the auth gate. Static assets (`_next/static`,
  // `_next/image`) keep the build-time static headers from next.config and need
  // no per-request CSP.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
