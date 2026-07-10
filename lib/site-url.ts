/**
 * Canonical public site origin, resolved at RUNTIME.
 *
 * `SITE_URL` is set per-environment in the ECS task definition and read at
 * request time. `NEXT_PUBLIC_SITE_URL` is inlined by Next at BUILD time — and
 * it is never set in the built image, so relying on it baked the hardcoded
 * production fallback into robots.txt / sitemap.xml / llms.txt / JSON-LD on
 * every environment (#1514). Prefer the runtime value; keep the build-time var
 * and the production origin as the fallback chain (the latter is the correct
 * default for static/prerender contexts where neither env var is present).
 *
 * Zero imports on purpose: safe to pull into any server module (sitemap, SEO
 * JSON-LD, slug-request emails) without dragging heavier dependencies along.
 */
export function siteBaseUrl(): string {
  return (
    process.env.SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://scholars.weill.cornell.edu"
  );
}
