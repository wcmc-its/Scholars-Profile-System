/**
 * Issue #259 SPEC §5 + §6 + §7.1 — single source of truth for pub-tab
 * concept-mode flag resolution and `?mesh=` URL-param parsing.
 *
 * Three consumers agree on the same rules by importing from here:
 *   - `lib/api/search.ts` (body construction)
 *   - `app/api/search/route.ts` (JSON API request handling)
 *   - `app/(public)/search/page.tsx` (SSR page)
 *
 * Pure functions, no DB/Prisma/OpenSearch dependency — safe to import from a
 * Server Component as well as the API route and lib code.
 */

export type ConceptMode = "strict" | "expanded" | "off";

/**
 * SPEC §7.1. Resolve the active concept-mode.
 *
 *   `SEARCH_PUB_TAB_CONCEPT_MODE` set ∈ {strict, expanded, off} → that value
 *   otherwise → "expanded" (PR-4 default; the §5.2 four-clause shape)
 *
 * To roll back the PR-4 flip: set `SEARCH_PUB_TAB_CONCEPT_MODE=strict`.
 */
export function resolveConceptMode(): ConceptMode {
  const v = process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
  if (v === "strict" || v === "expanded" || v === "off") return v;
  return "expanded";
}

export type PeopleRelevanceMode = "legacy" | "v3";

/**
 * SPEC §12 PR-5 (#312). Resolve the active People-tab relevance mode — the
 * single source of truth shared by the API route and the SSR page so the
 * server-rendered result set and any subsequent /api/search call rank
 * identically.
 *
 *   `SEARCH_PEOPLE_RELEVANCE_MODE=legacy` → "legacy" (emergency rollback: the
 *     #259 restructured cross_fields body for every shape, no §6.1 templates)
 *   otherwise (unset / "v3") → "v3" (PR-5 default: the §6.1 shape-routed
 *     name / topic / department / hybrid templates)
 *
 * Default flipped from "legacy" to "v3" in PR-5. An unrecognized value logs a
 * warning and falls through to the "v3" default.
 */
export function resolvePeopleRelevanceMode(): PeopleRelevanceMode {
  const v = process.env.SEARCH_PEOPLE_RELEVANCE_MODE;
  if (v && v !== "legacy" && v !== "v3") {
    console.warn(
      `[search] ignoring unrecognized SEARCH_PEOPLE_RELEVANCE_MODE="${v}"; using "v3"`,
    );
  }
  return v === "legacy" ? "legacy" : "v3";
}

/**
 * SPEC §6.2. Parse `?mesh=…` honoring off-wins precedence regardless of URL
 * order. Accepts either a Web `URLSearchParams` (route handler) or a Next.js
 * searchParams object (page) — same precedence applied at both call sites by
 * construction.
 *
 * `meshOff` true when any value equals "off".
 * `meshStrict` true when any value equals "strict" AND `meshOff` is false.
 * Both false when the param is absent or carries an unknown value.
 */
export function parseMeshParam(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): { meshOff: boolean; meshStrict: boolean } {
  let values: string[];
  if (source instanceof URLSearchParams) {
    values = source.getAll("mesh");
  } else {
    const raw = source.mesh;
    values = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  }
  const meshOff = values.includes("off");
  const meshStrict = !meshOff && values.includes("strict");
  return { meshOff, meshStrict };
}

/**
 * Issue #295 — funding-tab concept clause. When `on`, `searchFunding` adds a
 * resolved-MeSH OR-of-evidence clause so a concept query also matches NIH
 * grants by descriptor. Default `off`: it stays off until the funding index
 * has been rebuilt with the `meshDescriptorUi` field (issue #295 PR 1).
 *
 * Deliberately a separate flag from `SEARCH_PUB_TAB_CONCEPT_MODE` — the two
 * surfaces have independent rollback triggers, the same reason
 * `PUBLICATIONS_RESTRUCTURED_MSM` is defined apart from its people-tab twin.
 */
export function resolveFundingConceptEnabled(): boolean {
  return process.env.SEARCH_FUNDING_TAB_CONCEPT === "on";
}
