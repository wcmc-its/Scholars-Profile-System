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
 * SPEC §7.1 + §7.1.1. Resolve the active concept-mode.
 *
 *   `SEARCH_PUB_TAB_CONCEPT_MODE` set ∈ {strict, expanded, off} → that value
 *   unset:
 *     legacy `SEARCH_PUB_TAB_OR_OF_EVIDENCE=off` → "off"
 *     legacy `SEARCH_PUB_TAB_OR_OF_EVIDENCE=on`  → "strict"
 *                                                  (operator explicitly chose
 *                                                  the §1.6 admission shape;
 *                                                  preserve that intent —
 *                                                  bumping silently to
 *                                                  `expanded` would be a
 *                                                  scope expansion they
 *                                                  didn't ask for)
 *     legacy unset                               → "expanded" (PR-4 default;
 *                                                  the §5.2 four-clause shape)
 *
 * To roll back the PR-4 flip: set `SEARCH_PUB_TAB_CONCEPT_MODE=strict` in the
 * env. The legacy `SEARCH_PUB_TAB_OR_OF_EVIDENCE` fallback is removed in a
 * follow-up minor release after operators set the new env in every
 * environment (SPEC §7.1.1 retirement plan).
 */
export function resolveConceptMode(): ConceptMode {
  const v = process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
  if (v === "strict" || v === "expanded" || v === "off") return v;
  if (process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE === "off") return "off";
  if (process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE === "on") return "strict";
  return "expanded";
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
