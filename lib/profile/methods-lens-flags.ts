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

/**
 * Standalone cross-scholar Method pages gate (`/methods/**`). When off, every
 * `/methods/**` route `notFound()`s, the search candidate/suggest contributions
 * are suppressed, and the per-scholar inbound links are not rendered. Default
 * off, so the page surface ships dark independent of the data substrate.
 *
 * NOTE: a Method page ALSO requires `isMethodsLensEnabled()` — that master flag
 * gates the `scholar_family` data substrate. `METHODS_LENS_PAGES` is the
 * page/surface gate layered on top; turning it on without the master flag leaves
 * the loaders returning empty (the master gate short-circuits first), so a page
 * still `notFound()`s. `METHODS_LENS_SENSITIVE_GATE` continues to govern #801
 * sensitivity exactly as today. Wire this flag in BOTH `.env.local` AND the
 * per-env `environment:` block in cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isMethodPagesEnabled(): boolean {
  return process.env.METHODS_LENS_PAGES === "on";
}

/**
 * #819 — makes the Methods-lens family rows clickable to filter the scholar's
 * publication list (mirrors the Topics click-to-filter). Off by default; turning
 * it on only changes the UI affordance — the `ScholarFamily.pmids` membership is
 * populated by the ETL unconditionally, so flipping this never 500s. Depends on
 * `METHODS_LENS_ENABLED` (no families render when the master gate is off). Wire in
 * BOTH `.env.local` AND cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isMethodsLensFamilyFilterOn(): boolean {
  return process.env.METHODS_LENS_FAMILY_FILTER === "on";
}

/**
 * #862 — backfills the supercategory page's per-family "Top scholars" row with
 * attributed non-faculty (postdocs/fellows/core staff/instructors), faculty-first,
 * when the FT-faculty set is empty or short — so a trainee/core-driven family
 * renders a row instead of an empty one. Default OFF: the row stays FT-faculty-only
 * (byte-identical to the pre-#862 behavior, matching the External/Faculty Affairs
 * sign-off on the FT-faculty framing) until the per-family roster relaxation is
 * approved. doctoral_student/affiliate_alumni are NEVER surfaced regardless — the
 * `isPubliclyDisplayed` gate is independent of this flag. The tooltip copy on the
 * row tracks this flag (carried in the /scholars API response), so the eventual
 * flip is env-only. Wire in BOTH `.env.local` AND the per-env `environment:` block
 * in cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isMethodsFamilyRosterFallbackOn(): boolean {
  return process.env.METHODS_LENS_FAMILY_ROSTER_FALLBACK === "on";
}

/**
 * #879 — shows the NLM MeSH scope-note definition on a /methods family page when
 * a CURATED `mesh_curated_family_anchor` row maps that family to a descriptor.
 * Default OFF (data prereq: curated rows must be seeded before any definition is
 * meaningful), so it's a `=== "on"` opt-in gate, not the `!== "off"` kill-switch.
 * `getFamilyMeshDefinition` checks this first and returns null when off, so the
 * page does zero extra DB work and the JSON-LD `description` stays null
 * (byte-identical to today). Wire in BOTH `.env.local` AND the per-env
 * `environment:` block in cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isMethodsLensMeshDefinitionsEnabled(): boolean {
  return process.env.METHODS_LENS_MESH_DEFINITIONS === "on";
}
