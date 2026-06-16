import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import {
  searchPeople,
  searchPublications,
  type PeopleSort,
  type PublicationsSort,
} from "@/lib/api/search";
import { meshMatchTier } from "@/lib/search";
import {
  searchFunding,
  type FundingFilters,
  type FundingRoleBucket,
  type FundingSort,
  type FundingStatus,
} from "@/lib/api/search-funding";
import {
  matchQueryToTaxonomy,
  buildMatchAwareContext,
} from "@/lib/api/search-taxonomy";
import { stripDeprioritized } from "@/lib/api/deprioritized-terms";
import {
  parseScopeParam,
  scopeToMeshParams,
  type Scope,
  resolveConceptMode,
  resolveFundingConceptEnabled,
  resolveDeptLeadershipBoost,
  resolvePeopleRelevanceMode,
  resolvePeopleMatchProvenance,
  resolvePeopleMatchExplain,
  resolvePeopleSnippetRepresentativePub,
  resolveGenericTermMode,
  resolvePublicationHighlight,
  resolvePublicationMatchProvenance,
  resolvePublicationDepartmentFilter,
  resolveConceptFallbackSparseEnabled,
  computeConceptFallback,
  CONCEPT_FALLBACK_CAP,
  CONCEPT_FALLBACK_SPARSE_THRESHOLD,
} from "@/lib/api/search-flags";
import { classifyPeopleQuery } from "@/lib/api/people-query-shape";
import { getPeopleClassifierSets } from "@/lib/api/people-classifier-sets";
import { serverTimingHeader } from "@/lib/api/search-timing";
import {
  runWithOsRoundTripCounter,
  getOsRoundTripCount,
} from "@/lib/api/os-round-trips";

export const dynamic = "force-dynamic";

// Valid topic slug pattern — same as topic page slug (D-02 candidate (e): topic.id is the slug).
// Rejects non-slug shapes to prevent blind-comparison probing (T-03-06-01).
const TOPIC_SLUG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

// D3 SLI — wrap the handler in a request-scoped OpenSearch round-trip counter
// so each `search_query` log can report `osRoundTrips`. The counter is inert
// outside this scope (ETL / index build).
export async function GET(request: NextRequest) {
  return runWithOsRoundTripCounter(() => handleSearch(request));
}

