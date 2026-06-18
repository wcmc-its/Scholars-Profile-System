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
 * #879 — renders ReciterAI's generated per-family `definition` (tools-a2-v3
 * passthrough) on the family page + the profile methods hover, with an
 * "AI-generated" disclaimer gated on `definition_source === "generated"`. Default
 * OFF: the column is populated by the ETL unconditionally, but nothing renders —
 * and the family page does not even READ the definition (no DefinedTerm JSON-LD /
 * SEO side channel) — until this flips, so the generated copy ships dark pending
 * External Affairs sign-off, independent of the methods-lens / Method-pages
 * rollout. RENDER-ONLY: the definition is never fed back into any LLM/embedding/
 * retrieval. Wire in BOTH `.env.local` AND the per-env `environment:` block in
 * cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isMethodsFamilyDefinitionsOn(): boolean {
  return process.env.METHODS_LENS_FAMILY_DEFINITIONS === "on";
}

/**
 * #962 — the center-roster "Methods & tools" multi-select facet + per-member
 * tool chips on the GROUPED center roster. ADDITIONALLY gated on
 * METHODS_LENS_ENABLED (the `scholar_family` substrate): if the methods lens is
 * off, this is off, so a center page never queries `scholar_family` and the
 * server payload carries no family data (no SEO/JSON side channel). When off: no
 * extra query, no facet, no chips. Surfaces PUBLIC families only (same #800/#801
 * overlay gate as the lens), so the CloudFront-cacheable center page stays
 * cacheable — no per-request/per-viewer call. Wire in BOTH `.env.local` AND the
 * per-env `environment:` block in cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isCenterMethodsFacetEnabled(): boolean {
  return isMethodsLensEnabled() && process.env.CENTER_METHODS_FACET === "on";
}

/**
 * #974 — per-member "method chips" (top-3 public method families) on the
 * DEPARTMENT and DIVISION roster rows. ADDITIONALLY gated on METHODS_LENS_ENABLED
 * (the `scholar_family` substrate): off → no extra query, no chips, no family data
 * in the payload (no SEO/JSON side channel). PUBLIC families only (same #800/#801
 * overlay gate as the lens), so the CloudFront-cacheable roster page stays
 * cacheable — a plain DB read keyed on the page's ≤20 CWIDs, no per-viewer call.
 * Phase 1 is CHIPS ONLY (no facet, no whole-dataset aggregation — that's Phase 2).
 * Wire in BOTH `.env.local` AND the per-env block in cdk/lib/app-stack.ts per the
 * flag-parity rule.
 */
export function isOrgUnitMethodsChipsEnabled(): boolean {
  return isMethodsLensEnabled() && process.env.ORG_UNIT_METHODS_CHIPS === "on";
}

/**
 * #974 Phase 2 — the DEPARTMENT/DIVISION roster "Methods & tools" multi-select
 * FACET (server-aggregated buckets rendered with the cacheable page + a
 * client-fetch to the uncacheable `/api/units/[kind]/[code]/members` route for the
 * filtered roster). ADDITIONALLY gated on METHODS_LENS_ENABLED (the
 * `scholar_family` substrate): off → no aggregation, no sidebar, no API data, no
 * payload (the off-path roster response is byte-identical to today). Independent of
 * ORG_UNIT_METHODS_CHIPS (Phase 1) so the facet can ship/flip separately. PUBLIC
 * families only (same #800/#801 overlay gate) — the buckets, the selectable
 * families, AND the returned chips. The buckets are viewer-independent, so the page
 * stays CloudFront-cacheable; only the `force-dynamic` API route filters per
 * request. Wire in BOTH `.env.local` AND the per-env block in
 * cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isOrgUnitMethodsFacetEnabled(): boolean {
  return isMethodsLensEnabled() && process.env.ORG_UNIT_METHODS_FACET === "on";
}

/**
 * Method-family search SYNONYMS. When on, `matchQueryToTaxonomy` also matches a
 * method family against its curated lay-term / brand / acronym synonyms
 * (`lib/methods/family-synonyms.ts`) via whole-word-window exact match — so e.g.
 * "Seahorse" reaches `extracellular flux respirometry` and "FACS" reaches `flow
 * cytometry assays`, which the canonical substring matcher (`matchKey.includes`)
 * cannot. ADDITIONALLY gated on `isMethodPagesEnabled()` (method candidates are
 * only loaded then), so off → byte-identical to today (no synonym pass). Match-only:
 * no DB, no ETL, no reindex. Wire in BOTH `.env.local` AND the per-env block in
 * cdk/lib/app-stack.ts per the flag-parity rule.
 */
export function isMethodFamilySynonymsEnabled(): boolean {
  return isMethodPagesEnabled() && process.env.METHODS_LENS_FAMILY_SYNONYMS === "on";
}

/**
 * #1105/#1117 — dedicated per-program pages for a center
 * (`/centers/[slug]/programs/[code]`), modeled on division pages, with the
 * program's leaders (one LeaderCard each — a program may be co-led, #1117) + a
 * prose description. When off, the route `notFound()`s and the center page's
 * program section headers stay plain text (no links). Standalone (NOT gated on
 * the methods lens) and default OFF, so the surface ships dark — the
 * `CenterProgramLeader` rows + `CenterProgram.description` are curated
 * independently (via `/edit/center/[code]` → Programs). Wire in BOTH `.env.local`
 * AND the per-env `environment:` block in cdk/lib/app-stack.ts per the
 * flag-parity rule.
 */
export function isCenterProgramPagesEnabled(): boolean {
  return process.env.CENTER_PROGRAM_PAGES === "on";
}
