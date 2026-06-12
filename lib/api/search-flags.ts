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
 * grants by descriptor. Default `on`; `SEARCH_FUNDING_TAB_CONCEPT=off` rolls back
 * to literal-only admission (the `meshDescriptorUi` concept clause is indexed).
 *
 * Deliberately a separate flag from `SEARCH_PUB_TAB_CONCEPT_MODE` — the two
 * surfaces have independent rollback triggers, the same reason
 * `PUBLICATIONS_RESTRUCTURED_MSM` is defined apart from its people-tab twin.
 */
export function resolveFundingConceptEnabled(): boolean {
  return process.env.SEARCH_FUNDING_TAB_CONCEPT !== "off";
}

/**
 * PLAN P4 — funding-tab per-result reason lines. When `on`, `searchFunding`
 * adds a funding title highlight, reads `matched_queries` to flag the
 * concept-admission path, and runs a query-time pub-index aggregation to count
 * each grant's on-topic funded publications (X of Y). Default `on`
 * (`SEARCH_FUNDING_MATCH_REASON=off` rolls back).
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
  return process.env.SEARCH_FUNDING_MATCH_REASON !== "off";
}

/**
 * Funding reindex — which funding-index field the concept result-SET gate
 * filters on. When a query resolves to a descriptor and `scope=concept`,
 * `searchFunding` admits grants whose MeSH ∩ the resolved descendant set is
 * non-empty. Two candidate signals:
 *
 *   - `meshDescriptorUi` (**default**) — RePORTER *project* keywords. Always
 *     present in the funding index today; the safe pre-reindex value.
 *   - `fundedPubMeshUi` — the MeSH of the grant's *funded publications*, which
 *     matches the "Matched through X of Y funded publications" reason (higher
 *     fidelity). Only set `SEARCH_FUNDING_MESH_GATE=fundedPubMeshUi` AFTER the
 *     funding index has been reindexed with that field (lib/funding-projection.ts):
 *     flipping it before the reindex empties funding concept results because
 *     the field is absent on the live docs.
 *
 * Unknown values fall through to the safe `meshDescriptorUi` default.
 */
