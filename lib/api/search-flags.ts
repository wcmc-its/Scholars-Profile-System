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
 * TIER 2 — funding-tab phrase-first ranking. When on, `searchFunding` adds a
 * pure-ranking `should` clause (a `match_phrase` on `title`, plus a lower-boost
 * `match_phrase` on `abstract`) to the SAME bool that holds the existing text
 * `must`, so a grant whose title (or abstract) contains the typed phrase
 * contiguously ranks above grants that merely scatter the same single tokens.
 *
 * RANKING ONLY — never admission. The clause is a top-level `should` with NO
 * `minimum_should_match`, so it cannot admit or drop a document; the `must`
 * array (and therefore `hits.total`, the `countOnly` total, and every
 * excluding-self facet aggregation, all of which reference `must` directly)
 * is byte-identical to the flag-off body. No reindex: `title` and `abstract`
 * are already `{ type: "text", analyzer: "funding_text" }` in
 * `fundingIndexMapping` (lib/search.ts), so `match_phrase` is valid today.
 *
 * Default OFF (`SEARCH_FUNDING_PHRASE_BOOST=on` enables) — an `=== "on"`
 * opt-in gate (opposite the `!== "off"` default-on reason/concept flags above)
 * so the ranking change ships dark for a staging soak. A separate lever from
 * `SEARCH_FUNDING_TAB_CONCEPT` and `SEARCH_FUNDING_MATCH_REASON`, each with an
 * independent rollback trigger.
 *
 * Flag-parity note: when enabling later, wire the env var in BOTH `.env.local`
 * AND `cdk/lib/app-stack.ts` per environment (the operator rollout step) — a
 * local-on / deployed-off split silently ships nothing.
 */