async function handleSearch(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  const type = params.get("type") ?? "people";
  const rawPage = parseInt(params.get("page") ?? "0", 10);
  const page = Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0;

  // Issue #259 §1.5 — taxonomy match (curated + MeSH resolution) computed
  // once at the top so all three branches can log resolution outcome.
  // matchQueryToTaxonomy short-circuits on q < 3 normalized chars, so the
  // cost here is one Map lookup + one indexed etl_run row when the cache
  // is hot. Same call the server-rendered /search page makes; the duplication
  // is acceptable until call sites consolidate.
  //
  // Issue #259 SPEC §7.5 — split-scope timing. `taxonomyMatchMs` measures
  // the resolver in isolation so a resolver regression doesn't dilute the
  // §3.1 (c) +10ms p95 guardrail (which targets the rebalance's body
  // construction + OpenSearch round-trip, not the resolver).
  // Issue #692 — generic-term demotion. Strip deprioritized filler tokens once
  // up front; `removed` is empty when nothing was stripped (incl. the
  // never-strip-to-empty case), so `genericDemote` and the resolution retry are
  // both inert unless there is a real content/full split.
  const genericTermMode = resolveGenericTermMode();
  const { contentQuery, removed: genericRemoved } = stripDeprioritized(q);
  const genericStripped = genericTermMode !== "off" && genericRemoved.length > 0;
  const genericDemote = genericTermMode === "on" && genericRemoved.length > 0;

  const taxonomyStart = Date.now();
  let taxonomyMatch = await matchQueryToTaxonomy(q);
  // Issue #692 §4.1 — full query first; only on a complete MISS (no curated
  // match AND no MeSH descriptor) retry against the stripped content query.
  // Full-first protects descriptors built from filler ("gene therapy",
  // "clinical trial") — those resolve on the first call and never reach here.
  if (
    genericStripped &&
    taxonomyMatch.state === "none" &&
    taxonomyMatch.meshResolution === null
  ) {
    const retry = await matchQueryToTaxonomy(contentQuery);
    if (retry.state === "matches" || retry.meshResolution !== null) {
      taxonomyMatch = retry;
    }
  }
  const taxonomyMatchMs = Date.now() - taxonomyStart;
  // PLAN R2/R6 — one user-facing `?match=exact|expanded|concept` scope (default
  // `expanded`) replaces the split `?mesh=` surface. `parseScopeParam` validates
  // the value (anything unrecognized → `expanded`) and folds the legacy
  // `?mesh=off|strict` back-compat alias with off-wins precedence, then
  // `scopeToMeshParams` bridges it onto the existing `meshOff` / `meshStrict`
  // levers — so the precedence below (and the SSR page, which parses the same
  // way) stays byte-identical. `expanded` is byte-identical to pre-scope.
  const scope = parseScopeParam(params);
  const { meshOff, meshStrict } = scopeToMeshParams(scope);
  const effectiveMeshResolution = meshOff ? null : taxonomyMatch.meshResolution;
  const conceptMode = resolveConceptMode();
  const meshResolutionDescriptorUi =
    taxonomyMatch.meshResolution?.descriptorUi ?? null;
  const meshResolutionConfidence =
    taxonomyMatch.meshResolution?.confidence ?? null;

  // PLAN R3 — search interpretation, returned on every branch (people /
  // publications / funding) so a programmatic/JSON consumer of this route
  // knows the active scope and the resolved concept without re-running the
  // taxonomy resolver. `conceptLabel` mirrors the SSR page (`MeshResolution.name`
  // or null when no mapping); `meshMapped` is the boolean the page derives from
  // it. Spread into the response body by `jsonWithTiming`.
  const conceptLabel = taxonomyMatch.meshResolution?.name ?? null;
  const meshMapped = taxonomyMatch.meshResolution !== null;
  const searchInterpretation = { scope, conceptLabel, meshMapped };

  // Issue #78 — Funding tab. Multi-select facets are repeated params,
  // OR within group, AND across groups. Mirrors the people/publications
  // pattern.
  if (type === "funding") {
    const sort = (params.get("sort") ?? "relevance") as FundingSort;
    const status = params.getAll("status").filter(
      (s): s is FundingStatus =>
        s === "active" || s === "ending_soon" || s === "recently_ended",
    );
    const role = params.getAll("role").filter(
      (r): r is FundingRoleBucket =>
        r === "PI" || r === "Multi-PI" || r === "Co-I",
    );
    const filters: FundingFilters = {
      funder: orUndefined(params.getAll("funder")),
      directFunder: orUndefined(params.getAll("directFunder")),
      programType: orUndefined(params.getAll("programType")),
      mechanism: orUndefined(params.getAll("mechanism")),
      status: status.length > 0 ? status : undefined,
      department: orUndefined(params.getAll("department")),
      role: role.length > 0 ? role : undefined,
    };
    // Issue #295 — forward the MeSH resolution (computed once at the top of
    // the handler) so the funding query can add its OR-of-evidence clause
    // under SEARCH_FUNDING_TAB_CONCEPT=on. `effectiveMeshResolution` honors
    // `?mesh=off`, mirroring the publications branch.
    // Issue #294 PR-5 — funding-search latency. #259's split-scope timing
    // (`taxonomyMatchMs` resolver-only, `searchLatencyMs` for the search)
    // reached the people / publications branches but never funding; this
    // closes the gap so all three branches log a comparable `searchLatencyMs`.
    const searchStart = Date.now();
    const result = await searchFunding({
      q,
      page,
      sort,
      filters,
      meshResolution: effectiveMeshResolution,
    });
    const searchLatencyMs = Date.now() - searchStart;
    // Issue #295 — true when the funding concept clause actually fired (flag
    // on AND a descriptor resolved with a non-empty descendant set), so the
    // flag rollout is observable in the query log.
    const meshConceptClauseFired =
      resolveFundingConceptEnabled() &&
      effectiveMeshResolution !== null &&
      effectiveMeshResolution.descendantUis.length > 0;
    console.log(
      JSON.stringify({
        event: "search_query",
        q,
        type: "funding",
        resultCount: result.total,
        filters,
        meshResolutionDescriptorUi,
        meshResolutionConfidence,
        // Issue #295 — funding concept-clause telemetry.
        meshConceptClauseFired,
        // SPEC §7.5 — resolver scope. Logged on every branch so a resolver
        // regression (orthogonal to the rebalance) is observable here too.
        taxonomyMatchMs,
        // Issue #294 PR-5 — funding-search latency, mirroring the
        // people / publications branches' `searchLatencyMs`.
        searchLatencyMs,
        // D3 SLI — OpenSearch round-trips this request made (serial-await guard).
        osRoundTrips: getOsRoundTripCount(),
        ts: new Date().toISOString(),
      }),
    );
    return jsonWithTiming(
      result,
      searchInterpretation,
      taxonomyMatchMs,
      searchLatencyMs,
      "searchFunding",
    );
  }

  if (type === "publications") {
    const sort = (params.get("sort") ?? "relevance") as PublicationsSort;
    const yearMin = params.get("yearMin") ? parseInt(params.get("yearMin")!, 10) : undefined;
    const yearMax = params.get("yearMax") ? parseInt(params.get("yearMax")!, 10) : undefined;
    const publicationType = params.get("publicationType") ?? undefined;
    const journal = params.getAll("journal");
    const wcmAuthorRoleRaw = params.getAll("wcmAuthorRole");
    const wcmAuthorRole = wcmAuthorRoleRaw.filter(
      (r): r is "first" | "senior" | "middle" =>
        r === "first" || r === "senior" || r === "middle",
    );
    // Issue #837 — WCM-author department filter. Only honored when the flag is
    // on (otherwise dropped so a stale `?department=` is inert), matching the
    // SSR page's gating.
    const department = resolvePublicationDepartmentFilter()
      ? params.getAll("department")
      : [];
    // Issue #259 SPEC §7.5 — `searchLatencyMs` covers the body construction
    // + OpenSearch round-trip + Prisma hydration. Excludes the resolver
    // (captured separately as `taxonomyMatchMs`) so the §3.1 (c) guardrail
    // attributes regressions to the rebalance code path, not unrelated
    // resolver drift.
    const searchStart = Date.now();
    const result = await searchPublications({
      q,
      page,
      sort,
      filters: {
        yearMin,
        yearMax,
        publicationType,
        journal: journal.length > 0 ? journal : undefined,
        wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
        department: department.length > 0 ? department : undefined,
      },
      // Issue #259 §5 — pass the MeSH resolution computed at the top of
      // the handler. Under `SEARCH_PUB_TAB_CONCEPT_MODE=expanded` and this
      // non-null, searchPublications produces the §5.2 four-clause body.
      // Under `strict` (default at PR-3 merge), it produces the same
      // `concept_filtered` / `concept_fallback` body as today's prod.
      // §1.11 — `effectiveMeshResolution` honors `?mesh=off`; when off,
      // this is null and the pub query falls back to the §1.2 shape.
      meshResolution: effectiveMeshResolution,
      // Issue #692 — generic-term demotion (mode `on`). BM25 scores on the
      // content query (gate) with the full query discounted; inert otherwise.
      genericDemote,
      contentQuery,
      // §6.2 — chip's "Narrow to this concept only" opt-in. Forces
      // strict-mode admission under flag = `expanded`. `?mesh=off`
      // precedence is already enforced upstream by nulling the resolution.
      meshStrict,
      // SEARCH_PUB_HIGHLIGHT — mark matched terms in the title.
      highlightMatches: resolvePublicationHighlight(),
      // SEARCH_PUB_MATCH_PROVENANCE — #688-parity "Why this match" MeSH note.
      matchProvenance: resolvePublicationMatchProvenance(),
    });
    const searchLatencyMs = Date.now() - searchStart;
    // Issue #298 — concept-fallback co-render telemetry. The SSR page renders
    // the broad-text fallback block inline; this branch logs whether the same
    // decision WOULD fire so the post-ship fire-rate (§9.3) is observable on the
    // JSON API too. `chipMode` is derived the same way the page derives it
    // (conceptMode + meshStrict). The broad-count round-trip is paid only on
    // candidate pages (resolved descriptor, non-expanded shape, first page,
    // primary count within the sparse window) — same cost gate as the page.
    const chipMode: "strict" | "expanded_default" | "expanded_narrow" =
      conceptMode === "expanded" && !meshStrict
        ? "expanded_default"
        : conceptMode === "expanded" && meshStrict
          ? "expanded_narrow"
          : "strict";
    const conceptShape =
      result.queryShape === "concept_filtered" ||
      result.queryShape === "concept_fallback";
    let conceptFallbackBroadCount: number | null = null;
    if (
      effectiveMeshResolution !== null &&
      chipMode !== "expanded_default" &&
      conceptShape &&
      page === 0 &&
      result.total <= CONCEPT_FALLBACK_SPARSE_THRESHOLD
    ) {
      const broad = await searchPublications({
        q,
        page: 0,
        sort: "relevance",
        filters: {
          yearMin,
          yearMax,
          publicationType,
          journal: journal.length > 0 ? journal : undefined,
          wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
          department: department.length > 0 ? department : undefined,
        },
        // Perf (B4) — this branch reads only `broad.total` (hits are discarded
        // and this call passes no mentoring/author filter), so the existing
        // count-only fast path applies directly: no aggs, no hit emission, no
        // hydration.
        countOnly: true,
        meshResolution: null,
      });
      conceptFallbackBroadCount = broad.total;
    }
    const conceptFallbackDecision = computeConceptFallback({
      meshResolved: effectiveMeshResolution !== null,
      meshOff,
      chipMode,
      total: result.total,
      broadCount: conceptFallbackBroadCount ?? 0,
      page,
      sparseEnabled: resolveConceptFallbackSparseEnabled(),
    });
    const conceptFallbackHits = conceptFallbackDecision.shown
      ? Math.min(conceptFallbackBroadCount ?? 0, CONCEPT_FALLBACK_CAP)
      : null;
    // ANALYTICS-02 (D-02): structured search-query log (publications branch).
    // Issue #259 §1.2 — queryShape attributes result-count and ranking
    // changes to the code path that served the request. Same enum and
    // field name as the people branch so downstream analytics can group
    // by `type + queryShape`.
    console.log(
      JSON.stringify({
        event: "search_query",
        q,
        type: "publications",
        resultCount: result.total,
        queryShape: result.queryShape,
        // SPEC §7.5 — resolved mode (after the legacy `OR_OF_EVIDENCE`
        // fallback). Captures the per-request shape without analysts
        // having to know which env mapping was active.
        conceptMode,
        filters: { yearMin, yearMax, publicationType, journal, wcmAuthorRole, department },
        meshResolutionDescriptorUi,
        meshResolutionConfidence,
        // Issue #259 §5.4.2 / SPEC §7.5. Bucketed in the post-flip retro plot
        // to attribute recall lift to descendant-set size (small subtree →
        // small lift, broad descriptor → big lift). `null` when resolution
        // is null (mesh=off, no-match, or under-3-char query) so downstream
        // queries can distinguish "no resolution" from "resolution with a
        // self-only descendant set" (length 1).
        meshDescendantSetSize: result.meshDescendantSetSize,
        // SPEC §7.5 — anchor-set size mirrors the descendant convention:
        // `null` distinguishes "no resolution" from "resolution with zero
        // anchors" (which exercises the `concept_fallback` strict-mode path).
        meshAnchorCount: result.meshAnchorCount,
        // Issue #259 §1.11 — opt-out signal. True when the request set
        // `?mesh=off`; logging the rate per descriptor tells us when the
        // chip's broaden affordance is over- or under-used.
        meshOff,
        // §6.2 — chip-engaged narrow-mode opt-in. True when `?mesh=strict`
        // present (and `?mesh=off` absent).
        meshStrict,
        // Issue #298 §9.1 — concept-fallback co-render telemetry. `Shown` is
        // true on either trigger; `Trigger` names which arm fired (null when
        // not shown); `Hits` is the capped count of broad rows previewed (null
        // when not shown). Lets §9.3 monitor the fire rate post-ship.
        conceptFallbackShown: conceptFallbackDecision.shown,
        conceptFallbackTrigger: conceptFallbackDecision.trigger,
        conceptFallbackHits,
        // Issue #645 — recency tilt on the Relevance sort. `recencyMode` is the
        // resolved SEARCH_PUB_RELEVANCE_RECENCY value; `recencyOriginYear` is
        // the gauss origin actually used (null when the tilt wasn't applied —
        // mode off, or an explicit non-relevance sort). Lets the retro plot
        // rank-position-vs-year and confirm the tilt fired with the right origin.
        recencyMode: result.recencyMode,
        recencyOriginYear: result.recencyOriginYear,
        // SPEC §7.5 — split-scope latency. `taxonomyMatchMs` is the resolver
        // alone; `searchLatencyMs` is the rebalance scope (body construction
        // + OpenSearch + hydration). The §3.1 (c) guardrail targets the
        // latter; the former is logged on every branch (people/funding too)
        // so resolver-only regressions are attributable.
        taxonomyMatchMs,
        searchLatencyMs,
        // D3 SLI — OpenSearch round-trips this request made (serial-await guard).
        osRoundTrips: getOsRoundTripCount(),
        ts: new Date().toISOString(),
      }),
    );
    return jsonWithTiming(
      result,
      searchInterpretation,
      taxonomyMatchMs,
      searchLatencyMs,
      "searchPublications",
    );
  }

  const sort = (params.get("sort") ?? "relevance") as PeopleSort;
  // Issue #8/#9: facets are repeated params, OR'd within a group.
  const deptDiv = params.getAll("deptDiv");
  const personType = params.getAll("personType");
  const activityRaw = params.getAll("activity");
  const activity = activityRaw.filter(
    (a): a is "has_grants" | "recent_pub" => a === "has_grants" || a === "recent_pub",
  );
  // URL contract: `?includeIncomplete=false` opts INTO the sparse-profile
  // cull (only scholars with overview + ≥3 pubs + active grant). Any other
  // value — including the param being absent — leaves the filter unset so
  // the result matches the /search page (which never sends the param).
  // Previously this was `=== "true"`, which silently coerced "absent" to
  // `false` and triggered the cull on every API call, producing API totals
  // far below the page totals (#152's `isComplete` filter applied to every
  // headless caller by accident).
  const rawIncludeIncomplete = params.get("includeIncomplete");
  const includeIncomplete =
    rawIncludeIncomplete === null ? undefined : rawIncludeIncomplete === "true";

  // D-10 topic filter: validate slug shape before passing to searchPeople.
  const topicRaw = params.get("topic");
  let topic: string | undefined;
  if (topicRaw !== null && topicRaw.length > 0) {
    if (!TOPIC_SLUG_RE.test(topicRaw)) {
      return apiError("invalid topic", 400);
    }
    topic = topicRaw;
  }

  // Issue #308 §6.1.1 — lexical query-shape classifier routes the §6.1
  // per-shape ranking templates. SPEC §12 PR-5 (#312) flipped the default to
  // `v3`; `SEARCH_PEOPLE_RELEVANCE_MODE=legacy` is the emergency rollback to
  // the #259 restructured body. Resolution is shared with the SSR page via
  // `resolvePeopleRelevanceMode` so both rank identically.
  const appliedRelevanceMode = resolvePeopleRelevanceMode();
  const classifierSets = await getPeopleClassifierSets();
  const queryShape = classifyPeopleQuery({
    query: q,
    meshResolved: taxonomyMatch.meshResolution != null,
    knownCwids: classifierSets.cwids,
    knownSurnames: classifierSets.surnames,
    knownDepartments: classifierSets.departments,
  });

  const searchStart = Date.now();
  // #726 — match-type tier + ambiguity/length floor for the graduated
  // attribution boost + sparse concept admission. `meshOff` (Exact word) drops
  // it via the null, matching the SSR page's suppression of the concept layer.
  const meshRes = meshOff ? null : taxonomyMatch.meshResolution;
  const meshTier = meshRes
    ? meshMatchTier(meshRes.confidence, meshRes.curatedTopicAnchors.length)
    : undefined;
  const result = await searchPeople({
    q,
    page,
    sort,
    filters: {
      deptDiv: deptDiv.length > 0 ? deptDiv : undefined,
      personType: personType.length > 0 ? personType : undefined,
      activity: activity.length > 0 ? activity : undefined,
      includeIncomplete,
    },
    topic,
    // Issue #309 / SPEC §6.1.2 — hand the already-computed relevance mode and
    // classified shape down so `searchPeople` can route a `name` query to the
    // name-shape body without re-classifying or re-fetching the surname set.
    relevanceMode: appliedRelevanceMode,
    shape: queryShape,
    // Issue #310 / SPEC §6.1.3 — the resolved descriptor's descendant-UI set
    // drives the topic-shape attribution boost; searchPeople ignores it for
    // non-topic shapes. `meshOff` (scope=exact) suppresses it so the API matches
    // the SSR page, which passes `undefined` under "Exact word" to drop the boost.
    meshDescendantUis: meshOff ? undefined : taxonomyMatch.meshResolution?.descendantUis,
    // #726 — tier + ambiguity/length floor for sparse concept admission.
    meshMatchTier: meshTier,
    meshAmbiguous: meshRes?.ambiguous,
    meshMatchedFormLength: meshRes?.matchedForm.length,
    // #718 — concept-only result-SET gate. The SSR page threads `scope` into its
    // badge + streamed `searchPeople` calls (concept → people are gated to the
    // descriptor's `publicationMeshUi`); the route handler must pass it too, or
    // the API people count (ungated, 76) disagrees with the rendered Scholars
    // badge (gated, 5) for the identical request.
    scope,
    // Issue #688 — env-gated narrower-term match provenance. searchPeople only
    // attaches it on topic/unclassified hits that matched via a descendant; the
    // descriptor name frames the "… narrower term of {name}" string.
    matchProvenance: resolvePeopleMatchProvenance(),
    meshDescriptorName: taxonomyMatch.meshResolution?.name,
    // Issue #702 — env-gated pub-evidence highlighting + "Matched on" chip so a
    // publication-only match isn't left bare. Pure presentation metadata.
    matchExplain: resolvePeopleMatchExplain(),
    // Issue #967 — surface a representative matching publication inside the
    // reason line. Inert unless matchExplain is also on.
    representativePub: resolvePeopleSnippetRepresentativePub(),
    // Issue #692 — generic-term demotion (mode `on`). Topic/hybrid bodies score
    // and highlight on the content query (full query discounted); inert
    // otherwise and never applied to name/department shapes.
    genericDemote,
    contentQuery,
    // Issue #532 — env-gated dept-shape leadership boost. Ignored for
    // non-dept shapes inside `searchPeople`.
    deptLeadershipBoost: resolveDeptLeadershipBoost(),
    // #824 follow-up — match-aware snippet context so client tab-nav / pagination
    // (this route) keeps the method/topic reason the SSR page produced. Built off
    // the taxonomyMatch already resolved at the top of the handler; inert unless
    // SEARCH_PEOPLE_MATCH_AWARE_SNIPPET is on (searchPeople gates it).
    matchAwareContext: buildMatchAwareContext(taxonomyMatch),
  });
  const searchLatencyMs = Date.now() - searchStart;
  // ANALYTICS-02 (D-02): structured search-query log (people branch).
  // Issue #308 §9 — `queryShape` is now the lexical query classification
  // (cwid / name / department / topic / hybrid / unclassified / empty),
  // no longer the #259 OpenSearch-body label; log archives from before
  // this deploy are not comparable on this field.
  console.log(
    JSON.stringify({
      event: "search_query",
      q,
      type: "people",
      resultCount: result.total,
      queryShape,
      appliedRelevanceMode,
      filters: { deptDiv, personType, activity, includeIncomplete },
      meshResolutionDescriptorUi,
      meshResolutionConfidence,
      // SPEC §9 — resolved MeSH descendant-set size, reported only for the
      // shapes that consume it (topic / unclassified soft-fallback). Null
      // otherwise, even when a name/hybrid query happens to MeSH-resolve, so
      // the field reads as "the attribution path was in play with N descendants."
      meshDescendantSetSize:
        queryShape === "topic" || queryShape === "unclassified"
          ? (taxonomyMatch.meshResolution?.descendantUis.length ?? null)
          : null,
      // SPEC §9 / Issue #310 — did the §6.1.3 attribution boost move any
      // result? Boolean under the v3 topic template with a resolved
      // descriptor; null when the boost wasn't in play.
      attributionBoostFired: result.attributionBoostFired,
      taxonomyMatchMs,
      searchLatencyMs,
      // D3 SLI — OpenSearch round-trips this request made (serial-await guard).
      osRoundTrips: getOsRoundTripCount(),
      // SPEC §9 — top-3 result slugs + person types let the post-flip eval
      // backtest Recall@3 and per-cohort effects from production traffic.
      top3ResultSlugs: result.hits.slice(0, 3).map((h) => h.slug),
      top3PersonTypes: result.hits.slice(0, 3).map((h) => h.roleCategory),
      ts: new Date().toISOString(),
    }),
  );
  return jsonWithTiming(
    result,
    searchInterpretation,
    taxonomyMatchMs,
    searchLatencyMs,
    "searchPeople",
  );
}

