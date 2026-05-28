/**
 * Security response headers applied to every route — issue #120 (B21).
 *
 * Set in `next.config.ts` via `headers()` rather than at a CDN edge: the
 * project has no production environment yet (#99 backlog), so the policy lives
 * in the app and travels with every deploy. Once a CloudFront layer exists the
 * same values can move to a response-headers policy unchanged.
 *
 * The Content-Security-Policy is **flag-gated** between report-only and
 * enforcing modes (#374). `SECURITY_CSP_MODE=enforce` ships the policy as the
 * enforcing `Content-Security-Policy` header; any other value (including
 * unset) keeps it as `Content-Security-Policy-Report-Only`, the default.
 * The policy **value** is identical in both modes (per docs/ADR-007 §
 * Decision); only the header key changes, so flipping the flag is a name
 * swap reversible by flipping it back. The intended rollout is to leave the
 * default `report-only` until a launch-time observation window confirms a
 * clean violation feed, then set `SECURITY_CSP_MODE=enforce` in prod.
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
 * A nonce-based strict policy is incompatible with the app's static/ISR
 * rendering and is rejected (docs/ADR-007); `script-src-attr 'none'` blocks
 * the inline event-handler vector instead. `'unsafe-inline'` still lets
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
    // `'unsafe-inline'` above is required for Next's inline bootstrap and
    // hydration <script> blocks; it would also permit inline event-handler
    // attributes (onerror=, onclick=), but React binds handlers in JS and
    // never serializes them as attributes — so `'none'` here blocks that
    // injection vector with no first-party regression. See docs/ADR-007.
    "script-src-attr": "'none'",
    "style-src": "'self' 'unsafe-inline'",
    // Every client fetch targets a same-origin route handler.
    "connect-src": connectSrc.join(" "),
    // Violations POST to the in-app collector (/api/csp-report), logged as
    // structured lines for the report-only observation window (#374).
    // `report-uri` is honored by every current browser; `report-to` is its
    // Reporting-API successor and targets the `csp-endpoint` group named by
    // the Reporting-Endpoints header. Both are sent; the collector accepts
    // either payload.
    "report-uri": "/api/csp-report",
    "report-to": "csp-endpoint",
  };

  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");
}

/** CSP rollout mode. `report-only` is the default; `enforce` flips the header key. */
export type CspMode = "report-only" | "enforce";

/**
 * Resolve the CSP mode from an env value. Defaults to `report-only` for any
 * unset or unrecognized value so a typo in the env config can never silently
 * promote the policy. Accepts `enforce` (with case/whitespace tolerance) as
 * the single opt-in value.
 */
export function resolveCspMode(raw: string | undefined): CspMode {
  return raw?.trim().toLowerCase() === "enforce" ? "enforce" : "report-only";
}

/**
 * The full security-header set applied to every response.
 *
 * HSTS, X-Frame-Options, X-Content-Type-Options and Referrer-Policy are the
 * four static headers named by #120. Permissions-Policy completes the set by
 * denying powerful browser features this app never uses. Reporting-Endpoints
 * names the `csp-endpoint` collector that the CSP `report-to` directive
 * targets. The CSP header key is selected by `cspMode`; the policy value is
 * the same in both modes.
 */
export function buildSecurityHeaders(opts: {
  isProduction: boolean;
  cspMode?: CspMode;
}): ResponseHeader[] {
  const cspMode: CspMode = opts.cspMode ?? "report-only";
  const cspHeaderKey =
    cspMode === "enforce"
      ? "Content-Security-Policy"
      : "Content-Security-Policy-Report-Only";

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
      // Defines the `csp-endpoint` group the CSP `report-to` directive
      // targets — the Reporting-API counterpart of `report-uri` (#374).
      key: "Reporting-Endpoints",
      value: 'csp-endpoint="/api/csp-report"',
    },
    {
      key: cspHeaderKey,
      value: buildContentSecurityPolicy({ isProduction: opts.isProduction }),
    },
  ];
}