export function resolveFundingPhraseBoost(): boolean {
  return process.env.SEARCH_FUNDING_PHRASE_BOOST === "on";
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
 * TIER 3 — funding-tab text-hit evidence line. A grant matched ONLY on a text
 * field (abstract / keywordsText / sponsorText) — not title, not concept, not
 * funded-pubs — renders today with NO "why it matched" reason (just a bare,
 * un-highlighted title). When on, `searchFunding` ALSO requests OpenSearch
 * highlights for `abstract` + `keywordsText` + `sponsorText` and computes a
 * clamped, mark-aware `textEvidence` snippet of the best non-title match; the
 * row renders it as the reason line so no text-matched result shows a
 * zero-reason row.
 *
 * App-only, NO reindex: the highlighted fields are already in the funding
 * index (`abstract^1`, `keywordsText^1`, `sponsorText^2` in FUNDING_FIELD_BOOSTS).
 * Pure presentation metadata — no effect on the query predicate, scoring, or
 * result set (highlight requests don't admit/rank docs).
 *
 * Default OFF (`SEARCH_FUNDING_TEXT_EVIDENCE=on` enables) — an `=== "on"` opt-in
 * gate so it ships dark, separate from `SEARCH_FUNDING_MATCH_REASON` (the
 * title-highlight + X-of-Y reasons) with an independent rollback trigger.
 * Flag-OFF ⇒ no extra highlight fields requested, no `textEvidence` emitted, and
 * the row render is byte-identical to today.
 *
 * Flag-parity note: when enabling, wire the env var in BOTH `.env.local` AND
 * `cdk/lib/app-stack.ts` per environment (operator rollout step).
 */
export function resolveFundingTextEvidence(): boolean {
  return process.env.SEARCH_FUNDING_TEXT_EVIDENCE === "on";
}

/**
 * Funding-tab relevance gate — the funding twin of the pub-tab
 * `SEARCH_PUB_TAB_MSM` (issue #259 §1.2). The funding `multi_match`
 * (best_fields, default OR, no floor) admits a grant on a SINGLE stemmed
 * token in any one field — e.g. `natural language processing` matching a
 * kidney grant on `processing`→`process`. When on, `searchFunding` adds the
 * same `minimum_should_match` floor publications uses
 * (`PUBLICATIONS_RESTRUCTURED_MSM`) so a multi-token query must cover most of
 * its tokens, and lowers the `abstract` boost from ^1 to ^0.5 (a passing
 * abstract mention shouldn't admit/dominate on its own — matching the
 * publications-tab abstract^0.5 weight).
 *
 * Default OFF (`SEARCH_FUNDING_TAB_MSM=on` enables) — an `=== "on"` opt-in
 * gate, opposite the `!== "off"` default-on presentation flags, so the
 * relevance change ships dark for a staging soak. Flag-OFF ⇒ the funding
 * `multi_match` body is byte-identical to today (no `operator`/`minimum_should_match`
 * keys, abstract^1 from the unmutated `FUNDING_FIELD_BOOSTS`). A separate lever
 * from `SEARCH_FUNDING_TAB_CONCEPT` / `SEARCH_FUNDING_MATCH_REASON` so the gate
 * rolls back independently.
 */
export function resolveFundingTabMsm(): boolean {
  return process.env.SEARCH_FUNDING_TAB_MSM === "on";
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

/**
 * Issue #967 — surface a representative matching publication inside the People
 * reason line (e.g. `… tagged HIV — incl. "Broadly neutralizing antibodies…"
 * (2024)`), so the count gets concrete proof of the work behind it and rows stop
 * reading identically on a topic query. The pub is drawn from a `top_hits`
 * sub-agg on the SAME publications-index aggregation that already computes the
 * count (`reasonCounts`) — no people-index field, no reindex.
 *
 * Pure presentation metadata: no effect on the query predicate, scoring, or
 * result set. Layered on top of `SEARCH_PEOPLE_MATCH_EXPLAIN` (inert when that is
 * off — there is no reason line to enrich). Default OFF; `=on` to enable.
 */
export function resolvePeopleSnippetRepresentativePub(): boolean {
  return process.env.SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB === "on";
}

/**
 * Search reason-from-doc — serve the People "N of M publications tagged
 * {concept}" reason count from the precomputed people-doc field
 * `meshSubtreeCounts` (D-exact) instead of a per-request publications-index
 * aggregation. When ON and the query resolved to a concept, the broad-concept
 * search issues ZERO publications-index reason queries on the initial render
 * (the count is an O(1) `_source` lookup), removing the cluster load that
 * saturates the search thread pool at ~10 concurrent. The mention-only branch and
 * the lazy on-the-fly key paper still issue cheap runtime queries.
 *
 * REINDEX PREREQ: the people index must be rebuilt so docs carry
 * `meshSubtreeCounts` before this serves a non-zero count; a not-yet-reindexed
 * cluster degrades to count 0 (the per-hit reason falls through to the concept
 * fallback), never a 500. Layered on top of `SEARCH_PEOPLE_MATCH_EXPLAIN` (inert
 * when that is off — there is no reason line to source). Default OFF both envs
 * (staging-first A/B, instant rollback); `=on` to enable.
 *
 * NOT count-identical to the legacy agg for BROAD concepts: the doc count is the
 * exact full subtree; the legacy agg caps `descendantUis` at 200 and undercounts
 * concepts with >200 descendants (e.g. Neoplasms). Flipping ON makes those counts
 * go UP to their true value — intentional accuracy gain, see `taggedCountFromDoc`.
 */
export function resolvePeopleReasonFromDoc(): boolean {
  return process.env.SEARCH_PEOPLE_REASON_FROM_DOC === "on";
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

/**
 * Research-Area concentration boost (spec: docs/search-research-area-relevance-spec.md).
 * When ON and a topic query resolves to a Research Area, `searchPeople` lifts scholars
 * by their relevance×coverage ranking in that area (the topic page's per-scholar
 * `total`), tiered into the prominence `function_score`. Topic/hybrid shapes only,
 * reorder-only (no result-set/facet change), suppressed under Exact word. App-only, no
 * reindex (sources the existing Aurora rollup, cached). Default OFF; `=== "on"` opt-in,
 * staging-first (wired `env === "staging" ? "on" : "off"` in cdk/lib/app-stack.ts).
 */
export function resolveSearchPeopleAreaBoost(): boolean {
  return process.env.SEARCH_PEOPLE_AREA_BOOST === "on";
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
 * Issue #396 — Publications-tab "Show only MeSH-tagged matches" filter. When
 * on AND the request carries `?searchMode=mesh-only`, `searchPublications`
 * adds a HARD query filter `{ exists: { field: "meshDescriptorUi" } }` to the
 * main `query.bool.filter`, restricting the result set, the total, the tab
 * badge, and every facet count to publications that carry ≥1 MeSH descriptor.
 * The /search page renders a "Show only MeSH-tagged matches" toggle in the
 * Publications facet rail and a MeSH-aware count line / empty state.
 *
 * UNLIKE the reindex-then-flip flags above (`SEARCH_PUB_DEPARTMENT_FILTER`,
 * `SEARCH_PEOPLE_METHOD_FAMILY`), this needs NO reindex: `meshDescriptorUi` is
 * already indexed (`lib/search.ts` field def; `lib/search-index-docs.ts`
 * builder, OMIT-on-empty so `exists` is exact). Only the query predicate + UI
 * are gated; the field has shipped on the publications index for releases.
 *
 * Deliberately a `=== "on"` default-off gate so the feature ships inert.
 * Activation requires BOTH the flag on AND `?searchMode=mesh-only` present, so
 * a stale URL param is inert when the flag is off.
 */
export function resolvePublicationMeshOnlyFilter(): boolean {
  return process.env.SEARCH_PUB_MESH_ONLY_FILTER === "on";
}

/**
 * Issue #824 §4c — People-tab method-family ranking boost. When on, the people
 * query adds the `methodFamily` field (a per-scholar rollup of overlay-visible
 * method-family labels + their exemplar-tool names) to the multi_match boost
 * ladders, so a free-text method/tool query ("CRISPR", "single-cell RNA
 * sequencing", "Seurat") ranks scholars who work in that method family.
 *
 * Default OFF (`SEARCH_PEOPLE_METHOD_FAMILY=on` enables). This is a
 * reindex-then-flip rollout like the other search-index features here: the
 * `methodFamily` field the boost references is populated by the search-index
 * ETL (`buildPeopleDoc`), so the people index must be reindexed with the new
 * field BEFORE flipping the flag on — flipping first would boost an absent
 * field (a wasted, no-op clause). Reversible by clearing the flag.
 *
 * Deliberately a `=== "on"` default-off gate (not the `!== "off"` default-on
 * shape of the presentation flags above) so the feature ships inert until the
 * reindex lands. Flag-parity note: when enabling later, wire the env var in
 * BOTH `.env.local` AND `cdk/lib/app-stack.ts` per environment — a local-on /
 * deployed-off split silently ships nothing. (NOT wired now; cdk wiring is the
 * operator rollout step.)
 */
export function resolvePeopleMethodFamilyBoost(): boolean {
  return process.env.SEARCH_PEOPLE_METHOD_FAMILY === "on";
}

/**
 * #1119 — People-tab method-CONTEXT ranking boost. When on, the people query adds
 * the `methodContext` field (a per-scholar rollup of the overlay-visible families'
 * tool-USAGE snippets — the ReciterAI tool_context text) to the multi_match boost
 * ladders, so a usage query ("embryo ploidy time-lapse") ranks scholars by the real
 * language of their work, not just a tool's name.
 *
 * Default OFF (`SEARCH_PEOPLE_METHOD_CONTEXT=on` enables) — a `=== "on"` gate, like
 * the sibling `SEARCH_PEOPLE_METHOD_FAMILY` boost, and the SAME reindex-then-flip
 * discipline: the `methodContext` field is populated by the search-index ETL
 * (`buildPeopleDoc`), so reindex the people index BEFORE flipping. `methodContext`
 * is PROSE, so it is boosted MODESTLY (below `methodFamily`) and relies on the
 * existing people minimum-should-match to keep generic words from over-matching
 * (the #1056/#1090 relevance lesson). SOAK before any prod flip. Flag-parity:
 * when enabling, wire the env var in BOTH `.env.local` AND cdk/lib/app-stack.ts.
 */
export function resolvePeopleMethodContextBoost(): boolean {
  return process.env.SEARCH_PEOPLE_METHOD_CONTEXT === "on";
}

/**
 * #1269 — People-tab method-family TIER boost. The sibling
 * `SEARCH_PEOPLE_METHOD_FAMILY` boost adds `methodFamily` to the multi_match
 * ladder (recall/admission); this adds a MULTIPLICATIVE topic-shape
 * function_score factor (`PEOPLE_METHOD_FAMILY_TAG_WEIGHT`) for scholars whose
 * `methodFamily` rollup contains the RESOLVED family label — so an explicitly
 * method-tagged scholar ranks above a keyword/MeSH-only match (the #1269
 * "Gudas outranks a tagged scholar" symptom).
 *
 * Independent lever from `SEARCH_PEOPLE_METHOD_FAMILY` (ships/flips separately,
 * like `SEARCH_PEOPLE_METHOD_CONTEXT`), so the aggressive tier can be calibrated
 * on its own. It READS the same `methodFamily` index field, so it requires the
 * SAME reindex (no additional one) — flip only AFTER the people index carries
 * `methodFamily`. Default OFF (`=== "on"`), reversible by clearing the flag.
 * Flag-parity: when enabling, wire the env var in BOTH `.env.local` AND
 * `cdk/lib/app-stack.ts` per environment.
 */
export function resolvePeopleMethodFamilyTier(): boolean {
  return process.env.SEARCH_PEOPLE_METHOD_FAMILY_TIER === "on";
}

/**
 * #824 follow-up — match-aware People snippet. Replaces the per-scholar snippet
 * line — today a raw underscore-slug dump of `areasOfInterest` rendered with
 * mid-word bolding (e.g. "single_cell_spatial_biology cell_molecular_biology")
 * — with a clean, MATCH-AWARE "why" line. In priority order the card renders a
 * matched method family (+ exemplar tools), else the matched research-area topic
 * as a clean human label, else the scholar's bio highlight, else a HUMANIZED
 * comma-separated research-areas line (no under_scores). See the approved mockup
 * `docs/mockups/search-snippet/match-aware-snippet.html`.
 *
 * App-only: NO reindex. The method/topic reasons are DERIVED at query time from
 * `scholar_family` (the #1045 index `methodFamily` field is NOT required for this
 * surface) + the already-resolved topic taxonomy, and the humanized fallback is a
 * pure render of the existing `areasOfInterest` highlight against a topic
 * slug→label map. Staging-first.
 *
 * Default OFF (`SEARCH_PEOPLE_MATCH_AWARE_SNIPPET=on` enables) — an `=== "on"`
 * opt-in gate, opposite the `!== "off"` default-on presentation flags above, so
 * the feature ships dark for a staging soak. Flag-OFF ⇒ `searchPeople` runs no
 * new query, emits no new reason kinds, and the card render is byte-identical to
 * today.
 *
 * Flag-parity note: when enabling later, wire the env var in BOTH `.env.local`
 * AND `cdk/lib/app-stack.ts` per environment — a local-on / deployed-off split
 * silently ships nothing. (NOT wired now; cdk wiring is the operator rollout
 * step.) A separate lever from `SEARCH_PEOPLE_METHOD_FAMILY` (the reindex-gated
 * ranking BOOST) and `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB`, each with an
 * independent rollback trigger.
 */
export function resolvePeopleMatchAwareSnippet(): boolean {
  return process.env.SEARCH_PEOPLE_MATCH_AWARE_SNIPPET === "on";
}

/**
 * #824 follow-up Phase 1 — the coherent `ResultEvidence` snippet model
 * (`docs/search-snippet-handoff.md` §4). When on, `searchPeople` derives a
 * single typed `evidence` object per hit via one precedence function and the
 * card renders it through one `<ResultEvidence>` component, SUPERSEDING the
 * accreted `matchReason` / `humanizedAreas` priority chain. Implies the
 * match-aware derivation (method/topic/areas) so it works on its own.
 *
 * App-only, NO reindex (same query-time derive as the match-aware snippet).
 * Default OFF (`SEARCH_RESULT_EVIDENCE=on` enables) — an `=== "on"` opt-in gate
 * so the redesign ships dark for a staging soak alongside the still-live
 * `SEARCH_PEOPLE_MATCH_AWARE_SNIPPET`. Flag-OFF ⇒ no `evidence` field and the
 * card render is byte-identical to today.
 *
 * Flag-parity note: NOT wired in `cdk/lib/app-stack.ts` yet — enabling later is
 * the operator rollout step (wire the env var per environment + `cdk deploy`,
 * the same recipe as the match-aware flag above).
 */
export function resolveSearchResultEvidence(): boolean {
  return process.env.SEARCH_RESULT_EVIDENCE === "on";
}

/**
 * Generalized evidence rows on the scholar search card — surfaces a scholar's
 * topic-matching grants as a "Funding" disclosure row (`[Funding badge] claim ⌄ →
 * Key funding`) and badges the publications flavor (Research area / Concept /
 * Keyword) on the Scholars card only. The Funding row is lazy: a card with
 * `grantCount > 0` fetches `/api/scholar/[cwid]/grants?q=…` and renders the row
 * only when ≥1 grant matched (hide-when-empty), so flag-OFF ⇒ no fetch, no row,
 * and the pub row keeps its shipped muted treatment.
 *
 * App-only, NO reindex. Default OFF (`SEARCH_EVIDENCE_ROWS=on` enables) — an
 * `=== "on"` opt-in gate, STAGING-FIRST. Wired per-env in `cdk/lib/app-stack.ts`
 * (staging-on / prod-off); enabling in prod is the operator `cdk deploy` step.
 */
export function resolveSearchEvidenceRows(): boolean {
  return process.env.SEARCH_EVIDENCE_ROWS === "on";
}

/**
 * People-tab "concepts" hint — replace the often-sparse self-reported
 * research-areas hint (`areasOfInterest`) on the per-scholar row's identity line
 * with the scholar's TOP MeSH descriptor labels (`topMeshTerms`, denser because
 * it is derived from accepted/visible publications). Only the no-match TAIL of
 * the evidence model changes (the `areas` slot becomes a `concepts` slot); the
 * query-match kinds (name/method/topic/publications/selfDescription/affiliation)
 * are untouched.
 *
 * App-only, NO reindex of the QUERY path (the `topMeshTerms` field is added to
 * the people index doc, so a reindex is required to populate it, but the query
 * derive is query-time). Default OFF (`SEARCH_PEOPLE_CONCEPT_HINT=on` enables) —
 * an `=== "on"` opt-in gate. STAGING-FIRST. Flag-OFF ⇒ `searchPeople` keeps
 * today's `areas` population and never sets `concepts`, so the evidence output
 * is byte-identical to the `SEARCH_RESULT_EVIDENCE` path on master.
 */
export function resolveSearchPeopleConceptHint(): boolean {
  return process.env.SEARCH_PEOPLE_CONCEPT_HINT === "on";
}

/**
 * Issue #1026 — surface soft-deleted active doctoral-student co-authors as
 * NON-LINKED author chips (name + headshot only) on publication chip surfaces
 * (search results, topic feeds, methods pages, home spotlight). Without this,
 * a mentor↔mentee co-pub drops the soft-deleted student from the chip row, so
 * the publication looks like an ordinary mentor pub and the "MD mentee" facet
 * appears not to work.
 *
 * This is a FERPA carve (see docs/student-profile-visibility.md, "Relational
 * mentions"): the constraint is on the LINK/searchability/profile, NOT the name
 * — a co-author name is part of the public PubMed record. When this flag is on,
 * these students are hydrated into the chip row but render as PLAIN TEXT only —
 * never a clickable profile link, never a navigating popover, never searchable
 * or faceted. The non-linked rendering is enforced downstream by
 * `isPubliclyDisplayed(roleCategory)` (the existing #536 chip path); this flag
 * only governs whether they are pulled into the hydration at all.
 *
 * Default OFF (`COAUTHOR_HIDDEN_STUDENT_CHIPS=on` enables). When OFF, the chip
 * hydration filter and every renderable-chip predicate behave byte-identically
 * to today (no hidden-class student is in the hydration, so the relaxed
 * predicates never match anyone).
 */
export function resolveHiddenStudentCoauthorChips(): boolean {
  return process.env.COAUTHOR_HIDDEN_STUDENT_CHIPS === "on";
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
 * Issue #878 — MeSH-concept rows in the autocomplete dropdown. The search
 * RESULTS page already resolves MeSH (`resolveMeshDescriptor`), but the
 * `suggestEntities` dropdown is pure `contains` matching and never sees the
 * MeSH layer — so `flow cytometry` and the acronym `FACS` both return `[]`
 * while Enter→results is descriptor-rich (D005434). When on, `suggestEntities`
 * adds a flag-gated `"concept"` suggestion kind that reuses the SAME
 * `getMeshMap().byForm` index (descriptor names + NLM entry terms + #642
 * curated aliases) to surface a "Flow Cytometry — MeSH concept" row linking to
 * the existing concept search.
 *
 * Default OFF (`SEARCH_SUGGEST_MESH_CONCEPT=on` enables) — a `=== "on"`
 * opt-in gate, shipping dark for a staging soak first. No reindex and no new
 * data (reuse-only); the flip is env-only via `cdk deploy Sps-App-<env>`. A
 * separate lever from `METHODS_LENS_PAGES` (MeSH is orthogonal to the methods
 * lens) and from the other `SEARCH_*` flags, with an independent rollback
 * trigger.
 */
export function resolveSearchSuggestMeshConcept(): boolean {
  return process.env.SEARCH_SUGGEST_MESH_CONCEPT === "on";
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

/**
 * #921 — concept-scope grant axis. When ON, the Scholars tab under
 * `?match=concept` admits scholars who are FUNDED on the resolved concept (a
 * grant whose `SEARCH_FUNDING_MESH_GATE` field intersects the descendant set),
 * not only those with a concept-tagged publication. The People list, facets,
 * and the count badge all widen together (the union rides the always-on filter
 * + the scoring `must`), and grant-only matches sort below publication evidence.
 *
 * Default OFF (an `=== "on"` opt-in, opposite the default-on precount lever) so
 * the feature ships dark: flag-off skips the extra Funding round-trip entirely
 * and leaves every concept-People query body byte-identical to today.
 */
export function resolvePeopleConceptGrantAxis(): boolean {
  return process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS === "on";
}

/**
 * Decompose-and-resolve MeSH fallback. When ON, `resolveMeshDescriptor` — after the
 * exact name / entry-term / curated-alias lookup misses — retries against the
 * contiguous word-windows of the query (longest-first) and, on a hit, returns the
 * descriptor at the new low `partial` confidence tier (admits/attributes beneath
 * every verbatim tier; see `MESH_ADMIT_WEIGHT`). Lets a multi-concept or
 * qualifier-laden query (e.g. "Liquid biopsy / circulating tumor DNA") reach its
 * dominant descriptor instead of degrading to free-text.
 *
 * Default OFF (`=== "on"` opt-in): flag-off leaves `resolveMeshDescriptor`
 * byte-identical to today (a miss returns null, no window pass). Guardrails live in
 * the resolver: a single-token window resolves ONLY on an exact descriptor-NAME
 * match, so a short/common word cannot mis-map (the "Seahorse → Smegmamorpha" trap).
 */
export function resolveMeshResolutionFallbackEnabled(): boolean {
  return process.env.SEARCH_MESH_RESOLUTION_FALLBACK === "on";
}

/**
 * #1342 — query-side morphology retry. When ON, `resolveMeshDescriptor`, after the
 * exact name / entry-term / curated-alias lookup misses, retries the SINGULARIZED
 * query ({@link singularizeForMatch}: "melanomas" → "melanoma") against the same
 * index and, on a hit, returns the descriptor at the low `partial` confidence tier.
 * Closes the inflection tail (plurals/possessives whose singular base is already an
 * index key) and makes future curated aliases robust to plural/possessive variants.
 *
 * Default OFF (`=== "on"` opt-in): flag-off leaves `resolveMeshDescriptor`
 * byte-identical (the singularize branch is never entered). Resolve-time only — no
 * reindex. NOTE: the headline lay-term wins (diabetes/alzheimer's) ALSO need the
 * #1258 alias rows; a singularizer cannot bridge derivational or single→multi-word.
 */
export function resolveMeshQueryNormalizationEnabled(): boolean {
  return process.env.SEARCH_MESH_QUERY_NORMALIZATION === "on";
}

/**
 * #1346 — acronym wrong-sense guard. When ON, `resolveMeshDescriptor` suppresses a
 * short all-caps acronym query (e.g. CAR, PET) that resolved ONLY via a common-word
 * entry-term synonym whose matched form is a plain Title-case word (CAR → "Car" →
 * Automobiles, PET → "Pet" → Pets). Such a match is the wrong (non-medical) sense on
 * a medical-center search; returning null drops the query to BM25, exactly like the
 * already-safe 2-char acronyms (MS/CD).
 *
 * Default OFF (`=== "on"` opt-in): flag-off is byte-identical. Internal-caps acronym
 * entry terms (COPD/EHR/PCR) and exact descriptor-NAME matches (DNA/RNA, confidence
 * `exact`) are kept — the discriminator is "matched form has no uppercase past char 0".
 */
export function resolveAcronymSenseGuardEnabled(): boolean {
  return process.env.SEARCH_ACRONYM_SENSE_GUARD === "on";
}

/**
 * POPS clinical specialty search — People-tab ranking boost + clinical:exact
 * evidence kind. When on, the people query adds `clinicalSpecialties` and
 * `clinicalExpertise` to the multi_match boost ladder so a specialty query
 * ("cardiology") ranks the matching clinician, and `resolveHitEvidence` emits
 * a `clinical:exact` reason when every query content token is covered by a
 * specialty string in the hit's `clinicalSpecialties` set.
 *
 * Default OFF (`SEARCH_PEOPLE_CLINICAL=on` enables). This is a
 * reindex-then-flip rollout: the three clinical fields
 * (`clinicalSpecialties`, `clinicalExpertise`, `clinicalBoardSet`) must be
 * in the people index docs BEFORE flipping — the etl/pops step populates
 * the Scholar rows and a full people reindex writes the doc fields.
 * Flipping first boosts absent fields (wasted no-op clauses). Reversible
 * by clearing the flag. Flag-parity note: when enabling later, wire the env
 * var in BOTH `.env.local` AND `cdk/lib/app-stack.ts` per environment — a
 * local-on / deployed-off split silently ships nothing.
 */
export function resolveSearchPeopleClinical(): boolean {
  return process.env.SEARCH_PEOPLE_CLINICAL === "on";
}