function orUndefined<T>(arr: T[]): T[] | undefined {
  return arr.length > 0 ? arr : undefined;
}

// Issue #294 PR-5 — JSON response carrying a `Server-Timing` header so the
// resolver and search latencies show per-request in browser DevTools. The
// same split-scope numbers as the `search_query` log above (`taxonomyMatchMs`
// / `searchLatencyMs`), in the form DevTools and RUM tools parse natively.
//
// PLAN R3 — the result object is spread alongside `searchInterpretation`
// ({ scope, conceptLabel, meshMapped }) so all three branches return the same
// shape uniformly without each search result type having to carry the field.
function jsonWithTiming<T extends object>(
  body: T,
  searchInterpretation: SearchInterpretation,
  taxonomyMatchMs: number,
  searchLatencyMs: number,
  searchLabel: string,
) {
  return NextResponse.json(
    { ...body, searchInterpretation },
    {
      headers: {
        "Server-Timing": serverTimingHeader([
          { name: "taxonomy", ms: taxonomyMatchMs, desc: "matchQueryToTaxonomy" },
          { name: "search", ms: searchLatencyMs, desc: searchLabel },
        ]),
      },
    },
  );
}

// PLAN R3 — the interpretation block returned on every branch.
type SearchInterpretation = {
  scope: Scope;
  conceptLabel: string | null;
  meshMapped: boolean;
};