export function resolveFundingMeshGateField(): "meshDescriptorUi" | "fundedPubMeshUi" {
  return process.env.SEARCH_FUNDING_MESH_GATE === "fundedPubMeshUi"
    ? "fundedPubMeshUi"
    : "meshDescriptorUi";
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
 * Default on (`SEARCH_PEOPLE_MATCH_PROVENANCE=off` rolls back); this is an
 * explainability/UX change, not a ranking change, so it gets its own lever
 * independent of `SEARCH_PEOPLE_RELEVANCE_MODE`.
 */
export function resolvePeopleMatchProvenance(): boolean {
  return process.env.SEARCH_PEOPLE_MATCH_PROVENANCE !== "off";
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
 * result set. Default on (`SEARCH_PEOPLE_MATCH_EXPLAIN=off` rolls back); a separate lever from
 * `SEARCH_PEOPLE_MATCH_PROVENANCE` (the MeSH "why this match" note) and from
 * `SEARCH_GENERIC_TERM_DEMOTE`, each with an independent rollback trigger.
 */
export function resolvePeopleMatchExplain(): boolean {
  return process.env.SEARCH_PEOPLE_MATCH_EXPLAIN !== "off";
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
 * Default on (`SEARCH_PUB_HIGHLIGHT=off` rolls back); a separate lever from the `SEARCH_PUB_TAB_*`
 * ranking flags and from the People-tab `SEARCH_PEOPLE_MATCH_EXPLAIN`, each with
 * an independent rollback trigger.
 */
export function resolvePublicationHighlight(): boolean {
  return process.env.SEARCH_PUB_HIGHLIGHT !== "off";
}

/**
 * Issue #298 §6 — sparse-trigger arm of the concept-fallback co-render. When a
 * resolved-concept pub query returns a small handful of tagged hits (1..N) while
 * a broad-text search would return many more, the page co-renders the broad-text
 * results below the primary list (a divider band + a top-10 preview). This flag
 * gates ONLY the sparse-trigger arm; the zero-trigger arm (acceptance #1 — a
 * concept query with zero hits but a non-zero broad count) is unconditional, so
 * an operator can disable the sparser sparse path without losing the dead-end
 * escape on a truly empty concept page.
 *
 * Default on (`SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF=1` rolls back the sparse arm
 * only — any other value, including unset, leaves it on). A separate lever from
 * the `SEARCH_PUB_TAB_*` ranking flags, with an independent rollback trigger.
 */
export function resolveConceptFallbackSparseEnabled(): boolean {
  const v = process.env.SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF;
  if (v !== undefined && v !== "1" && v !== "0") {
    console.warn(
      `[search] ignoring unrecognized SEARCH_PUB_TAB_FALLBACK_SPARSE_OFF="${v}"; using "0" (sparse arm on)`,
    );
  }
  return v !== "1";
}

/**
 * Issue #298 §5 — inline cap on the broad-text fallback preview. Less than
 * `PAGE_SIZE` (the fallback is a preview, not a working result set); a future
 * redesign tunes it via the `ConceptFallbackResults` `cap` prop, but this is the
 * page-render default.
 */
export const CONCEPT_FALLBACK_CAP = 10;

/**
 * Issue #298 §6 — sparse-trigger knobs. A resolved-concept pub query with
 * `primaryTotal` in `1..SPARSE_THRESHOLD` triggers the sparse co-render only when
 * the broad-text count is at least `SPARSE_RATIO ×` the primary count (so a
 * fallback that wouldn't add much doesn't fire). Inline literals per the
 * no-speculative-fields pattern — re-tunable only by SPEC change with paired
 * test updates.
 */
export const CONCEPT_FALLBACK_SPARSE_THRESHOLD = 5;
export const CONCEPT_FALLBACK_SPARSE_RATIO = 5;

export type ConceptFallbackDecision = {
  /** True on either the zero-trigger or the sparse-trigger render path. */
  shown: boolean;
  /** Which arm fired (`null` when not shown) — telemetry + render branch. */
  trigger: "zero" | "sparse" | null;
};

/**
 * Issue #298 §3 — the single co-render decision shared by the SSR page (render
 * branch) and the route handler (telemetry). Pure: no DB/OpenSearch. Both the
 * primary `total` and the broad-text `broadCount` are already computed by the
 * existing #274 empty-state pre-compute; this only classifies them.
 *
 * The fallback block is suppressed (returns `shown: false`) when:
 *   - no descriptor resolved (`meshResolved` false) — nothing to fall back FROM;
 *   - the user opted out of concept admission (`meshOff`, scope=exact / §8 #1+#7)
 *     — the broad results ARE the primary list;
 *   - `concept_expanded` admission is active (`chipMode === "expanded_default"`,
 *     acceptance #3) — the OR-of-evidence shape already includes the broad signal;
 *   - the broad-text count is zero (§4.3 — nothing useful to co-render);
 *   - we're past the first page of the primary list (`page > 0`, §8 #10) — the
 *     fallback is a once-per-search affordance, not a per-page footer.
 *
 * Otherwise:
 *   - `total === 0` → zero-trigger (acceptance #1), regardless of the ratio;
 *   - `1 <= total <= SPARSE_THRESHOLD` AND `broadCount >= total * SPARSE_RATIO`
 *     AND `sparseEnabled` → sparse-trigger (acceptance #2 / §8 #5,#9);
 *   - anything else (a real primary result set, or a below-ratio sparse page) →
 *     not shown.
 */
export function computeConceptFallback(input: {
  meshResolved: boolean;
  meshOff: boolean;
  chipMode: "strict" | "expanded_default" | "expanded_narrow";
  total: number;
  broadCount: number;
  page: number;
  sparseEnabled: boolean;
}): ConceptFallbackDecision {
  const { meshResolved, meshOff, chipMode, total, broadCount, page, sparseEnabled } = input;
  const notShown: ConceptFallbackDecision = { shown: false, trigger: null };
  if (!meshResolved || meshOff) return notShown;
  // §3 acceptance #3 — never under the default-expanded (OR-of-evidence) shape.
  if (chipMode === "expanded_default") return notShown;
  if (broadCount <= 0) return notShown;
  // §8 #10 — fire once, on the first page only.
  if (page > 0) return notShown;
  if (total === 0) return { shown: true, trigger: "zero" };
  if (
    sparseEnabled &&
    total <= CONCEPT_FALLBACK_SPARSE_THRESHOLD &&
    broadCount >= total * CONCEPT_FALLBACK_SPARSE_RATIO
  ) {
    return { shown: true, trigger: "sparse" };
  }
  return notShown;
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
 * Default on (`SEARCH_PUB_MATCH_PROVENANCE=off` rolls back); a separate lever from the People-tab provenance flag
 * and from `SEARCH_PUB_HIGHLIGHT`, each with an independent rollback trigger.
 */
export function resolvePublicationMatchProvenance(): boolean {
  return process.env.SEARCH_PUB_MATCH_PROVENANCE !== "off";
}

/**
 * Issue #837 — Publications-tab Department facet. When on, `searchPublications`
 * adds (a) a `terms { wcmAuthorDepartments }` post-filter for the user's
 * selected department key(s) and (b) a department bucket aggregation, and the
 * /search page renders a Department `FacetGroup` in the Publications sidebar.
 * Attribution is union: a publication appears under EVERY department any of its
 * displayable WCM authors belongs to.
 *
 * Default OFF (`SEARCH_PUB_DEPARTMENT_FILTER=on` enables). This is a
 * reindex-then-flip rollout like the other search-index features here: the
 * `wcmAuthorDepartments` field the filter/agg read is populated by the
 * search-index ETL (`buildPublicationDoc`), so the publications index must be
 * reindexed with the new field BEFORE flipping the flag on — flipping first
 * would filter/aggregate an absent field and surface an empty facet.
 *
 * Deliberately a `=== "on"` default-off gate (not the `!== "off"` default-on
 * shape of the presentation flags above) so the feature ships inert until the
 * reindex lands.
 */
export function resolvePublicationDepartmentFilter(): boolean {
  return process.env.SEARCH_PUB_DEPARTMENT_FILTER === "on";
}

/**
 * Issue #861 — stream the /search shell ahead of the taxonomy + badge-count
 * work. On a cold `force-dynamic` SSR the page blocked its first byte on the
 * taxonomy/MeSH resolver (the eager `getMeshMap` descendant precompute) AND the
 * three count-only badge searches before any markup flushed — a 6-10s blank
 * page. When on, the page returns the `<main>` shell with a header/tabs
 * skeleton immediately and resolves taxonomy + counts + the active-tab results
 * inside a Suspense boundary, so the shell paints at the first byte and the
 * results stream in.
 *
 * Pure render-ordering change: the taxonomy resolution, badge predicates, and
 * streamed full search are byte-identical to the flag-off path (same inputs,
 * same calls, same `badge == list` invariant) — only WHEN they run relative to
 * the first flush differs. Default OFF (`SEARCH_SHELL_STREAMING=on` enables) so
 * it ships inert and the streaming reorder soaks behind the flag; the off path
 * is the today-identical single-await render. A separate `=== "on"` lever with
 * an independent rollback trigger.
 */
export function resolveSearchShellStreaming(): boolean {
  return process.env.SEARCH_SHELL_STREAMING === "on";
}

/**
 * Issue #726 follow-up (Section B / B2) — drop the dedicated concept-escalation
 * pre-count on the People tab. The escalate-on-sparse recall floor (#726) admits
 * concept-tagged scholars when a TRUSTWORTHY descriptor resolved AND the lexical
 * result is sparse (< `MESH_ESCALATION_THRESHOLD`). Today that decision is gated
 * by a dedicated `size:0` pre-count of the lexical predicate — a full extra
 * OpenSearch round-trip fired even on common high-volume topics that will never
 * be sparse, and on the SSR page it fires twice (the People badge count-call and
 * the full People search each pay it).
 *
 * When this lever is at its default (`on`), `searchPeople` keeps that pre-count:
 * the escalation is decided up front, so the count/full bodies dispatch once
 * (already escalated if sparse). When `off`, `searchPeople` skips the pre-count
 * and instead reads the main search's OWN `hits.total` (the bodies are already
 * `track_total_hits: true`), re-running escalated ONLY when sparse. That drops
 * the dedicated hop on the common non-sparse path (the win — 2 fewer hops per
 * SSR concept-People render) and pays a second search only on the rare sparse
 * path.
 *
 * Result-NEUTRAL by construction: BOTH states make the identical deterministic
 * escalation decision (`lexicalTotal < MESH_ESCALATION_THRESHOLD`) off the
 * identical lexical predicate, so the count-only badge and the full list reach
 * the same total under either state (`badge == list`). Only the number of
 * round-trips differs. Default ON (`SEARCH_PEOPLE_CONCEPT_PRECOUNT=off` enables
 * the reorder); a `!== "off"` default-on lever so the implementation ships dark
 * (zero behavior change until flipped) with an independent rollback trigger,
 * separate from `SEARCH_SHELL_STREAMING` and the ranking flags above.
 */
export function resolvePeopleConceptPrecount(): boolean {
  return process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT !== "off";
}
