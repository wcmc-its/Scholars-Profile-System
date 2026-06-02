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

/**
 * Issue #532 — dept-shape leadership boost (chair / division chief). When
 * on, the People-tab `department_template` (#311 / SPEC §6.1.4) wraps its
 * body in a multiplicative `function_score` that promotes the dept's chair
 * (and, in future, the chief of a queried division) above other dept members.
 * The signal source is `leadership.chairOf` / `leadership.chiefOf` on the
 * scholars-people doc, populated from `Department.chairCwid` /
 * `Division.chiefCwid` (which already reflect ADR-002 prediction + Path C
 * manual overrides).
 *
 * Default `on` — confirmed against the local §3.2 eval (2026-05-28) on a
 * reindexed cluster: the boost promotes the actual chair to rank-1 on
 * both labeled dept queries (Sallie Permar on `pediatrics`, Rainu Kaushal
 * on `population health sciences`) without displacing previously-top-3
 * labeled hits. `SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST=off` is the
 * emergency rollback. Safe before the post-launch reindex too: the term
 * filter against a not-yet-indexed `leadership.chairOf` simply does not
 * fire, so dept ranking falls back to the pre-#532 body.
 *
 * Deliberately a separate flag from `SEARCH_PEOPLE_RELEVANCE_MODE` so the
 * v3 default established by PR #526 has an independent rollback lever
 * from this orthogonal signal.
 */
export function resolveDeptLeadershipBoost(): boolean {
  return process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST !== "off";
}

/**
 * Issue #688 — surface MeSH match provenance on People results. When a
 * topic/unclassified search resolves to a descriptor, the §6.1.3 attribution
 * boost ranks up scholars tagged with a *narrower* descendant term than the
 * one typed (e.g. `Microbiome` surfacing a `Mycobiome` scholar). With this on,
 * each such hit carries the narrower term(s) so the UI can explain the match;
 * the query-keyed highlighter can't (the typed term isn't in the scholar's
 * text). Pure additive metadata — no effect on ranking or the result set.
 *
 * Default off until eval; this is an explainability/UX change, not a ranking
 * change, so it gets its own lever independent of `SEARCH_PEOPLE_RELEVANCE_MODE`.
 */
export function resolvePeopleMatchProvenance(): boolean {
  return process.env.SEARCH_PEOPLE_MATCH_PROVENANCE === "on";
}

export type PubRecencyMode = "off" | "gentle" | "strong";

/**
 * Issue #645 — recency tilt on the pub-tab Relevance sort. By default
 * Relevance is pure BM25 (no recency signal), so a foundational old paper can
 * out-score recent work on a broad query (e.g. a c.1999 paper at the top of
 * `q=cancer`). This wraps the relevance-path query in a multiplicative
 * `function_score` Gaussian decay on the indexed `year` field so keyword match
 * stays primary while recent papers get a bounded lift.
 *
 *   `off`    — no wrapper; `body.query` byte-identical to the pre-#645 shape
 *              (emergency rollback; also the §7.2 byte-identical target).
 *   `gentle` — **Default.** Bounded-additive `1 + W·gauss(year)`, ceiling 3×:
 *              oldest papers floored at 1× BM25 (never penalized below it),
 *              freshest lifted up to 3×. Calibrated to a ≈3:1 current-vs-2001
 *              ratio (offset 2, scale 8, decay 0.5, W=2). See
 *              `docs/search-recency-relevance-spec.md` §5.
 *   `strong` — pure multiplicative `gauss(year)`; damps old papers toward
 *              (never to) zero. Escalation lever, not the default.
 *
 * Deliberately a separate flag from `SEARCH_PUB_TAB_*` (concept mode, MSM,
 * impact) so it carries an independent rollback trigger. Applies only on the
 * relevance sort path; explicit `year`/`citations`/`impact`/`recency` sorts
 * override `_score` and are left unwrapped. An unrecognized value falls
 * through to the `gentle` default.
 */
export function resolvePubRecencyMode(): PubRecencyMode {
  const v = process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  if (v === "off" || v === "gentle" || v === "strong") return v;
  return "gentle";
}
