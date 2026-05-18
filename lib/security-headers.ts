/**
 * Security response headers applied to every route — issue #120 (B21).
 *
 * Set in `next.config.ts` via `headers()` rather than at a CDN edge: the
 * project has no production environment yet (#99 backlog), so the policy lives
 * in the app and travels with every deploy. Once a CloudFront layer exists the
 * same values can move to a response-headers policy unchanged.
 *
 * The Content-Security-Policy ships as **report-only**: the browser reports
 * violations to its console but blocks nothing, so an imperfect policy cannot
 * break a page. Promoting it to the enforcing `Content-Security-Policy` header
 * is a deliberate later step, after the observation window (#120 AC).
 */

/** One response header, shaped for `next.config.ts` `headers()`. */
export interface ResponseHeader {
  key: string;
  value: string;
}

/**
 * Build the Content-Security-Policy value.
 *
 * `script-src` and `style-src` keep `'unsafe-inline'`: the Next.js App Router
 * injects inline bootstrap/hydration scripts and inline styles on every page.
 * A nonce-based strict policy would require per-request middleware on all
 * routes and is deferred to the enforcement step. `'unsafe-inline'` still lets
 * the report-only window catch the highest-value regression — any *external*
 * origin (script, style, image, font, XHR) absent from this allowlist is
 * reported.
 *
 * In development the Turbopack dev server needs `'unsafe-eval'` for React
 * Refresh and `ws:`/`wss:` for its hot-reload socket. Those relaxations are
 * gated to dev so the production policy stays tighter.
 */
export function buildContentSecurityPolicy(opts: {
  isProduction: boolean;
}): string {
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  const connectSrc = ["'self'"];
  if (!opts.isProduction) {
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push("ws:", "wss:");
  }

  const directives: Record<string, string> = {
    "default-src": "'self'",
    "base-uri": "'self'",
    "object-src": "'none'",
    "frame-ancestors": "'none'",
    "frame-src": "'none'",
    "form-action": "'self'",
    // next/font self-hosts Inter; no font CDN is contacted at runtime.
    "font-src": "'self'",
    // Headshots come from directory.weill.cornell.edu, which matches
    // images.remotePatterns in next.config.ts. data:/blob: cover the
    // next/image placeholders and any client-rendered previews.
    "img-src": "'self' data: blob: https://directory.weill.cornell.edu",
    "script-src": scriptSrc.join(" "),
    "style-src": "'self' 'unsafe-inline'",
    // Every client fetch targets a same-origin route handler.
    "connect-src": connectSrc.join(" "),
    // Violations POST to the in-app collector, which logs them as structured
    // lines — the sink for the report-only observation window (#374).
    "report-uri": "/api/csp-report",
  };

  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");
}

/**
 * The full security-header set applied to every response.
 *
 * HSTS, X-Frame-Options, X-Content-Type-Options and Referrer-Policy are the
 * four static headers named by #120. Permissions-Policy completes the set by
 * denying powerful browser features this app never uses. The CSP is
 * report-only.
 */
export function buildSecurityHeaders(opts: {
  isProduction: boolean;
}): ResponseHeader[] {
  return [
    {
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains; preload",
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    },
    {
      key: "Content-Security-Policy-Report-Only",
      value: buildContentSecurityPolicy(opts),
    },
  ];
}
