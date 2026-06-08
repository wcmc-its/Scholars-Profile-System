/**
 * Security response headers — issue #120 (B21), CSP rollout #374.
 *
 * The header set is split by **when its value is decided**:
 *
 *  - {@link buildSecurityHeaders} — the static headers (HSTS, X-Frame-Options,
 *    X-Content-Type-Options, Referrer-Policy, Permissions-Policy). Their values
 *    never change, so they are emitted from `next.config.ts` `headers()`, which
 *    Next bakes into the build-time routes manifest. That is correct for static
 *    values.
 *
 *  - {@link buildCspResponseHeaders} — the Content-Security-Policy (+ its
 *    `Reporting-Endpoints` pair). This is **flag-gated** between report-only and
 *    enforcing modes on `SECURITY_CSP_MODE` (#374), and the flag must be
 *    readable on a *deployed* image without a rebuild. `next.config.ts`
 *    `headers()` is evaluated at **build time** and frozen into the routes
 *    manifest — `process.env.SECURITY_CSP_MODE` there is read during
 *    `next build`, not per request — so a task-def env change could never flip
 *    a deployed image (proven on staging 2026-06-08). The CSP is therefore
 *    emitted from `middleware.ts`, which runs per request at runtime and reads
 *    the env live. The policy **value** is identical in both modes (docs/
 *    ADR-007 § Decision); only the header key changes, so the flip is a name
 *    swap reversible by flipping `SECURITY_CSP_MODE` back. Rollout: leave the
 *    default `report-only` until the observation window confirms a clean
 *    `/api/csp-report` feed, then set `=enforce` (staging first).
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
 * The static security headers (#120), emitted from `next.config.ts`
 * `headers()`.
 *
 * HSTS, X-Frame-Options, X-Content-Type-Options and Referrer-Policy are the
 * four headers named by #120. Permissions-Policy completes the set by denying
 * powerful browser features this app never uses. Every value here is constant,
 * so build-time evaluation in the routes manifest is correct — unlike the CSP,
 * which is env-gated and lives in {@link buildCspResponseHeaders} (see the
 * module doc above). These apply to all routes (`source: "/:path*"`), including
 * static assets the CSP middleware skips.
 */
export function buildSecurityHeaders(): ResponseHeader[] {
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
  ];
}

/**
 * The runtime CSP headers — emitted from `middleware.ts` per request so
 * `SECURITY_CSP_MODE` is read live (see the module doc above for why this
 * cannot live in `next.config.ts` `headers()`).
 *
 * Returns the `Reporting-Endpoints` group definition (the Reporting-API
 * counterpart of the policy's `report-uri`, naming the `/api/csp-report`
 * collector) paired with the Content-Security-Policy itself. The header *key*
 * is selected by `cspMode` — enforcing `Content-Security-Policy` vs
 * `Content-Security-Policy-Report-Only` — while the policy *value* is identical
 * in both modes, so the promotion is a reversible header-name swap.
 */
export function buildCspResponseHeaders(opts: {
  isProduction: boolean;
  cspMode: CspMode;
}): ResponseHeader[] {
  const cspHeaderKey =
    opts.cspMode === "enforce"
      ? "Content-Security-Policy"
      : "Content-Security-Policy-Report-Only";

  return [
    {
      key: "Reporting-Endpoints",
      value: 'csp-endpoint="/api/csp-report"',
    },
    {
      key: cspHeaderKey,
      value: buildContentSecurityPolicy({ isProduction: opts.isProduction }),
    },
  ];
}
