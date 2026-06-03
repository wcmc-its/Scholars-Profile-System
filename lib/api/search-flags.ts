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

export type Scope = "exact" | "expanded" | "concept";

/**
 * PLAN R2/R6 — the user-facing match-scope: one control replacing the split
 * `?mesh=` + `SEARCH_*_CONCEPT_MODE` primitives. Three values; default
 * "expanded" (today's union). Parses `?match=exact|expanded|concept`; when
 * `match` is absent the legacy `?mesh=` param maps in for one release
 * (`mesh=off` → exact, `mesh=strict` → concept; off wins, matching
 * `parseMeshParam`). Anything unrecognized → "expanded".
 *
 * Accepts a Web `URLSearchParams` (route handler) or a Next.js searchParams
 * object (page), same as `parseMeshParam`.
 */
export function parseScopeParam(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): Scope {
  const valuesOf = (key: string): string[] => {
    if (source instanceof URLSearchParams) return source.getAll(key);
    const raw = source[key];
    return Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  };
  const match = valuesOf("match");
  if (match.includes("exact")) return "exact";
  if (match.includes("concept")) return "concept";
  if (match.includes("expanded")) return "expanded";
  // Back-compat alias: legacy `?mesh=` (off wins over strict, per parseMeshParam).
  const mesh = valuesOf("mesh");
  if (mesh.includes("off")) return "exact";
  if (mesh.includes("strict")) return "concept";
  return "expanded";
}

/**
 * Bridge the user-facing scope onto the existing query levers
 * (`meshOff` / `meshStrict`) so the proven concept-mode machinery in
 * `searchPublications` / `searchFunding` is reused unchanged:
 *
 *   exact    → meshOff    (null resolution → literal-only admission)
 *   expanded → neither    (today's default union; byte-identical)
 *   concept  → meshStrict (concept-only admission, today's `concept_filtered`)
 *
 * Keeping this a pure mapping makes the `expanded` default byte-identical to the
 * pre-scope query, and lets `exact`/`concept` ride the already-tested `?mesh=`
 * paths. (People result-set gating is deferred to its own phase.)
 */
