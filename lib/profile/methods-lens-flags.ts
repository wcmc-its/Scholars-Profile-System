/**
 * #799/#801 — feature flags for the family-primary Methods lens. Server-only
 * (read at request time in the profile data layer), so a client component never
 * needs the value — when disabled, `families` simply does not flow to the page.
 *
 * Both default OFF, so the lens ships dark. To turn either on in a deployed env,
 * set the env var to "on" in BOTH `.env.local` (local) AND the per-env
 * `environment:` block in cdk/lib/app-stack.ts, then `cdk deploy Sps-App-<env>`
 * (CD only re-rolls the image; it does not pick up new env keys) — the flag
 * parity rule. Wiring the flag in only one place is a silent shipping bug.
 */

/**
 * Master render gate for the Methods lens. When off, the data layer returns no
 * families, so nothing renders and no JSON/SEO side channel can leak — even
 * after the `scholar_family` rollup is populated (the `SCHOLAR_TOOL_SOURCE=s3`
 * cutover). Lets the whole feature merge dark, independent of the ETL flip.
 */
export function isMethodsLensEnabled(): boolean {
  return process.env.METHODS_LENS_ENABLED === "on";
}

/**
 * #801 audience-gating. When on, families matching the curated sensitivity
 * overlay are omitted from the (CloudFront-cached, public) profile payload.
 * Default off, pending External Affairs policy sign-off on the curated subset.
 * The richer self/admin reveal of gated families is a separate, later affordance
 * (a client-fetched route) — not this server-side public-payload omission.
 */
export function isMethodsLensSensitiveGateOn(): boolean {
  return process.env.METHODS_LENS_SENSITIVE_GATE === "on";
}