export function scopeToMeshParams(scope: Scope): { meshOff: boolean; meshStrict: boolean } {
  return { meshOff: scope === "exact", meshStrict: scope === "concept" };
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
 * PLAN P4 — funding-tab per-result reason lines. When `on`, `searchFunding`
 * adds a funding title highlight, reads `matched_queries` to flag the
 * concept-admission path, and runs a query-time pub-index aggregation to count
 * each grant's on-topic funded publications (X of Y). Default `off`.
 *
 * No reindex: X is computed at QUERY TIME against the publications index using
 * the funded pmids the funding hit already carries (mirrors the People-tab
 * `reasonCounts` aggregation). Pure presentation metadata — no effect on the
 * funding query predicate, scoring, or result SET (the `_name` tags added under
 * this flag are score-neutral; the `scope`-driven admission is governed by
 * `resolveFundingConceptEnabled`, not this flag). A separate lever from
 * `SEARCH_FUNDING_TAB_CONCEPT` so the reason UI and the concept admission roll
 * back independently.
 */
export function resolveFundingMatchReason(): boolean {
  return process.env.SEARCH_FUNDING_MATCH_REASON === "on";
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

/**
 * Issue #702 — People-result match explainability. People highlighting is keyed
 * to only three self-reported fields (`preferredName` / `areasOfInterest` /
 * `overview`), but topic relevance scores heavily on publication-derived fields
 * (`publicationTitles^6` / `publicationMesh^4`). A scholar admitted purely on
 * publication evidence therefore has nothing to highlight in the bio fields and
 * the card renders bare (≈86% of top topic-query results, measured). With this
 * on, `searchPeople`:
 *   - also highlights `publicationTitles` / `publicationMesh` so the card can
 *     render a "Matched in publications: …" snippet (`pubHighlight`), and
 *   - emits `matchedOnFields` (derived from which fields actually produced a
 *     highlight fragment) so the card can render a last-resort "Matched on …"
 *     chip when there is no snippet and no MeSH provenance note.
 * `publicationAbstracts` is deliberately NOT highlighted — a long, raw,
 * possibly-sensitive blob makes a poor snippet.
 *
 * Pure presentation metadata — no effect on the query predicate, scoring, or
 * result set. Default off until eval; a separate lever from
 * `SEARCH_PEOPLE_MATCH_PROVENANCE` (the MeSH "why this match" note) and from
 * `SEARCH_GENERIC_TERM_DEMOTE`, each with an independent rollback trigger.
 */
export function resolvePeopleMatchExplain(): boolean {
  return process.env.SEARCH_PEOPLE_MATCH_EXPLAIN === "on";
}

export type GenericTermMode = "off" | "resolve" | "on";

/**
 * Issue #692 — generic/filler-term demotion mode. A trailing generic word
 * ("Microbiome Research") breaks MeSH resolution and pollutes ranking/highlight.
 *
 *   - `off` (default): no change.
 *   - `resolve`: on a full-query resolution MISS, retry against the query with
 *     deprioritized terms stripped (recovers resolution + #688 provenance on
 *     multi-word queries). No ranking/result-set/highlight change. Safe — only
 *     fires after the full query already failed to resolve.
 *   - `on`: `resolve` plus BM25 down-weight (content gates, full query
 *     discounted) and highlight de-marking of the stripped terms.
 *
 * Staged like `resolveConceptMode` (off|strict|expanded); unknown value → `off`.
 */
export function resolveGenericTermMode(): GenericTermMode {
  const v = process.env.SEARCH_GENERIC_TERM_DEMOTE;
  if (v === "resolve" || v === "on") return v;
  if (v !== undefined && v !== "off") {
    console.warn(
      `[search] ignoring unrecognized SEARCH_GENERIC_TERM_DEMOTE="${v}"; using "off"`,
    );
  }
  return "off";
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

/**
 * Publications-tab term highlighting. Unlike the People tab, `searchPublications`
 * never requested a highlight, so a matched title rendered with no emphasis on
 * the query terms — a search-result page that doesn't show *why* a row matched.
 * When on, `searchPublications` highlights the `title` field (on the content
 * query when #692 demotion is active, so stripped generics aren't marked) and
 * emits `titleHighlight` for the row to render. Pure presentation metadata: no
 * effect on the query predicate, scoring, or result set.
 *
 * Default off until verified; a separate lever from the `SEARCH_PUB_TAB_*`
 * ranking flags and from the People-tab `SEARCH_PEOPLE_MATCH_EXPLAIN`, each with
 * an independent rollback trigger.
 */
export function resolvePublicationHighlight(): boolean {
  return process.env.SEARCH_PUB_HIGHLIGHT === "on";
}

/**
 * Publications-tab MeSH match provenance — the publications twin of the People
 * tab's `SEARCH_PEOPLE_MATCH_PROVENANCE` (#688). When a topic query resolves to
 * a descriptor, the concept-mode admission/boost (`terms { meshDescriptorUi:
 * descendantUis }`, #259) ranks up publications tagged with the descriptor or a
 * narrower descendant — a match the title highlighter can't explain when the
 * typed term isn't in the title. With this on, each such hit carries
 * `matchProvenance` (reusing the generalized `computeMatchProvenance`) so the row
 * can render the same "Why this match" note as the Scholars tab. Pure additive
 * metadata — no effect on ranking or the result set.
 *
 * Default off until eval; a separate lever from the People-tab provenance flag
 * and from `SEARCH_PUB_HIGHLIGHT`, each with an independent rollback trigger.
 */
export function resolvePublicationMatchProvenance(): boolean {
  return process.env.SEARCH_PUB_MATCH_PROVENANCE === "on";
}
