import * as React from "react";
import {
  SearchTransitionProvider,
  TransitionLink as Link,
} from "@/components/search/transition-link";
import type { Metadata } from "next";
import { ChevronDown } from "lucide-react";
import { SortLinks } from "@/components/search/sort-links";
import { JournalFacet } from "@/components/search/journal-facet";
import { AuthorFacet } from "@/components/search/author-facet";
import { MeshOnlyToggle } from "@/components/search/mesh-only-toggle";
import { ExportButton } from "@/components/search/export-button";
import {
  PeopleResultCardStreamed,
  type KeyPaperConfig,
} from "@/components/search/people-result-card-streamed";
import { PublicationResultRow } from "@/components/search/publication-result-row";
import { ResultsGridFallback } from "@/components/search/result-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { AZDirectory } from "@/components/browse/az-directory";
import { ResearchAreasRow } from "@/components/search/research-areas-row";
import { ConceptEmptyState } from "@/components/search/concept-empty-state";
import {
  ConceptFallbackResults,
  ConceptFallbackAnnouncement,
} from "@/components/search/concept-fallback-results";
import {
  ScopeControl,
  ScopeNote,
  type ConceptInfo,
} from "@/components/search/scope-control";
import { buildMeshHref, buildScopeHref } from "./url-helpers";
import {
  type Scope,
  parseScopeParam,
  scopeToMeshParams,
  resolveConceptMode,
  resolveDeptLeadershipBoost,
  resolvePeopleRelevanceMode,
  resolveGenericTermMode,
  resolveSearchPeopleDivisionShape,
  resolvePeopleMatchExplain,
  resolvePeopleSnippetRepresentativePub,
  resolvePeopleReasonFromDoc,
  resolveSearchPeopleAreaBoost,
  resolveSearchPeopleFacultyProminence,
  resolvePublicationHighlight,
  resolvePublicationMatchProvenance,
  resolvePublicationDepartmentFilter,
  resolvePublicationMeshOnlyFilter,
  resolveConceptFallbackSparseEnabled,
  resolveSearchShellStreaming,
  resolveSearchEvidenceRows,
  computeConceptFallback,
  CONCEPT_FALLBACK_CAP,
  CONCEPT_FALLBACK_SPARSE_THRESHOLD,
} from "@/lib/api/search-flags";
import { stripDeprioritized } from "@/lib/api/deprioritized-terms";
import { classifyPeopleQuery } from "@/lib/api/people-query-shape";
import { getPeopleClassifierSets } from "@/lib/api/people-classifier-sets";
import {
  searchPeople,
  searchPublications,
  getConceptScholarConcentration,
  PI_MIN_CEILING,
  PI_MIN_FLOOR,
  type ActivityFilter,
  type DeptDivBucket,
  type PeopleSort,
  type PiFilter,
  type PublicationsSort,
  type SearchFacetBucket,
} from "@/lib/api/search";
import { meshMatchTier, AREA_BOOST_TOP_N } from "@/lib/search";
import { getAreaScholarConcentration } from "@/lib/api/topics";
import {
  searchFunding,
  type FundingFilters,
  type FundingRoleBucket,
  type FundingSort,
  type FundingStatus,
} from "@/lib/api/search-funding";
import { FundingResultsList } from "@/components/search/funding-results-list";
import { InvestigatorFacet } from "@/components/search/investigator-facet";
import { getAZBuckets } from "@/lib/api/browse";
import {
  matchQueryToTaxonomy,
  buildMatchAwareContext,
  type MeshResolution,
  type TaxonomyMatchResult,
} from "@/lib/api/search-taxonomy";
import { timed } from "@/lib/api/search-timing";
import { cachedReasonAgg, badgeCountKey } from "@/lib/api/reason-agg-cache";
import { prisma } from "@/lib/db";
import { logSearchDegraded } from "@/lib/analytics/errors";
import { formatRoleCategory } from "@/lib/role-display";
import { displayPublicationType } from "@/lib/publication-types";
import { expandSponsor, getSponsor, funderVerbose } from "@/lib/sponsor-lookup";
import { mechanismVerbose, mechanismDescriptor } from "@/lib/mechanism-lookup";
import { methodologyHref } from "@/lib/methodology-anchors";
import { FunderFacet } from "@/components/search/funder-facet";
import { HoverTooltip } from "@/components/ui/hover-tooltip";
import { compactUnitName } from "@/lib/org-unit-names";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // D-13: noindex but follow — preserves link equity through to profile pages.
  robots: { index: false, follow: true },
};

type SP = Promise<Record<string, string | string[] | undefined>>;

// Per-group OR'd repeated params (#9). Always returns an array; preserves
// order from the URL so chip-rendering matches what the user clicked.
function parseList(val: string | string[] | undefined): string[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  // Issue #861 — stream the shell ahead of the taxonomy + badge-count work. The
  // taxonomy resolver (cold `getMeshMap` precompute) and the three count-only
  // badge searches all block the first byte today, so a cold SSR paints nothing
  // for 6-10s. When the flag is on the shell `<main>` + a header/tabs skeleton
  // flush immediately and `SearchBody` (the byte-identical body below) resolves
  // inside a Suspense boundary so the results stream in. Flag off awaits the
  // same body inline, producing identical markup with the legacy paint timing.
  if (resolveSearchShellStreaming()) {
    return (
      <main>
        <React.Suspense fallback={<SearchShellSkeleton />}>
          <SearchBody searchParams={searchParams} />
        </React.Suspense>
      </main>
    );
  }
  return (
    <main>
      <SearchBody searchParams={searchParams} />
    </main>
  );
}

/* ============================================================
 * Shell skeleton — the header + tab strip placeholder flushed as the first
 * byte while `SearchBody` resolves taxonomy + counts + results inside the
 * Suspense boundary (#861). Mirrors the SearchMeta h1 + ModeTabs + results-grid
 * shape so the swap to real content barely shifts (same markup as
 * /search/loading.tsx, which is the route-level transition fallback).
 * ============================================================ */
function SearchShellSkeleton() {
  return (
    <div aria-busy="true">
      <div role="status" className="sr-only">
        Loading search results…
      </div>
      {/* SearchMeta — h1 */}
      <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-3">
        <Skeleton className="mb-2 h-7 w-72" />
        <Skeleton className="h-3 w-60" />
      </div>
      {/* ModeTabs — Scholars / Publications / Funding */}
      <div className="mx-auto mt-[15px] flex max-w-[1280px] gap-1 border-b border-[#e3e2dd] px-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-[42px] items-center gap-2 px-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-8 rounded-full" />
          </div>
        ))}
      </div>
      {/* Facet rail + results column */}
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-6 pt-6 pb-16 md:grid-cols-[240px_1fr]">
        <ResultsGridFallback type="people" />
      </div>
    </div>
  );
}

async function SearchBody({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "";
  const type = (Array.isArray(sp.type) ? sp.type[0] : sp.type) ?? "people";
  // Issue #1513 — the A–Z directory overflow link ("View all N scholars with
  // last name starting with X") passes a single last-name initial. Validated to
  // one A–Z letter; anything else is ignored (falls back to normal browse).
  const rawLetter = (Array.isArray(sp.letter) ? sp.letter[0] : sp.letter) ?? "";
  const letter = /^[A-Za-z]$/.test(rawLetter) ? rawLetter : "";
  const rawPage = parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "0", 10);
  const page = Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0;
  const rawSort = Array.isArray(sp.sort) ? sp.sort[0] : sp.sort;
  // Issue #259 §1.8 — when the impact-display flag is on, the empty-query
  // pub-tab default is "recency" (the new §1.8 option that subsumes the
  // legacy `year` sort with a `dateAddedToEntrez` tiebreak). Flag off
  // preserves the original `year` default so behaviour is unchanged.
  const pubImpactFlag = (process.env.SEARCH_PUB_TAB_IMPACT ?? "off") === "on";
  const emptyPubDefault = pubImpactFlag ? "recency" : "year";
  // Issue #1106 — empty-query "Browse" has no relevance signal: searchPeople
  // issues a `match_all`, so every hit scores equally under `_score` and
  // "Relevance" surfaces an arbitrary (index-order) ranking under a label
  // that promises one. Mirror the pub-tab flip above and default the people
  // tab to last-name A–Z when q="" — deterministic and consistent with the
  // A–Z directory strip already shown in browse mode. Relevance remains the
  // default the moment a query is present; an explicit ?sort= still wins.
  const emptyPeopleDefault = "lastname";
  const sort =
    rawSort ??
    (q === ""
      ? type === "publications"
        ? emptyPubDefault
        : emptyPeopleDefault
      : "relevance");

  // A single-letter `letter` browse shows the filtered people list, not the A–Z
  // grid (which is the entry point the overflow link drills down from).
  const showAZ = q === "" && type === "people" && letter === "";
  // Issue #294 PR-5 — time the taxonomy resolver. `taxonomyMatchMs` is null
  // when q is under 3 chars: the resolver call is skipped entirely, so the
  // log records "skipped" rather than a misleading ~0ms measurement.
  const [azBuckets, taxonomyTimed, peopleClassifierSets] = await Promise.all([
    showAZ ? getAZBuckets() : Promise.resolve(null),
    q.trim().length >= 3
      ? timed(() => matchQueryToTaxonomy(q))
      : Promise.resolve({
          result: { state: "none" as const, meshResolution: null },
          ms: null,
        }),
    // Perf — boot-cached classifier sets fetched in parallel with the
    // taxonomy resolver rather than sequentially after it. The two are
    // independent; only the synchronous classify() below consumes both.
    getPeopleClassifierSets(),
  ]);
  // Issue #692 — generic-term demotion on the SSR path (mirrors the
  // /api/search route) so the server-rendered result set ranks + highlights
  // identically to a subsequent client fetch. `removed` is empty (incl. the
  // never-strip-to-empty case) when nothing was stripped, so the resolution
  // retry and `genericDemote` both stay inert.
  const genericTermMode = resolveGenericTermMode();
  const { contentQuery, removed: genericRemoved } = stripDeprioritized(q);
  const genericStripped = genericTermMode !== "off" && genericRemoved.length > 0;
  const genericDemote = genericTermMode === "on" && genericRemoved.length > 0;

  let taxonomyMatch = taxonomyTimed.result;
  const taxonomyMatchMs = taxonomyTimed.ms;
  // Issue #692 §4.1 — full query first; only on a complete MISS (no curated
  // match AND no MeSH descriptor) retry against the stripped content query.
  // Full-first protects descriptors built from filler ("gene therapy").
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

  // Issue #259 §1.11 / §6.2 — `?mesh` URL contract. Three states:
  //   absent     → default expanded mode (chip renders narrow + broaden affordances)
  //   `=strict`  → chip-narrow override (force `concept_filtered` admission)
  //   `=off`     → "Search broadly instead" escape; resolution suppressed
  //                before reaching searchPublications, so §1.6/§5 fall back
  //                to the §1.2 multi_match shape (msm intact) and §1.8 hits
  //                return `conceptImpactScore: null`.
  // Precedence rule: `?mesh=off` wins over `?mesh=strict` regardless of URL
  // order. Shared helper guarantees route handler + SSR page agree.
  // PLAN R2/R6 — one `?match=exact|expanded|concept` scope (default expanded)
  // replaces the URL `?mesh=` surface, bridged onto the existing meshOff/meshStrict
  // levers so `expanded` stays byte-identical and `?mesh=off|strict` keeps working.
  const scope = parseScopeParam(sp);
  const { meshOff, meshStrict } = scopeToMeshParams(scope);
  // PLAN R2/R3 — resolved concept label (null = no query→MeSH mapping → no scope
  // row) + the three `?match=` hrefs, shared by all three tabs.
  const concept: ConceptInfo | null = taxonomyMatch.meshResolution
    ? {
        label: taxonomyMatch.meshResolution.name,
        descriptorUi: taxonomyMatch.meshResolution.descriptorUi,
        definition: taxonomyMatch.meshResolution.scopeNote,
      }
    : null;
  const scopeHrefs = {
    exact: buildScopeHref(sp, "exact"),
    expanded: buildScopeHref(sp, "expanded"),
    concept: buildScopeHref(sp, "concept"),
  };
  const effectiveMeshResolution = meshOff ? null : taxonomyMatch.meshResolution;
  // #726 — match-type tier for the graduated attribution boost + sparse concept
  // admission. Shared by the badge count and the streamed full search so both
  // agree (badge == list). `meshOff` (Exact word) suppresses it via the null.
  const meshTier = effectiveMeshResolution
    ? meshMatchTier(
        effectiveMeshResolution.confidence,
        effectiveMeshResolution.curatedTopicAnchors.length,
      )
    : undefined;
  // §5 / §7.1 — chip mode discriminator. Single source of truth shared with
  // `searchPublications`'s body construction and the route handler's log.
  const conceptMode = resolveConceptMode();
  const chipMode: "strict" | "expanded_default" | "expanded_narrow" =
    conceptMode === "expanded" && !meshStrict
      ? "expanded_default"
      : conceptMode === "expanded" && meshStrict
        ? "expanded_narrow"
        : "strict";

  // People filters (multi-select).
  const deptDiv = parseList(sp.deptDiv);
  const personType = parseList(sp.personType);
  const activity = parseList(sp.activity).filter(
    (a): a is ActivityFilter => a === "has_grants" || a === "recent_pub",
  );

  // Issue #233 — Principal Investigator facet. Single-select; `none` and
  // unset both mean "no filter" (URL contract). `pi_min` is meaningful only
  // when pi=multi; clamp to [PI_MIN_FLOOR, PI_MIN_CEILING] and default to
  // PI_MIN_FLOOR.
  const rawPi = Array.isArray(sp.pi) ? sp.pi[0] : sp.pi;
  const pi: PiFilter | undefined =
    rawPi === "any" || rawPi === "active" || rawPi === "multi" ? rawPi : undefined;
  const rawPiMin = parseOptionalInt(sp.pi_min);
  const piMin = Math.min(PI_MIN_CEILING, Math.max(PI_MIN_FLOOR, rawPiMin ?? PI_MIN_FLOOR));

  // Funding filters (issue #78 Wave D — multi-select repeated params).
  const fundingFilters: FundingFilters = {
    funder: parseList(sp.funder).length > 0 ? parseList(sp.funder) : undefined,
    directFunder: parseList(sp.directFunder).length > 0 ? parseList(sp.directFunder) : undefined,
    programType: parseList(sp.programType).length > 0 ? parseList(sp.programType) : undefined,
    mechanism: parseList(sp.mechanism).length > 0 ? parseList(sp.mechanism) : undefined,
    status: parseList(sp.status).filter(
      (s): s is FundingStatus => s === "active" || s === "ending_soon" || s === "recently_ended",
    ) as FundingStatus[] as FundingStatus[],
    department: parseList(sp.department).length > 0 ? parseList(sp.department) : undefined,
    role: parseList(sp.role).filter(
      (r): r is FundingRoleBucket => r === "PI" || r === "Multi-PI" || r === "Co-I",
    ) as FundingRoleBucket[],
    investigator: parseList(sp.investigator).length > 0 ? parseList(sp.investigator) : undefined,
  };
  // Empty arrays should collapse to undefined so the API treats them as
  // "no filter" rather than "match nothing".
  if (fundingFilters.status && fundingFilters.status.length === 0)
    fundingFilters.status = undefined;
  if (fundingFilters.role && fundingFilters.role.length === 0) fundingFilters.role = undefined;

  // Pub filters.
  const yearMin = parseOptionalInt(sp.yearMin);
  const yearMax = parseOptionalInt(sp.yearMax);
  const publicationType =
    (Array.isArray(sp.publicationType) ? sp.publicationType[0] : sp.publicationType) ?? "";
  const journal = parseList(sp.journal);
  const wcmAuthorRole = parseList(sp.wcmAuthorRole).filter(
    (r): r is "first" | "senior" | "middle" => r === "first" || r === "senior" || r === "middle",
  );
  const wcmAuthor = parseList(sp.wcmAuthor);
  // Issue #837 — Publications-tab Department facet. Reuses the shared
  // `?department=` URL param (the funding tab uses it too; only one of the two
  // tabs is active at a time). Only forwarded to `searchPublications` when the
  // flag is on; otherwise the array is dropped so a stale URL is inert.
  const pubDepartment = resolvePublicationDepartmentFilter() ? parseList(sp.department) : [];
  // Issue #396 — "Show only MeSH-tagged matches". The flag gates whether the
  // toggle renders at all; activation additionally needs `?searchMode=mesh-only`
  // present, so a stale param is inert when the flag is off (same gating shape
  // as the Department filter above). `meshOnlyFilterEnabled` flows to the rail
  // so it knows whether to render the toggle; `pubMeshOnly` is the active state.
  const meshOnlyFilterEnabled = resolvePublicationMeshOnlyFilter();
  const pubMeshOnly =
    meshOnlyFilterEnabled &&
    (Array.isArray(sp.searchMode) ? sp.searchMode[0] : sp.searchMode) ===
      "mesh-only";
  // Mentoring activity facet — multi-select on mentee program at time of
  // mentorship. URL param `mentoringProgram` accepts repeated values from
  // the set {md, mdphd, phd, postdoc, ecr}.
  const mentoringProgram = parseList(sp.mentoringProgram).filter(
    (v): v is "md" | "mdphd" | "phd" | "postdoc" | "ecr" =>
      v === "md" || v === "mdphd" || v === "phd" || v === "postdoc" || v === "ecr",
  );

  // Issue #8 item 1: the subhead "{n} people · {n} publications · {n} funding"
  // needs all counts regardless of which tab is active. Run lightweight
  // counts for the inactive tabs in parallel.
  //
  // Issue #294 PR-5 — `searchesMs` is the wall time of this parallel
  // Promise.all (≈ the slowest of the three searches) — the search phase the
  // user actually waits on. Per-function p50/p95 comes from the /api/search
  // route handler, which runs one search per request.
  // SPEC §12 PR-5 (#312) — classify the People-tab query and resolve the
  // relevance mode here too, so this SSR result set ranks identically to a
  // subsequent /api/search call (the route does the same). Without this the
  // server-rendered people tab would stay on the legacy body after the flip
  // while client-side requests went v3. Classifier sets are boot-cached.
  const peopleRelevanceMode = resolvePeopleRelevanceMode();
  // `peopleClassifierSets` is resolved in the parallel block above (Perf).
  // #1347 — division-shape routing (dark by default; mirrors the route). Adds division
  // names to the classifier vocabulary and resolves a bare division query to its roster
  // (deptDivKey) filter; the filter changes the result SET, so the count query below uses
  // `effectiveDeptDiv` too, keeping the badge count aligned with the list.
  const divisionShapeOn = resolveSearchPeopleDivisionShape();
  const knownDivisions = divisionShapeOn
    ? new Set(peopleClassifierSets.divisions.keys())
    : undefined;
  const divisionRosterKeys = divisionShapeOn
    ? (peopleClassifierSets.divisions.get(q.trim().toLowerCase()) ?? [])
    : [];
  const effectiveDeptDiv = [...deptDiv, ...divisionRosterKeys];
  const peopleQueryShape = classifyPeopleQuery({
    query: q,
    meshResolved: taxonomyMatch.meshResolution != null,
    knownCwids: peopleClassifierSets.cwids,
    knownSurnames: peopleClassifierSets.surnames,
    knownDepartments: peopleClassifierSets.departments,
    knownDivisions,
  });

  // Perf — start the active tab's FULL faceted search NOW, concurrently with the
  // three count-only badge queries below, instead of constructing it as a JSX
  // argument that only begins once the badge `await Promise.all` has settled. The
  // full search has no data dependency on the badge counts, so hoisting it removes
  // one serial OpenSearch round-trip from the critical path to the results. The
  // #861 shell-streaming design is preserved: the shell still paints on the badge
  // counts and the Suspense child still awaits this promise. Only the active
  // type's promise is created — the inactive branches stay null and fire no query.
  // The bare `.catch(() => {})` marks the promise handled so an early rejection
  // (before the Suspense child attaches its await) can't surface as an unhandled
  // rejection; the awaiting result component still receives the real value/error.
  // Scaling fix B — the per-row reason line ("N publications tagged …") is built
  // by a SECOND OpenSearch agg over the 178k-doc pub index that, for broad
  // concepts × prolific scholars, tails to 5–9s under load and blocks the
  // streamed People list. Decouple it: the list paints on a fast call that SKIPS
  // the reason agg (`skipReasonAgg`), and the full reason streams into the cards
  // from a separate promise resolved in a nested Suspense boundary (`use()` in
  // the card). The split only matters when `matchExplain` is on (otherwise no
  // reason agg runs and `skipReasonAgg` is a no-op).
  const peopleMatchExplain = resolvePeopleMatchExplain();
  // Track B — Research-Area concentration boost (spec: docs/search-research-area-relevance-spec.md).
  // Same resolution as the JSON route: when the flag is on, the query resolved to a
  // Research Area, and not under Exact word, pull the area's relevance×coverage ranking
  // ({cwid,total}) so area-concentrated scholars are lifted (topic/hybrid only,
  // reorder-only). `areas[0]` is the area drawn as the "Research Areas" chip. Cached
  // read; flag-off ⇒ skipped, the people search is byte-identical to today.
  let areaConcentration: { cwid: string; total: number }[] | undefined;
  if (
    type === "people" &&
    resolveSearchPeopleAreaBoost() &&
    !meshOff &&
    taxonomyMatch.state === "matches" &&
    taxonomyMatch.areas.length > 0
  ) {
    const top = taxonomyMatch.areas[0];
    const parentTopicId = top.entityType === "subtopic" ? top.parentTopicId : top.id;
    const subtopicId = top.entityType === "subtopic" ? top.id : null;
    if (parentTopicId) {
      areaConcentration = await getAreaScholarConcentration(
        parentTopicId,
        subtopicId,
        AREA_BOOST_TOP_N,
      );
    }
  }
  // #1343 — concept-axis fallback (mirrors the route). No curated area but a MeSH
  // descriptor resolved ⇒ source concentration from the publications index so the boost
  // reaches concept queries (obesity/hypertension). Reuses the area-boost source toggle.
  if (
    type === "people" &&
    resolveSearchPeopleAreaBoost() &&
    !meshOff &&
    (!areaConcentration || areaConcentration.length === 0) &&
    taxonomyMatch.meshResolution?.descendantUis?.length
  ) {
    areaConcentration = await getConceptScholarConcentration(
      taxonomyMatch.meshResolution.descendantUis,
      AREA_BOOST_TOP_N,
    );
  }
  const peopleSearchOpts =
    type === "people"
      ? {
          q,
          page,
          sort: sort as PeopleSort,
          // #1513 — last-name-initial browse (A–Z overflow link).
          letter: letter || undefined,
          filters: {
            deptDiv: effectiveDeptDiv.length > 0 ? effectiveDeptDiv : undefined,
            personType: personType.length > 0 ? personType : undefined,
            activity: activity.length > 0 ? activity : undefined,
            pi,
            piMin,
          },
          relevanceMode: peopleRelevanceMode,
          shape: peopleQueryShape,
          meshDescendantUis: meshOff ? undefined : taxonomyMatch.meshResolution?.descendantUis,
          // #1836 — ancestor tree-number closure for the clinical disease-subtree
          // subsumption (gated in searchPeople by SEARCH_PEOPLE_CLINICAL_MESH_ANCHOR).
          clinicalMeshTreeClosure: meshOff
            ? undefined
            : taxonomyMatch.meshResolution?.ancestorTreeNumbers,
          meshMatchTier: meshTier,
          meshAmbiguous: effectiveMeshResolution?.ambiguous,
          meshMatchedFormLength: effectiveMeshResolution?.matchedForm.length,
          scope,
          deptLeadershipBoost: resolveDeptLeadershipBoost(),
          // #1345 — full-time-faculty prominence lever (default ON). Resolved here so the
          // SSR list ranks identically to the /api/search route.
          facultyProminence: resolveSearchPeopleFacultyProminence(),
          genericDemote,
          contentQuery,
          meshDescriptorName: taxonomyMatch.meshResolution?.name,
          // Search reason-from-doc — the resolved ROOT concept UI (the O(1)
          // lookup key into the people doc's `meshSubtreeCounts`) + the flag.
          // When on and a concept resolved, the tagged reason count is served
          // from the precomputed doc field instead of the publications-index agg.
          meshDescriptorUi: meshOff ? undefined : taxonomyMatch.meshResolution?.descriptorUi,
          reasonFromDoc: resolvePeopleReasonFromDoc(),
          matchExplain: peopleMatchExplain,
          // Issue #967 — representative matching publication in the reason line.
          representativePub: resolvePeopleSnippetRepresentativePub(),
          // #824 follow-up — match-aware snippet context (resolved method family +
          // matched topics) derived from the already-resolved taxonomyMatch. Inert
          // unless SEARCH_PEOPLE_MATCH_AWARE_SNIPPET is on (searchPeople gates it).
          matchAwareContext: buildMatchAwareContext(taxonomyMatch),
          // Track B — Research-Area concentration boost (inert unless resolved above).
          areaConcentration,
        }
      : null;
  // Under reason-from-doc (D) the reason is a cheap O(1) lookup on the list
  // query's OWN hits — so fold it into the list call (skipReasonAgg:false) and
  // DROP the redundant second people-index query below. Pre-D the reason needed a
  // slow publications-index agg, so B deferred it to a second call; with D that
  // second call re-runs the people search just to read a field the list call
  // already has — pure waste that doubled the OpenSearch load under concurrency.
  const reasonFromDoc = resolvePeopleReasonFromDoc();
  const activePeoplePromise =
    peopleSearchOpts !== null
      ? searchPeople({
          ...peopleSearchOpts,
          skipReasonAgg: reasonFromDoc ? false : peopleMatchExplain,
        })
      : null;
  // The streamed reason map (cwid → reason/evidence). NON-doc path only: D folds
  // the reason into the list call above (no second query). On the legacy agg path
  // it is deduped/cached (scaling fix C) and NOT awaited on the critical path —
  // passed to the cards and unwrapped via `use()` so the list never blocks on it.
  // `.catch` keeps an early rejection from surfacing as unhandled; the card's
  // `use()` still sees the resolved value (empty on error).
  const activePeopleReasonPromise =
    peopleSearchOpts !== null && peopleMatchExplain && !reasonFromDoc
      ? searchPeople({ ...peopleSearchOpts, skipReasonAgg: false })
          .then(
            (r) =>
              new Map(
                r.hits.map((h) => [
                  h.cwid,
                  { matchReason: h.matchReason, evidence: h.evidence, evidenceLines: h.evidenceLines },
                ]),
              ),
          )
          .catch(() => new Map<string, PeopleReasonPatch>())
      : null;
  // Search reason-from-doc (lazy key papers, §5) — the config the streamed card
  // needs to fetch a concept-tagged key paper on viewport-enter. Enabled only
  // when the doc-sourced reason path is on (the inline rep-pub serves the key
  // paper otherwise). `descriptorUis` is the SAME concept subtree the count used;
  // `contentQuery` drives the `<mark>` highlight + the free-text fallback. Plain
  // serializable object handed to the client card; no promise / no extra query
  // here — the card fetches per-card, off the critical path.
  const keyPaperConfig =
    peopleSearchOpts !== null && peopleMatchExplain && resolvePeopleReasonFromDoc()
      ? {
          descriptorUis: meshOff
            ? []
            : (taxonomyMatch.meshResolution?.descendantUis ?? []),
          contentQuery,
          // #1351 — resolved concept name, so the key-paper title highlight can mark
          // the concept term (not just the literal query) on a tagged match.
          conceptLabel: meshOff ? "" : (taxonomyMatch.meshResolution?.name ?? ""),
        }
      : null;
  // SEARCH_EVIDENCE_ROWS — server-resolved once, threaded to each Scholars card to
  // gate the lazy Funding row + the publications flavor badge (off ⇒ no fetch, row,
  // or badge).
  const evidenceRows = resolveSearchEvidenceRows();
  const activePubsPromise =
    type === "publications"
      ? searchPublications({
          q,
          page,
          sort: sort as PublicationsSort,
          filters: {
            yearMin,
            yearMax,
            publicationType: publicationType || undefined,
            journal: journal.length > 0 ? journal : undefined,
            wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
            wcmAuthor: wcmAuthor.length > 0 ? wcmAuthor : undefined,
            department: pubDepartment.length > 0 ? pubDepartment : undefined,
            meshOnly: pubMeshOnly || undefined,
            mentoringPrograms:
              mentoringProgram.length > 0 ? mentoringProgram : undefined,
          },
          meshResolution: effectiveMeshResolution,
          meshStrict,
          genericDemote,
          contentQuery,
          highlightMatches: resolvePublicationHighlight(),
          matchProvenance: resolvePublicationMatchProvenance(),
        })
      : null;
  const activeFundingPromise =
    type === "funding"
      ? searchFunding({
          q,
          page,
          sort: sort as FundingSort,
          filters: fundingFilters,
          meshResolution: effectiveMeshResolution,
          scope,
        })
      : null;
  activePeoplePromise?.catch(() => {});
  activePubsPromise?.catch(() => {});
  activeFundingPromise?.catch(() => {});

  // Tab badge counts for all three corpora, count-only (size:0, no aggs, no
  // hydration). The active tab's hits + facets come from the hoisted full search
  // above, streamed inside <Suspense> below, so the shell (header, chip, tabs,
  // counts) paints without waiting on the faceted query. `hits.total.value` is
  // computed from the same query predicate, so these badge counts equal a full
  // search.
  const searchesStart = performance.now();
  const [peopleResult, pubsResult, fundingResult] = await Promise.all([
    cachedReasonAgg(badgeCountKey("people", q, scope), () =>
      searchPeople({
      q,
      // Track B — Research-Area concentration boost (count query; reorder-only, so the
      // badge total is unchanged — passed for parity with the list query).
      areaConcentration,
      page: type === "people" ? page : 0,
      sort: type === "people" ? (sort as PeopleSort) : "relevance",
      filters: {
        deptDiv: effectiveDeptDiv.length > 0 ? effectiveDeptDiv : undefined,
        personType: personType.length > 0 ? personType : undefined,
        activity: activity.length > 0 ? activity : undefined,
        pi,
        piMin,
      },
      // PR-5: route the §6.1 shape templates on the SSR path too.
      relevanceMode: peopleRelevanceMode,
      shape: peopleQueryShape,
      meshDescendantUis: meshOff ? undefined : taxonomyMatch.meshResolution?.descendantUis,
      // #1836 — ancestor tree-number closure for the clinical disease-subtree
      // subsumption (gated in searchPeople by SEARCH_PEOPLE_CLINICAL_MESH_ANCHOR).
      clinicalMeshTreeClosure: meshOff
        ? undefined
        : taxonomyMatch.meshResolution?.ancestorTreeNumbers,
      // #726 — tier + ambiguity/length floor for sparse concept admission.
      meshMatchTier: meshTier,
      meshAmbiguous: effectiveMeshResolution?.ambiguous,
      meshMatchedFormLength: effectiveMeshResolution?.matchedForm.length,
      // PLAN R5 / handoff item 3 — concept-only result-SET gate. Must match the
      // streamed full search's predicate or the badge count would disagree with
      // the list (`concept` shrinks the set; `expanded`/`exact` leave it alone).
      scope,
      // Issue #532 — env-gated dept-shape leadership boost (kept so the count
      // matches the streamed full search's predicate; it's a scoring function
      // and doesn't change the total, but passing it keeps the calls aligned).
      deptLeadershipBoost: resolveDeptLeadershipBoost(),
      // Issue #692 — keep the badge count aligned with the streamed full search
      // (the demote content-gate changes the total, so both calls must agree).
      genericDemote,
      contentQuery,
      // Perf — badge count only; the people tab's full result streams below.
      countOnly: true,
      }),
    ),
    cachedReasonAgg(
      badgeCountKey("publications", q, scope, { meshOnly: pubMeshOnly }),
      () =>
        searchPublications({
      q,
      page: type === "publications" ? page : 0,
      sort: type === "publications" ? (sort as PublicationsSort) : "relevance",
      filters: {
        yearMin,
        yearMax,
        publicationType: publicationType || undefined,
        journal: journal.length > 0 ? journal : undefined,
        wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
        wcmAuthor: wcmAuthor.length > 0 ? wcmAuthor : undefined,
        department: pubDepartment.length > 0 ? pubDepartment : undefined,
        meshOnly: pubMeshOnly || undefined,
        mentoringPrograms: mentoringProgram.length > 0 ? mentoringProgram : undefined,
      },
      // Issue #259 §5 + §1.8 — taxonomyMatch is computed unconditionally
      // above for the curated-callout. Forward the MeSH resolution so
      // searchPublications can (a) build the `concept_expanded` shape
      // when CONCEPT_MODE=expanded, (b) keep today's `concept_filtered`
      // body under strict mode, and (c) compute per-hit
      // `conceptImpactScore` when the §1.8 flag is on. §1.11 —
      // `effectiveMeshResolution` honors the user's `mesh=off` "Search
      // broadly instead" escape; when off, this is null and the pub query
      // falls back to the §1.2 shape.
      meshResolution: effectiveMeshResolution,
      // §6.2 — chip-engaged narrow-mode opt-in (`?mesh=strict`). Forces
      // strict-mode admission under flag = `expanded`.
      meshStrict,
      // Issue #692 — keep the badge count aligned with the streamed full search.
      genericDemote,
      contentQuery,
      // Perf — badge count only; the pub tab's full result streams below.
      countOnly: true,
        }),
    ),
    cachedReasonAgg(badgeCountKey("funding", q, scope), () =>
      searchFunding({
      q,
      page: type === "funding" ? page : 0,
      sort: type === "funding" ? (sort as FundingSort) : "relevance",
      filters: fundingFilters,
      // Issue #295 — forward the MeSH resolution so the funding query gains
      // its OR-of-evidence clause under SEARCH_FUNDING_TAB_CONCEPT=on. Same
      // `effectiveMeshResolution` (honors `?mesh=off`) passed to
      // searchPublications above.
      meshResolution: effectiveMeshResolution,
      // PLAN R5 / handoff item 3 — concept-only result-SET gate. Kept in lockstep
      // with the streamed full funding search so the badge matches the list
      // (`concept` shrinks the set; `expanded`/`exact` leave today's body alone).
      scope,
      // Perf — badge count only; the funding tab's full result streams below.
      countOnly: true,
      }),
    ),
  ]).catch((err) => {
    // #668 §3 — an OpenSearch outage on the shell's badge-count fetch is logged
    // as a structured, server-side `search_degraded` event before it bubbles to
    // app/(public)/search/error.tsx (the branded degraded panel). Rethrow so the
    // boundary renders. Query length only — never the query text.
    logSearchDegraded({ qLen: q.length });
    throw err;
  });
  const searchesMs = Math.round(performance.now() - searchesStart);

  // Issue #274 — the concept-aware empty state (and its broad-count fallback
  // search) now lives in PublicationsResults so it streams with the results
  // instead of blocking this shell. See that component for the logic.

  // Issue #294 PR-5 — structured render-timing log. The /search page is a
  // Server Component and cannot set a Server-Timing response header (the
  // route handler does); this log is the audit's "or equivalent" and is what
  // aggregates into p50/p95.
  console.log(
    JSON.stringify({
      event: "search_page_render",
      q,
      type,
      page,
      sort,
      peopleCount: peopleResult.total,
      pubCount: pubsResult.total,
      fundingCount: fundingResult.total,
      // Timing, whole ms. `taxonomyMatchMs` is null when q < 3 chars (the
      // resolver is skipped). `searchesMs` is now the parallel wall time of
      // the three count-only badge queries (the active tab's full faceted
      // search streams separately inside <Suspense>, so its latency shows in
      // the /api/search route handler's per-function timing, not here).
      // `broadCountMs` retired with the page-level #274 fallback (moved into
      // PublicationsResults); kept as null so the log schema is stable.
      taxonomyMatchMs,
      searchesMs,
      broadCountMs: null,
      // MeSH-resolution context — same field names as the route handler's
      // `search_query` log so the two streams join cleanly.
      meshResolutionDescriptorUi: taxonomyMatch.meshResolution?.descriptorUi ?? null,
      meshResolutionConfidence: taxonomyMatch.meshResolution?.confidence ?? null,
      meshOff,
      meshStrict,
      conceptMode,
      ts: new Date().toISOString(),
    }),
  );

  return (
    <>
      <SearchMeta q={q} taxonomyMatch={taxonomyMatch} />
      {/* Issue #638 — the research-area suggestion now renders as a compact
          card inside the SearchMeta header (top-right), and the MeSH boost
          (§259) + search-interpretation (§265) affordances move into the
          publications toolbar (see PublicationsResults). The old full-width
          banner band that sat between the title and the tabs is removed. */}
      {/* The transition provider wraps the mode tabs and the AZ block as well
          as the results grid, so a tab switch — and the MeSH "Narrow to this
          concept only" / "Don't use MeSH" links inside the results — runs
          through the SAME shared useTransition as the facet / sort / pagination
          links. Previously the tabs used a plain <Link> and lived outside the
          provider: an in-page nav that only changes searchParams gets no
          loading.tsx fallback and no dim, so a slow round-trip read as "the
          click did nothing." Inside the provider the region dims + goes
          aria-busy while the new results stream in. */}
      <SearchTransitionProvider>
        <ModeTabs
          q={q}
          activeType={type}
          peopleCount={peopleResult.total}
          pubCount={pubsResult.total}
          fundingCount={fundingResult.total}
          scope={scope}
        />
        {showAZ && azBuckets ? (
          <div className="mx-auto max-w-[1280px] px-6 pt-6">
            <AZDirectory buckets={azBuckets} />
            <div className="mt-2 text-right">
              <Link
                href="/browse"
                className="text-sm text-[var(--color-accent-slate)] hover:underline"
              >
                Or browse departments &amp; centers &#x2192;
              </Link>
            </div>
          </div>
        ) : null}
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-6 pt-6 pb-16 md:grid-cols-[240px_1fr]">
          {/* Perf streaming — the active tab's full faceted search runs inside
              this Suspense boundary so the shell above (header, chip, tabs,
              counts) paints first and the results grid fills in when ready. The
              fallback mirrors the real two-column shape (facet rail + result
              rows) to minimize layout shift. The result component awaits the
              promise internally and so suspends here. */}
          <React.Suspense
            fallback={
              <ResultsGridFallback
                type={
                  type === "publications"
                    ? "publications"
                    : type === "funding"
                      ? "funding"
                      : "people"
                }
              />
            }
          >
            {type === "publications" ? (
              <PublicationsResults
                q={q}
                page={page}
                sort={sort as PublicationsSort}
                yearMin={yearMin}
                yearMax={yearMax}
                publicationType={publicationType || undefined}
                journal={journal}
                wcmAuthorRole={wcmAuthorRole}
                wcmAuthor={wcmAuthor}
                department={pubDepartment}
                meshOnly={pubMeshOnly}
                meshOnlyFilterEnabled={meshOnlyFilterEnabled}
                mentoringProgram={mentoringProgram}
                resultPromise={activePubsPromise!}
                meshResolution={effectiveMeshResolution}
                chipMode={chipMode}
                broadenHref={buildMeshHref(sp, "off")}
                scope={scope}
                concept={concept}
                scopeHrefs={scopeHrefs}
              />
            ) : type === "funding" ? (
              <FundingResults
                q={q}
                page={page}
                sort={sort as FundingSort}
                filters={fundingFilters}
                scope={scope}
                concept={concept}
                scopeHrefs={scopeHrefs}
                resultPromise={activeFundingPromise!}
              />
            ) : (
              <PeopleResults
                q={q}
                letter={letter}
                page={page}
                sort={sort as PeopleSort}
                deptDiv={deptDiv}
                personType={personType}
                activity={activity}
                pi={pi}
                piMin={piMin}
                scope={scope}
                concept={concept}
                scopeHrefs={scopeHrefs}
                resultPromise={activePeoplePromise!}
                reasonPromise={activePeopleReasonPromise}
                keyPaperConfig={keyPaperConfig}
                evidenceRows={evidenceRows}
              />
            )}
          </React.Suspense>
        </div>
      </SearchTransitionProvider>
    </>
  );
}

function parseOptionalInt(val: string | string[] | undefined): number | undefined {
  const s = Array.isArray(val) ? val[0] : val;
  if (s === undefined || s === "") return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Stable sort that pulls active items to the front so they survive the
 * `collapseAfter` cutoff in FacetGroup. Keeps the original order (count-
 * desc) inside each partition.
 */
function sortActiveFirst<T>(items: T[], isActive: (t: T) => boolean): T[] {
  const active: T[] = [];
  const rest: T[] = [];
  for (const it of items) (isActive(it) ? active : rest).push(it);
  return [...active, ...rest];
}

/** Lookup aliases for a canonical sponsor short — used by the Funder
 *  type-ahead so users can search by alternate names. Returns lowercased
 *  strings for case-insensitive matching. */
function collectAliases(short: string): string[] {
  const s = getSponsor(short);
  if (!s?.aliases) return [];
  return s.aliases.map((a) => a.toLowerCase());
}

/* ============================================================
 * Search-meta strip — h1 with quoted query span (PLAN R1: counts subhead removed)
 * ============================================================ */
function SearchMeta({
  q,
  taxonomyMatch,
}: {
  q: string;
  taxonomyMatch: TaxonomyMatchResult;
}) {
  return (
    <div className="mx-auto max-w-[1280px] px-6 pt-5 pb-3">
      <h1 className="page-title mb-1 text-[28px] leading-tight font-bold tracking-[-0.01em]">
        {q ? (
          <>
            {/* #638 (b) — query echoed in primary text (not an accent "link"
                color); set apart from a lighter-weight "Results for" by weight
                + quotes. Accent reserved for real links. */}
            <span className="font-normal">Results for </span>
            <span className="font-bold text-foreground">
              {"“"}
              {q}
              {"”"}
            </span>
          </>
        ) : (
          "Browse"
        )}
      </h1>
      {/* PLAN R1 — the duplicated "{n} scholars · {n} publications · {n} funding"
          summary line was removed: the per-type counts already live on the tab
          badges, which also act as the switcher. */}
      {/* #709 — Research Areas chip row: below the heading, above the tabs.
          Replaces the top-right "Research area at WCM" card (RA-1/RA-2). */}
      <ResearchAreasRow result={taxonomyMatch} />
    </div>
  );
}

/* ============================================================
 * Mode tabs — slate accent with count pills
 * ============================================================ */
function ModeTabs({
  q,
  activeType,
  peopleCount,
  pubCount,
  fundingCount,
  scope,
}: {
  q: string;
  activeType: string;
  peopleCount: number;
  pubCount: number;
  fundingCount: number;
  scope: Scope;
}) {
  // Carry the active match-scope across tab switches (default `expanded` omitted).
  const tabHref = (t: string) => {
    const params = new URLSearchParams({ q, type: t });
    if (scope !== "expanded") params.set("match", scope);
    return `/search?${params.toString()}`;
  };
  const peopleHref = tabHref("people");
  const pubHref = tabHref("publications");
  const fundingHref = tabHref("funding");
  return (
    <nav className="mx-auto mt-[15px] flex max-w-[1280px] gap-1 border-b border-[#e3e2dd] px-6">
      <ModeTab
        href={peopleHref}
        label="Scholars"
        count={peopleCount}
        active={activeType === "people"}
      />
      <ModeTab
        href={pubHref}
        label="Publications"
        count={pubCount}
        active={activeType === "publications"}
      />
      <ModeTab
        href={fundingHref}
        label="Funding"
        count={fundingCount}
        active={activeType === "funding"}
      />
    </nav>
  );
}

function ModeTab({
  href,
  label,
  count,
  active,
  title,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  title?: string;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      title={title}
      className={`-mb-px inline-flex h-[42px] items-center gap-2 border-b-2 px-4 text-[13px] transition-colors ${
        active
          ? "border-[#2c4f6e] font-semibold text-[#2c4f6e]"
          : "border-transparent font-medium text-[#4a4a4a] hover:text-[#1a1a1a]"
      }`}
    >
      {label}
      <span
        className={`inline-flex h-5 min-w-[28px] items-center justify-center rounded-full px-1.5 text-[11px] font-medium ${
          active ? "bg-[#eaf0f5] text-[#2c4f6e]" : "bg-[#f7f6f3] text-muted-foreground"
        }`}
      >
        {count.toLocaleString()}
      </span>
    </Link>
  );
}

/* ============================================================
 * People tab content
 * ============================================================ */
type PeopleResultData = Awaited<ReturnType<typeof searchPeople>>;
type PubsResultData = Awaited<ReturnType<typeof searchPublications>>;
// Scaling fix B — the deferred per-row reason patch streamed into the cards. The
// list paints without it; the card's `use()` overlays it when the promise
// resolves. Carries both the legacy `matchReason` and the `evidence.pub` reason
// so the card patches whichever path is active (ResultEvidence vs legacy).
type PeopleReasonPatch = {
  matchReason: PeopleResultData["hits"][number]["matchReason"];
  evidence: PeopleResultData["hits"][number]["evidence"];
  // #1366 — the stacked, counted lines (present instead of `evidence` under the
  // reason-counts flag); streamed and overlaid the same way.
  evidenceLines: PeopleResultData["hits"][number]["evidenceLines"];
};
type PeopleReasonMap = Map<string, PeopleReasonPatch>;

// Module-level TTL cache for the dept/div/center reference rows (B5). The three
// tables are tiny (~80 near-static rows) and change only on a nightly ETL
// reseed, yet `resolveDeptDivLabels` runs on every People-tab render (and again
// on the Pubs Department facet), so without memoization each /search hit pays
// three Prisma round-trips. We cache the PLAIN ARRAYS and rebuild the Map per
// call below, mirroring lib/api/people-classifier-sets.ts: a `{ data, ts }`
// cache + an `inflight` promise guard + a TTL gate. Labels are display-only chip
// text (never counts/ranking), so the time-based staleness is acceptable;
// /search is not in the revalidate allow-list, so a TTL is the only viable
// invalidation here.
type DeptDivData = {
  depts: { code: string; name: string }[];
  divs: { code: string; name: string; deptCode: string }[];
  centers: { code: string; name: string; compactName: string | null }[];
};

const DEPT_DIV_TTL_MS = 60 * 60 * 1000; // 1h — well within the nightly ETL reseed cadence
let deptDivCache: { data: DeptDivData; ts: number } | null = null;
let deptDivInflight: Promise<DeptDivData> | null = null;

// Loads (and TTL-caches) the three reference tables. Concurrent callers share
// one inflight refresh so a cold render issues the three queries at most once.
// An error propagates to the caller (unchanged from the pre-cache behavior) and
// is not cached, so the next request retries.
async function loadDeptDivData(): Promise<DeptDivData> {
  if (deptDivCache && Date.now() - deptDivCache.ts < DEPT_DIV_TTL_MS) {
    return deptDivCache.data;
  }
  if (deptDivInflight) return deptDivInflight;
  deptDivInflight = (async () => {
    try {
      const [depts, divs, centers] = await Promise.all([
        prisma.department.findMany({ select: { code: true, name: true } }),
        prisma.division.findMany({
          select: { code: true, name: true, deptCode: true },
        }),
        prisma.center.findMany({ select: { code: true, name: true, compactName: true } }),
      ]);
      const data: DeptDivData = { depts, divs, centers };
      deptDivCache = { data, ts: Date.now() };
      return data;
    } finally {
      deptDivInflight = null;
    }
  })();
  return deptDivInflight;
}

// One-shot label resolver for the dept/div/center facet. Backed by the
// module-level TTL cache above so the underlying rows are fetched at most once
// per TTL window; the returned Map is rebuilt per call. Centers and departments
// key on `code`, divisions key on `${deptCode}--${divCode}`, and the long-tail
// free-text fallback uses the bare name.
async function resolveDeptDivLabels(): Promise<Map<string, string>> {
  const { depts, divs, centers } = await loadDeptDivData();
  const deptByCode = new Map(depts.map((d) => [d.code, d.name]));
  const out = new Map<string, string>();
  for (const d of depts) out.set(d.code, d.name);
  for (const div of divs) {
    const dn = deptByCode.get(div.deptCode);
    out.set(`${div.deptCode}--${div.code}`, dn ? `${div.name} — ${dn}` : div.name);
  }
  for (const c of centers)
    out.set(`center:${c.code}`, compactUnitName({ name: c.name, compactName: c.compactName }));
  return out;
}

function deptDivLabel(key: string, map: Map<string, string>): string {
  const direct = map.get(key);
  if (direct) return direct;
  if (key.startsWith("name:")) return key.slice(5);
  return key;
}

async function PeopleResults({
  q,
  letter,
  page,
  sort,
  deptDiv,
  personType,
  activity,
  pi,
  piMin,
  scope,
  concept,
  scopeHrefs,
  resultPromise,
  reasonPromise,
  keyPaperConfig,
  evidenceRows,
}: {
  q: string;
  /** #1513 — A–Z last-name-initial browse; preserved across facet/sort/page links. */
  letter: string;
  page: number;
  sort: PeopleSort;
  deptDiv: string[];
  personType: string[];
  activity: ActivityFilter[];
  pi: PiFilter | undefined;
  piMin: number;
  scope: Scope;
  concept: ConceptInfo | null;
  scopeHrefs: Record<Scope, string>;
  /** Perf streaming — the active full search, awaited here so this component
   *  suspends and the page shell (header + tabs + counts) paints first. This
   *  call SKIPS the reason agg (scaling fix B), so the list paints fast. */
  resultPromise: Promise<PeopleResultData>;
  /** Scaling fix B — the deferred reason map (cwid → reason/evidence patch),
   *  NOT awaited here. Passed to each card and unwrapped client-side via `use()`
   *  inside a nested Suspense, so the slow reason line streams in after the list
   *  paints. Null when `matchExplain` is off (no reason line to defer). */
  reasonPromise: Promise<PeopleReasonMap> | null;
  /** Search reason-from-doc (lazy key papers) — the per-card lazy key-paper
   *  config, or null when the doc-sourced reason path is off. */
  keyPaperConfig: KeyPaperConfig | null;
  /** SEARCH_EVIDENCE_ROWS — gates the per-card lazy Funding row + pub flavor badge. */
  evidenceRows: boolean;
}) {
  // Overlap the search round-trip with the dept/div label lookup.
  const [result, deptDivLabelMap] = await Promise.all([
    resultPromise,
    resolveDeptDivLabels(),
  ]);
  // PLAN R2/R3 — scope control + explanation line above the results toolbar.
  const scopeRow = concept ? (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <ScopeNote scope={scope} query={q} concept={concept} />
      <ScopeControl active={scope} hrefs={scopeHrefs} />
    </div>
  ) : null;
  // Two URL builders share one base. `resetPage` is true for any link that
  // changes the result set (toggle a facet, change sort, swap tab) — those
  // should land on page 0. Pagination links pass `resetPage: false` so the
  // mutator's `sp.set("page", N)` actually survives.
  const buildUrl = (
    mut: (sp: URLSearchParams) => void,
    { resetPage = true }: { resetPage?: boolean } = {},
  ) => {
    const sp = new URLSearchParams();
    sp.set("q", q);
    sp.set("type", "people");
    // #1513 — preserve the A–Z last-name-initial scope across every facet/sort/
    // pagination link, so navigating the filtered browse doesn't silently revert
    // to the full people list (mirrors the #396 searchMode preservation).
    if (letter) sp.set("letter", letter);
    if (sort !== "relevance") sp.set("sort", sort);
    for (const v of deptDiv) sp.append("deptDiv", v);
    for (const v of personType) sp.append("personType", v);
    for (const v of activity) sp.append("activity", v);
    if (pi) sp.set("pi", pi);
    // `pi_min` is only meaningful for pi=multi; default value is dropped
    // from the URL to keep saved bookmarks tidy.
    if (pi === "multi" && piMin !== PI_MIN_FLOOR) sp.set("pi_min", String(piMin));
    if (scope !== "expanded") sp.set("match", scope);
    if (resetPage) sp.delete("page");
    mut(sp);
    return `/search?${sp.toString()}`;
  };

  const toggleHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      if (current.includes(value)) {
        for (const v of current) if (v !== value) sp.append(axis, v);
      } else {
        for (const v of current) sp.append(axis, v);
        sp.append(axis, value);
      }
    });

  const removeHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      for (const v of current) if (v !== value) sp.append(axis, v);
    });

  // Issue #233 — single-select PI radio. `null` clears the filter (returns
  // to "No filter" default). Always wipes `pi_min` so a saved bookmark
  // doesn't leak a stale threshold onto a non-multi selection.
  const setPiHref = (next: PiFilter | null) =>
    buildUrl((sp) => {
      sp.delete("pi");
      sp.delete("pi_min");
      if (next) sp.set("pi", next);
    });
  const setPiMinHref = (next: number) =>
    buildUrl((sp) => {
      const clamped = Math.min(PI_MIN_CEILING, Math.max(PI_MIN_FLOOR, next));
      sp.set("pi", "multi");
      sp.delete("pi_min");
      if (clamped !== PI_MIN_FLOOR) sp.set("pi_min", String(clamped));
    });

  // #1513 — "Clear all" drops the letter too (it renders as a chip below, so
  // clearing all must remove every chip). Individual facet ✕ and pagination keep
  // the letter (that's the buildUrl preservation); only the letter chip's own ✕
  // and "Clear all" exit the letter browse.
  const clearAllParams = new URLSearchParams({ q, type: "people" });
  if (scope !== "expanded") clearAllParams.set("match", scope);
  const clearAllHref = `/search?${clearAllParams.toString()}`;

  // One chip per selected value.
  const chips: Array<{ label: React.ReactNode; ariaLabel?: string; removeHref: string }> = [];
  // #1513 — the A–Z last-name-initial scope renders as the first chip so the
  // filtered browse is visible and clearable; its ✕ exits to the full people list.
  if (letter) {
    const initial = letter.toUpperCase();
    chips.push({
      label: `Last name: ${initial}`,
      ariaLabel: `Remove last-name filter (${initial})`,
      removeHref: buildUrl((sp) => sp.delete("letter")),
    });
  }
  for (const v of personType) {
    chips.push({
      label: formatRoleCategory(v) ?? v,
      removeHref: removeHref("personType", v),
    });
  }
  for (const v of deptDiv) {
    chips.push({
      label: deptDivLabel(v, deptDivLabelMap),
      removeHref: removeHref("deptDiv", v),
    });
  }
  for (const v of activity) {
    chips.push({
      label: v === "has_grants" ? "Has active grants" : "Published in last 2 years",
      removeHref: removeHref("activity", v),
    });
  }
  if (pi) {
    chips.push({
      label:
        pi === "any"
          ? "Any PI role, ever"
          : pi === "active"
            ? "Active PI"
            : `Multi-grant PI (≥${piMin})`,
      removeHref: setPiHref(null),
    });
  }

  const hasActiveFilters = chips.length > 0;

  // Inject resolved labels onto each dept/div/center bucket so the
  // sidebar can render human strings without a second Prisma round-trip.
  const deptDivBuckets = result.facets.deptDivs.map((b) => ({
    ...b,
    label: deptDivLabel(b.value, deptDivLabelMap),
  }));

  return (
    <>
      <FacetSidebar
        deptDivs={deptDivBuckets}
        personTypes={result.facets.personTypes}
        activity={result.facets.activity}
        piFacets={result.facets.pi}
        activeDeptDiv={deptDiv}
        activePersonType={personType}
        activeActivity={activity}
        activePi={pi}
        activePiMin={piMin}
        toggleHref={toggleHref}
        setPiHref={setPiHref}
        setPiMinHref={setPiMinHref}
        clearAllHref={clearAllHref}
        hasActiveFilters={hasActiveFilters}
      />
      <section>
        {scopeRow}
        {chips.length > 0 ? <ActiveFilterChips chips={chips} clearAllHref={clearAllHref} /> : null}
        <ResultsToolbar
          tab="people"
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={sort}
          hasActiveFilters={hasActiveFilters}
          buildSortHref={(value) =>
            buildUrl((sp) => {
              if (value === "relevance") sp.delete("sort");
              else sp.set("sort", value);
            })
          }
        />
        {result.hits.length === 0 ? (
          <EmptyState
            query={q}
            tip={
              hasActiveFilters
                ? "Try clearing filters."
                : "Try a broader search term, or browse by department."
            }
          />
        ) : (
          <ul className="flex flex-col">
            {result.hits.map((h, i) => (
              <li key={h.cwid}>
                <PeopleResultCardStreamed
                  hit={h}
                  position={page * result.pageSize + i}
                  q={q}
                  total={result.total}
                  filters={{ deptDiv, personType, activity }}
                  reasonPromise={reasonPromise}
                  keyPaperConfig={keyPaperConfig}
                  evidenceRows={evidenceRows}
                />
              </li>
            ))}
          </ul>
        )}
        <Pagination
          page={result.page}
          total={result.total}
          pageSize={result.pageSize}
          buildHref={(p) =>
            buildUrl(
              (sp) => {
                if (p > 0) sp.set("page", String(p));
                else sp.delete("page");
              },
              { resetPage: false },
            )
          }
        />
      </section>
    </>
  );
}

/* ============================================================
 * Publications tab — single-select today (no facet rewrite)
 * ============================================================ */
async function PublicationsResults({
  q,
  page,
  sort,
  yearMin,
  yearMax,
  publicationType,
  journal,
  wcmAuthorRole,
  wcmAuthor,
  department,
  meshOnly,
  meshOnlyFilterEnabled,
  mentoringProgram,
  resultPromise,
  meshResolution,
  chipMode,
  broadenHref,
  scope,
  concept,
  scopeHrefs,
}: {
  q: string;
  page: number;
  sort: PublicationsSort;
  yearMin?: number;
  yearMax?: number;
  publicationType?: string;
  journal: string[];
  wcmAuthorRole: Array<"first" | "senior" | "middle">;
  wcmAuthor: string[];
  /** Issue #837 — active WCM-author department keys (empty when the flag is
   *  off; the page drops the param in that case). */
  department: string[];
  /** Issue #396 — "Show only MeSH-tagged matches" active state (true only when
   *  the flag is on AND `?searchMode=mesh-only` is present). */
  meshOnly: boolean;
  /** Issue #396 — whether the MeSH-only toggle should render in the facet rail
   *  (the `SEARCH_PUB_MESH_ONLY_FILTER` flag). */
  meshOnlyFilterEnabled: boolean;
  mentoringProgram: Array<"md" | "mdphd" | "phd" | "postdoc" | "ecr">;
  /** Perf streaming — see PeopleResults.resultPromise. */
  resultPromise: Promise<PubsResultData>;
  /**
   * Issue #274 — concept-aware empty-state inputs. When the query resolved to
   * a MeSH descriptor and the active concept shape gates on it, a zero-hit
   * result swaps the generic empty state for one that names the descriptor and
   * offers a broad-search escape with a concrete count. Computed below (after
   * the result resolves) rather than passed in, so the broad-count fallback
   * streams with the results instead of blocking the page shell.
   */
  meshResolution: MeshResolution | null;
  chipMode: "strict" | "expanded_default" | "expanded_narrow";
  /** #274 concept-aware empty-state "search broadly" escape (mesh=off). */
  broadenHref: string;
  /** PLAN R2/R3 — active scope, resolved concept label (null = no query→MeSH
   *  mapping, so no scope row renders), and the three `?match=` hrefs. */
  scope: Scope;
  concept: ConceptInfo | null;
  scopeHrefs: Record<Scope, string>;
}) {
  const result = await resultPromise;
  // Issue #837 — resolve WCM-author department keys to display labels for the
  // Department facet + chips, reusing the People-tab's one-shot resolver.
  // Loaded only when the facet is live (a department bucket or an active
  // selection exists), so flag-off renders pay nothing.
  const departmentLive =
    result.facets.departments.length > 0 || department.length > 0;
  const deptLabelMap = departmentLive ? await resolveDeptDivLabels() : new Map<string, string>();
  // Issue #274 — concept-aware empty state (moved here from the page so the
  // broad-count fallback streams with the results). Fires only when a
  // descriptor resolved, the result is empty, and we're not in default-expanded
  // mode (which admits via the top-level should and so doesn't gate on the
  // concept). The broad-count CTA runs one extra text-only search, paid only on
  // these dead-end pages.
  //
  // Issue #298 — the same broad search now also feeds the co-render: when a
  // resolved-concept page is empty (zero-trigger) or sparse (1..5 tagged hits
  // while broad ≥ 5×), `ConceptFallbackResults` previews the top-N broad hits
  // inline (§3/§5). The broad search runs once and supplies BOTH the empty-state
  // count and the fallback hits; the decision (`computeConceptFallback`) is the
  // pure shared rule, gated so we only pay the extra round-trip on candidate
  // pages.
  const sparseEnabled = resolveConceptFallbackSparseEnabled();
  const conceptShape =
    result.queryShape === "concept_filtered" ||
    result.queryShape === "concept_fallback";
  // Cheap pre-gate before paying for the broad search: a resolved descriptor,
  // not the default-expanded (OR-of-evidence) shape, on the first page, with a
  // primary count low enough to ever co-render (zero, or within the sparse
  // window). This mirrors the conditions `computeConceptFallback` checks against
  // the un-yet-known broadCount.
  const fallbackCandidate =
    meshResolution !== null &&
    chipMode !== "expanded_default" &&
    conceptShape &&
    page === 0 &&
    result.total <= CONCEPT_FALLBACK_SPARSE_THRESHOLD;

  let broadCount: number | null = null;
  let broadHits: typeof result.hits = [];
  if (fallbackCandidate) {
    const broad = await searchPublications({
      q,
      page: 0,
      sort: "relevance",
      filters: {
        yearMin,
        yearMax,
        publicationType: publicationType || undefined,
        journal: journal.length > 0 ? journal : undefined,
        wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
        wcmAuthor: wcmAuthor.length > 0 ? wcmAuthor : undefined,
        department: department.length > 0 ? department : undefined,
        meshOnly: meshOnly || undefined,
        mentoringPrograms:
          mentoringProgram.length > 0 ? mentoringProgram : undefined,
      },
      // Suppress the resolution → §1.2 shape, same as "Search broadly instead".
      // §8 #6 — the user's year/journal/author filters DO carry into the broad
      // call (broadening is about the concept gate, not the other filters).
      meshResolution: null,
      // Perf (B4) — the caller reads only `broad.total` + `broad.hits`;
      // `broad.facets` is discarded. Hits-only keeps the hits + per-hit
      // hydration but skips the aggs block and the ≤500-row facet
      // `scholar.findMany` (and the mentoring ReciterDB round-trip when no
      // mentoring filter is active).
      hitsOnly: true,
      // SEARCH_PUB_HIGHLIGHT — keep the fallback rows' highlighting consistent
      // with the primary list.
      highlightMatches: resolvePublicationHighlight(),
    });
    broadCount = broad.total;
    broadHits = broad.hits;
  }

  // Issue #298 §3 — the co-render decision (zero | sparse | none), shared with
  // the route handler's telemetry. `meshOff` is encoded by `meshResolution`
  // already being null (effectiveMeshResolution), so `scope === "exact"` need
  // not be threaded separately here.
  const fallbackDecision = computeConceptFallback({
    meshResolved: meshResolution !== null,
    meshOff: false,
    chipMode,
    total: result.total,
    broadCount: broadCount ?? 0,
    page,
    sparseEnabled,
  });
  const conceptFallback = fallbackDecision.shown
    ? { hits: broadHits, total: broadCount ?? 0 }
    : null;

  let conceptEmpty: {
    descriptorName: string;
    broadCount: number | null;
    broadenHref: string;
  } | null = null;
  if (meshResolution && result.total === 0 && chipMode !== "expanded_default") {
    conceptEmpty = {
      descriptorName: meshResolution.name,
      broadCount,
      broadenHref,
    };
  }
  const buildUrl = (
    mut: (sp: URLSearchParams) => void,
    { resetPage = true }: { resetPage?: boolean } = {},
  ) => {
    const sp = new URLSearchParams();
    sp.set("q", q);
    sp.set("type", "publications");
    if (sort !== "relevance") sp.set("sort", sort);
    if (yearMin !== undefined) sp.set("yearMin", String(yearMin));
    if (yearMax !== undefined) sp.set("yearMax", String(yearMax));
    if (publicationType) sp.set("publicationType", publicationType);
    for (const v of journal) sp.append("journal", v);
    for (const v of wcmAuthorRole) sp.append("wcmAuthorRole", v);
    for (const v of wcmAuthor) sp.append("wcmAuthor", v);
    for (const v of department) sp.append("department", v);
    for (const v of mentoringProgram) sp.append("mentoringProgram", v);
    // Issue #396 — preserve the MeSH-only filter across every facet/sort/page
    // link so toggling another filter doesn't silently drop it. The toggle's
    // own on/off hrefs override `searchMode` in their `mut` callback.
    if (meshOnly) sp.set("searchMode", "mesh-only");
    if (scope !== "expanded") sp.set("match", scope);
    if (resetPage) sp.delete("page");
    mut(sp);
    return `/search?${sp.toString()}`;
  };

  // Toggle a value in/out of a multi-value group, preserving repeated keys.
  const toggleHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      if (current.includes(value)) {
        for (const v of current) if (v !== value) sp.append(axis, v);
      } else {
        for (const v of current) sp.append(axis, v);
        sp.append(axis, value);
      }
    });

  const removeMulti = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      for (const v of current) if (v !== value) sp.append(axis, v);
    });

  const clearAllParams = new URLSearchParams({ q, type: "publications" });
  if (scope !== "expanded") clearAllParams.set("match", scope);
  const clearAllHref = `/search?${clearAllParams.toString()}`;

  // Issue #396 — MeSH-only toggle hrefs (page always reset). ON adds
  // `searchMode=mesh-only`; OFF removes it. Both override the param `buildUrl`
  // would otherwise preserve, so the toggle flips state regardless of the
  // current value. The "Remove filter" link in the count line / empty state
  // reuses `meshOnlyOffHref`.
  const meshOnlyOnHref = buildUrl((sp) => sp.set("searchMode", "mesh-only"));
  const meshOnlyOffHref = buildUrl((sp) => sp.delete("searchMode"));

  const ROLE_LABEL: Record<"first" | "senior" | "middle", string> = {
    first: "First author",
    senior: "Senior author",
    middle: "Middle author",
  };

  const chips: Array<{ label: React.ReactNode; ariaLabel?: string; removeHref: string }> = [];
  if (yearMin !== undefined || yearMax !== undefined) {
    let label: string;
    if (yearMin !== undefined && yearMax !== undefined) {
      label = yearMin === yearMax ? `${yearMin}` : `${yearMin}–${yearMax}`;
    } else if (yearMin !== undefined) {
      label = `Since ${yearMin}`;
    } else {
      label = `Through ${yearMax}`;
    }
    chips.push({
      label,
      removeHref: buildUrl((sp) => {
        sp.delete("yearMin");
        sp.delete("yearMax");
      }),
    });
  }
  if (publicationType) {
    chips.push({
      label: displayPublicationType(publicationType),
      removeHref: buildUrl((sp) => sp.delete("publicationType")),
    });
  }
  for (const v of wcmAuthorRole) {
    chips.push({ label: ROLE_LABEL[v], removeHref: removeMulti("wcmAuthorRole", v) });
  }
  // Issue #88 — Author chips. Display names come from the hydrated facet
  // bucket list (which always includes active selections, even when
  // their count dropped to 0). Falls back to the bare CWID if a selected
  // author is missing from the result set entirely (e.g. soft-deleted).
  const authorNameByCwid = new Map(result.facets.wcmAuthors.map((a) => [a.cwid, a.displayName]));
  for (const v of wcmAuthor) {
    chips.push({
      label: authorNameByCwid.get(v) ?? v,
      removeHref: removeMulti("wcmAuthor", v),
    });
  }
  for (const v of journal) {
    chips.push({ label: v, removeHref: removeMulti("journal", v) });
  }
  // Issue #837 — Department chips. Label resolved via the dept/div map (falls
  // back to the bare key — e.g. a `name:<dept>` long-tail value — through
  // `deptDivLabel`).
  for (const v of department) {
    chips.push({
      label: deptDivLabel(v, deptLabelMap),
      removeHref: removeMulti("department", v),
    });
  }
  const MENTORING_PROGRAM_LABEL: Record<"md" | "mdphd" | "phd" | "postdoc" | "ecr", string> = {
    md: "MD mentee",
    mdphd: "MD-PhD mentee",
    phd: "PhD mentee",
    postdoc: "Postdoc mentee",
    ecr: "Early career mentee",
  };
  for (const v of mentoringProgram) {
    chips.push({
      label: MENTORING_PROGRAM_LABEL[v],
      removeHref: removeMulti("mentoringProgram", v),
    });
  }

  // Pre-compute journal facet items server-side: the JournalFacet client
  // component can't accept a function prop for toggleHref, so we resolve
  // each row's URL here and pass plain data. Active values are pulled to
  // the head so they survive the Show-all cutoff.
  const journalItems: import("@/components/search/journal-facet").JournalFacetItem[] = (() => {
    const active: typeof result.facets.journals = [];
    const rest: typeof result.facets.journals = [];
    for (const j of result.facets.journals) {
      (journal.includes(j.value) ? active : rest).push(j);
    }
    return [...active, ...rest].map((j) => ({
      value: j.value,
      count: j.count,
      isActive: journal.includes(j.value),
      toggleHref: toggleHref("journal", j.value),
    }));
  })();

  // Issue #88 — same precompute pattern for the Author facet. Buckets
  // already arrive count-desc with active selections appended; we just
  // resolve toggleHref + isActive per row. The client component handles
  // pinning, sort toggle, and typeahead — server only ships data.
  const authorItems: import("@/components/search/author-facet").AuthorFacetItem[] =
    result.facets.wcmAuthors.map((a) => ({
      cwid: a.cwid,
      displayName: a.displayName,
      slug: a.slug,
      count: a.count,
      isActive: wcmAuthor.includes(a.cwid),
      toggleHref: toggleHref("wcmAuthor", a.cwid),
    }));

  // Issue #837 — Department facet items. Resolve each bucket's display label
  // and pull active selections to the head so they survive the collapse
  // cutoff (the same ordering JournalFacet uses). Empty when the flag is off.
  const departmentItems: Array<{
    value: string;
    label: string;
    count: number;
    isActive: boolean;
    href: string;
  }> = (() => {
    const active: typeof result.facets.departments = [];
    const rest: typeof result.facets.departments = [];
    for (const d of result.facets.departments) {
      (department.includes(d.value) ? active : rest).push(d);
    }
    return [...active, ...rest].map((d) => ({
      value: d.value,
      label: deptDivLabel(d.value, deptLabelMap),
      count: d.count,
      isActive: department.includes(d.value),
      href: toggleHref("department", d.value),
    }));
  })();

  // PLAN R2/R3 — the unified scope control + quiet explanation line replace the
  // §638 MeSH boost banner and the §265 interpretation popover. Rendered only
  // when a query→MeSH mapping resolved (`concept`).
  const scopeRow = concept ? (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <ScopeNote scope={scope} query={q} concept={concept} />
      <ScopeControl active={scope} hrefs={scopeHrefs} />
    </div>
  ) : null;

  return (
    <>
      <FacetSidebarPubs
        yearMin={yearMin}
        activePublicationType={publicationType}
        publicationTypes={result.facets.publicationTypes}
        journalItems={journalItems}
        authorItems={authorItems}
        authorTotalDistinct={result.facets.wcmAuthorsTotal}
        wcmAuthorRoleCounts={result.facets.wcmAuthorRoles}
        activeWcmAuthorRole={wcmAuthorRole}
        departmentItems={departmentItems}
        activeMentoringProgram={mentoringProgram}
        mentoringProgramCounts={result.facets.mentoringPrograms}
        toggleHref={toggleHref}
        buildHref={(overrides) =>
          buildUrl((sp) => {
            for (const [k, v] of Object.entries(overrides)) {
              if (v === "") sp.delete(k);
              else sp.set(k, v);
            }
          })
        }
        meshOnlyFilterEnabled={meshOnlyFilterEnabled}
        meshOnly={meshOnly}
        meshOnlyHref={meshOnly ? meshOnlyOffHref : meshOnlyOnHref}
        q={q}
        hasActiveFilters={chips.length > 0}
        clearAllHref={clearAllHref}
      />
      <section>
        {/* #298 §10 / #991 #11 — persistent SR live region. Rendered
            unconditionally (not inside the {conceptFallback ? …} branch below)
            so the broad-text count is written into a region that already exists
            in the DOM and is announced on the result swap. Empty when no
            co-render is shown. */}
        <ConceptFallbackAnnouncement query={q} total={conceptFallback?.total ?? null} />
        {scopeRow}
        {chips.length > 0 ? <ActiveFilterChips chips={chips} clearAllHref={clearAllHref} /> : null}
        <ResultsToolbar
          tab="publications"
          total={result.total}
          page={result.page}
          pageSize={result.pageSize}
          sort={sort}
          hasActiveFilters={chips.length > 0}
          buildSortHref={(value) =>
            buildUrl((sp) => {
              if (value === "relevance") sp.delete("sort");
              else sp.set("sort", value);
            })
          }
          meshOnly={meshOnly}
          meshOnlyRemoveHref={meshOnlyOffHref}
          extraControls={
            <ExportButton
              q={q}
              filters={{
                yearMin,
                yearMax,
                publicationType: publicationType || undefined,
                journal: journal.length > 0 ? journal : undefined,
                wcmAuthorRole: wcmAuthorRole.length > 0 ? wcmAuthorRole : undefined,
                wcmAuthor: wcmAuthor.length > 0 ? wcmAuthor : undefined,
                department: department.length > 0 ? department : undefined,
                // Issue #396 — keep the export in lockstep with the displayed
                // count: when MeSH-only is active the export carries it too, so
                // the exported set equals the "N MeSH-tagged matches" shown.
                meshOnly: meshOnly || undefined,
                mentoringPrograms:
                  mentoringProgram.length > 0 ? mentoringProgram : undefined,
              }}
              sort={sort}
              total={result.total}
            />
          }
        />
        {result.hits.length === 0 ? (
          conceptEmpty ? (
            <ConceptEmptyState
              query={q}
              descriptorName={conceptEmpty.descriptorName}
              broadCount={conceptEmpty.broadCount}
              broadenHref={conceptEmpty.broadenHref}
              // §4.1 — the fallback block's "View all N" replaces the CTA when
              // the zero-trigger co-render renders below.
              omitCta={conceptFallback !== null}
            />
          ) : meshOnly ? (
            // Issue #396 — MeSH-only restriction emptied the set; offer the
            // remove-filter escape (defers to conceptEmpty above, which has its
            // own broaden CTA).
            <MeshOnlyEmptyState removeHref={meshOnlyOffHref} />
          ) : (
            <EmptyState
              query={q}
              tip="Try removing the year filter, or search a different phrase."
            />
          )
        ) : (
          <ul>
            {result.hits.map((h) => (
              <PublicationResultRow key={h.pmid} hit={h} />
            ))}
          </ul>
        )}
        {/* Issue #298 — broad-text co-render (zero or sparse trigger). The
            facet rail + Pagination above stay primary-only (§7); this block is
            an unfilterable discovery preview. */}
        {conceptFallback ? (
          <ConceptFallbackResults
            query={q}
            hits={conceptFallback.hits}
            total={conceptFallback.total}
            viewAllHref={broadenHref}
            cap={CONCEPT_FALLBACK_CAP}
          />
        ) : null}
        <Pagination
          page={result.page}
          total={result.total}
          pageSize={result.pageSize}
          buildHref={(p) =>
            buildUrl(
              (sp) => {
                if (p > 0) sp.set("page", String(p));
                else sp.delete("page");
              },
              { resetPage: false },
            )
          }
        />
      </section>
    </>
  );
}

/* ============================================================
 * Funding tab content — issue #78 Wave D
 *
 * v1 ships sort + paginated result list. Facet sidebar lands in the
 * follow-up commit (FunderFacet with type-ahead + Type + Mechanism +
 * Status + Department + Role).
 * ============================================================ */
type FundingResultData = Awaited<ReturnType<typeof searchFunding>>;

async function FundingResults({
  q,
  page,
  sort,
  filters,
  scope,
  concept,
  scopeHrefs,
  resultPromise,
}: {
  q: string;
  page: number;
  sort: FundingSort;
  filters: FundingFilters;
  scope: Scope;
  concept: ConceptInfo | null;
  scopeHrefs: Record<Scope, string>;
  /** Perf streaming — see PeopleResults.resultPromise. */
  resultPromise: Promise<FundingResultData>;
}) {
  const result = await resultPromise;
  // PLAN R2/R3 — scope control + explanation line (Funding is net-new here).
  const scopeRow = concept ? (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <ScopeNote scope={scope} query={q} concept={concept} />
      <ScopeControl active={scope} hrefs={scopeHrefs} />
    </div>
  ) : null;
  const buildUrl = (
    mut: (sp: URLSearchParams) => void,
    { resetPage = true }: { resetPage?: boolean } = {},
  ) => {
    const sp = new URLSearchParams();
    sp.set("q", q);
    sp.set("type", "funding");
    if (sort !== "relevance") sp.set("sort", sort);
    for (const v of filters.funder ?? []) sp.append("funder", v);
    for (const v of filters.directFunder ?? []) sp.append("directFunder", v);
    for (const v of filters.programType ?? []) sp.append("programType", v);
    for (const v of filters.mechanism ?? []) sp.append("mechanism", v);
    for (const v of filters.status ?? []) sp.append("status", v);
    for (const v of filters.department ?? []) sp.append("department", v);
    for (const v of filters.role ?? []) sp.append("role", v);
    for (const v of filters.investigator ?? []) sp.append("investigator", v);
    if (scope !== "expanded") sp.set("match", scope);
    if (resetPage) sp.delete("page");
    mut(sp);
    return `/search?${sp.toString()}`;
  };

  const toggleHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      if (current.includes(value)) {
        for (const v of current) if (v !== value) sp.append(axis, v);
      } else {
        for (const v of current) sp.append(axis, v);
        sp.append(axis, value);
      }
    });

  const removeHref = (axis: string, value: string) =>
    buildUrl((sp) => {
      const current = sp.getAll(axis);
      sp.delete(axis);
      for (const v of current) if (v !== value) sp.append(axis, v);
    });

  const clearAllParams = new URLSearchParams({ q, type: "funding" });
  if (scope !== "expanded") clearAllParams.set("match", scope);
  const clearAllHref = `/search?${clearAllParams.toString()}`;
  const hasActiveFilters = !!(
    filters.funder?.length ||
    filters.directFunder?.length ||
    filters.programType?.length ||
    filters.mechanism?.length ||
    filters.status?.length ||
    filters.department?.length ||
    filters.role?.length ||
    filters.investigator?.length
  );

  // Issue #80 item 3 — chip strip mirrors the People + Publications tabs.
  // Funder + mechanism chips render in verbose form (full sponsor name,
  // "{code} - {description}") so the chip is self-explanatory without
  // requiring hover.
  const chips: Array<{ label: React.ReactNode; ariaLabel?: string; removeHref: string }> = [];
  for (const v of filters.funder ?? []) {
    chips.push({ label: funderVerbose(v), removeHref: removeHref("funder", v) });
  }
  for (const v of filters.directFunder ?? []) {
    chips.push({
      label: `via ${funderVerbose(v)}`,
      removeHref: removeHref("directFunder", v),
    });
  }
  for (const v of filters.programType ?? []) {
    chips.push({
      label: PROGRAM_TYPE_LABEL[v] ?? v,
      removeHref: removeHref("programType", v),
    });
  }
  for (const v of filters.mechanism ?? []) {
    const desc = mechanismDescriptor(v);
    chips.push({
      label: desc ? (
        <>
          <span>{v}</span>
          <span className="text-muted-foreground"> - {desc}</span>
        </>
      ) : (
        v
      ),
      ariaLabel: mechanismVerbose(v),
      removeHref: removeHref("mechanism", v),
    });
  }
  for (const v of filters.status ?? []) {
    chips.push({ label: STATUS_LABEL[v], removeHref: removeHref("status", v) });
  }
  for (const v of filters.department ?? []) {
    chips.push({ label: v, removeHref: removeHref("department", v) });
  }
  for (const v of filters.role ?? []) {
    chips.push({ label: v, removeHref: removeHref("role", v) });
  }
  // Issue #94 — investigator chips. Names come from the hydrated facet
  // buckets (active selections always surface there even with zero
  // count); fall back to the bare CWID if a scholar was suppressed
  // since the index was built.
  const investigatorNameByCwid = new Map(
    result.facets.investigators.map((b) => [b.cwid, b.displayName]),
  );
  for (const v of filters.investigator ?? []) {
    chips.push({
      label: investigatorNameByCwid.get(v) ?? v,
      removeHref: removeHref("investigator", v),
    });
  }

  // Issue #94 — Investigator facet rail items. Server hydrates display
  // name + slug + avatar; client component handles typeahead, sort
  // toggle, pinning.
  const investigatorItems: import("@/components/search/investigator-facet").InvestigatorFacetItem[] =
    result.facets.investigators.map((a) => ({
      cwid: a.cwid,
      displayName: a.displayName,
      slug: a.slug,
      identityImageEndpoint: a.identityImageEndpoint,
      count: a.count,
      isActive: (filters.investigator ?? []).includes(a.cwid),
      toggleHref: toggleHref("investigator", a.cwid),
    }));

  return (
    <>
      <FacetSidebarFunding
        facets={result.facets}
        active={filters}
        toggleHref={toggleHref}
        clearAllHref={clearAllHref}
        hasActiveFilters={hasActiveFilters}
        investigatorItems={investigatorItems}
        investigatorTotalDistinct={result.facets.investigatorsTotal}
      />
      <section className="min-w-0">
        {scopeRow}
        {chips.length > 0 ? <ActiveFilterChips chips={chips} clearAllHref={clearAllHref} /> : null}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground">
            {result.total === 0
              ? "No results"
              : `Showing ${result.page * result.pageSize + 1}–${Math.min(
                  (result.page + 1) * result.pageSize,
                  result.total,
                )} of ${result.total.toLocaleString()}`}
          </span>
          <div className="flex items-center gap-2 text-[13px] text-[#5a5a5a]">
            <span>Sort:</span>
            <FundingSortLinks q={q} filters={filters} sort={sort} scope={scope} />
          </div>
        </div>
        {result.hits.length === 0 ? (
          <EmptyState query={q} tip="Try broadening the query or removing facet filters." />
        ) : (
          <FundingResultsList
            hits={result.hits}
            q={q}
            page={page}
            pageSize={result.pageSize}
            total={result.total}
            filters={filters}
            conceptLabel={concept?.label ?? null}
          />
        )}
        <Pagination
          page={result.page}
          total={result.total}
          pageSize={result.pageSize}
          buildHref={(p) =>
            buildUrl(
              (sp) => {
                if (p > 0) sp.set("page", String(p));
                else sp.delete("page");
              },
              { resetPage: false },
            )
          }
        />
      </section>
    </>
  );
}

/** Maps F3 status enum to user-facing labels. */
const STATUS_LABEL: Record<FundingStatus, string> = {
  active: "Active",
  ending_soon: "Ending in 12 months",
  recently_ended: "Recently ended (last 2 years)",
};

/** Compact labels for the Type checkbox list (mirrors the inline pill
 *  treatment on result rows). */
const PROGRAM_TYPE_LABEL: Record<string, string> = {
  Grant: "Grant",
  "Contract with funding": "Contract",
  Fellowship: "Fellowship",
  Career: "Career",
  Training: "Training",
  "BioPharma Alliance Agreement": "BioPharma Alliance",
  Equipment: "Equipment",
};

function FacetSidebarFunding({
  facets,
  active,
  toggleHref,
  clearAllHref,
  hasActiveFilters,
  investigatorItems,
  investigatorTotalDistinct,
}: {
  facets: FundingResultData["facets"];
  active: FundingFilters;
  toggleHref: (axis: string, value: string) => string;
  clearAllHref: string;
  hasActiveFilters: boolean;
  investigatorItems: import("@/components/search/investigator-facet").InvestigatorFacetItem[];
  investigatorTotalDistinct: number;
}) {
  const statusItems: Array<{ key: FundingStatus; count: number }> = [
    { key: "active", count: facets.status.active },
    { key: "ending_soon", count: facets.status.endingSoon },
    { key: "recently_ended", count: facets.status.recentlyEnded },
  ];
  const roleItems: Array<{ key: FundingRoleBucket; count: number }> = [
    { key: "PI", count: facets.roles.pi },
    { key: "Multi-PI", count: facets.roles.multiPi },
    { key: "Co-I", count: facets.roles.coI },
  ];
  const activeFunder = active.funder ?? [];
  const activeDirectFunder = active.directFunder ?? [];
  const activeProgramType = active.programType ?? [];
  const activeMechanism = active.mechanism ?? [];
  const activeStatus = active.status ?? [];
  const activeDepartment = active.department ?? [];
  const activeRole = active.role ?? [];

  return (
    <aside className="text-[13px]">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Filters
        </span>
        {hasActiveFilters ? (
          <Link
            href={clearAllHref}
            scroll={false}
            className="text-xs font-medium text-[#2c4f6e] hover:underline"
          >
            Clear all
          </Link>
        ) : null}
      </div>

      <FacetGroup label="Status">
        {sortActiveFirst(statusItems, (s) => activeStatus.includes(s.key)).map((s) => (
          <FacetCheckbox
            key={s.key}
            label={STATUS_LABEL[s.key]}
            count={s.count}
            isActive={activeStatus.includes(s.key)}
            href={toggleHref("status", s.key)}
          />
        ))}
      </FacetGroup>

      {/* Issue #94 — Investigator facet. Highest-signal people axis on the
          Funding tab (department admins and reviewers commonly start a
          search with a known PI), so it sits at the top of the rail
          right after Status. */}
      {investigatorItems.length > 0 ? (
        <InvestigatorFacet items={investigatorItems} totalDistinct={investigatorTotalDistinct} />
      ) : null}

      {facets.funders.length > 0 || facets.directFunders.length > 0 ? (
        <FunderFacet
          items={sortActiveFirst(facets.funders, (f) => activeFunder.includes(f.value)).map(
            (f) => ({
              value: f.value,
              short: f.label,
              full: expandSponsor(f.value),
              aliases: collectAliases(f.value),
              count: f.count,
              isActive: activeFunder.includes(f.value),
              href: toggleHref("funder", f.value),
            }),
          )}
          directItems={facets.directFunders.map((f) => ({
            value: f.value,
            short: f.label,
            full: expandSponsor(f.value),
            aliases: collectAliases(f.value),
            count: f.count,
            isActive: activeDirectFunder.includes(f.value),
            href: toggleHref("directFunder", f.value),
          }))}
        />
      ) : null}

      {facets.programTypes.length > 0 ? (
        <FacetGroup label="Type" collapseAfter={6}>
          {sortActiveFirst(facets.programTypes, (p) => activeProgramType.includes(p.value)).map(
            (p) => (
              <FacetCheckbox
                key={p.value}
                label={PROGRAM_TYPE_LABEL[p.value] ?? p.value}
                count={p.count}
                isActive={activeProgramType.includes(p.value)}
                href={toggleHref("programType", p.value)}
              />
            ),
          )}
        </FacetGroup>
      ) : null}

      {facets.mechanisms.length > 0 ? (
        <FacetGroup label="Mechanism (NIH)" collapseAfter={6}>
          {sortActiveFirst(facets.mechanisms, (m) => activeMechanism.includes(m.value)).map((m) => {
            const desc = mechanismDescriptor(m.value);
            return (
              <FacetCheckbox
                key={m.value}
                label={
                  desc ? (
                    <>
                      <span>{m.value}</span>
                      <span className="text-muted-foreground"> - {desc}</span>
                    </>
                  ) : (
                    m.value
                  )
                }
                count={m.count}
                isActive={activeMechanism.includes(m.value)}
                href={toggleHref("mechanism", m.value)}
                wrap
              />
            );
          })}
        </FacetGroup>
      ) : null}

      {facets.departments.length > 0 ? (
        // #837 — label matches the Scholars-tab org-unit facet for UI
        // consistency. Deliberate consistency choice, NOT a data-accurate
        // description: these buckets key on `wcmAuthorDepartments`, which is
        // department-only (unlike the Scholars tab's `deptDivKey`, which also
        // folds in divisions + centers). Keep the labels identical anyway.
        <FacetGroup label="Department / division / center" collapseAfter={6}>
          {sortActiveFirst(facets.departments, (d) => activeDepartment.includes(d.value)).map(
            (d) => (
              <FacetCheckbox
                key={d.value}
                label={d.value}
                count={d.count}
                isActive={activeDepartment.includes(d.value)}
                href={toggleHref("department", d.value)}
                wrap
              />
            ),
          )}
        </FacetGroup>
      ) : null}

      <FacetGroup label="Role">
        {sortActiveFirst(roleItems, (r) => activeRole.includes(r.key)).map((r) => (
          <FacetCheckbox
            key={r.key}
            label={r.key}
            count={r.count}
            isActive={activeRole.includes(r.key)}
            href={toggleHref("role", r.key)}
          />
        ))}
      </FacetGroup>
    </aside>
  );
}

function FundingSortLinks({
  q,
  filters,
  sort,
  scope,
}: {
  q: string;
  filters: FundingFilters;
  sort: FundingSort;
  scope: Scope;
}) {
  const opts: Array<{ value: FundingSort; label: string }> = [
    { value: "relevance", label: "Relevance" },
    { value: "endDate", label: "End date (soonest)" },
    { value: "startDate", label: "Start date (newest)" },
    { value: "pubCount", label: "Most publications" },
  ];
  const buildHref = (s: FundingSort) => {
    const sp = new URLSearchParams();
    sp.set("q", q);
    sp.set("type", "funding");
    if (s !== "relevance") sp.set("sort", s);
    for (const v of filters.funder ?? []) sp.append("funder", v);
    for (const v of filters.directFunder ?? []) sp.append("directFunder", v);
    for (const v of filters.programType ?? []) sp.append("programType", v);
    for (const v of filters.mechanism ?? []) sp.append("mechanism", v);
    for (const v of filters.status ?? []) sp.append("status", v);
    for (const v of filters.department ?? []) sp.append("department", v);
    for (const v of filters.role ?? []) sp.append("role", v);
    for (const v of filters.investigator ?? []) sp.append("investigator", v);
    if (scope !== "expanded") sp.set("match", scope);
    return `/search?${sp.toString()}`;
  };
  return (
    <div className="inline-flex items-center gap-2">
      {opts.map((opt, i) => (
        <span key={opt.value}>
          {i > 0 ? <span className="text-muted-foreground"> · </span> : null}
          <Link
            href={buildHref(opt.value)}
            scroll={false}
            className={
              sort === opt.value
                ? "font-semibold text-[#1a1a1a]"
                : "text-[#5a5a5a] hover:text-[#1a1a1a]"
            }
          >
            {opt.label}
          </Link>
        </span>
      ))}
    </div>
  );
}

/* ============================================================
 * Active filter chips — one chip per selected value
 * ============================================================ */
function ActiveFilterChips({
  chips,
  clearAllHref,
}: {
  chips: Array<{ label: React.ReactNode; ariaLabel?: string; removeHref: string }>;
  clearAllHref: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((c, i) => {
        const aria = c.ariaLabel ?? (typeof c.label === "string" ? c.label : "filter");
        return (
          <Link
            key={`${aria}-${c.removeHref}-${i}`}
            href={c.removeHref}
            scroll={false}
            aria-label={`Remove filter: ${aria}`}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-[#c5d3df] bg-[#eaf0f5] py-0 pr-1.5 pl-3 text-xs font-medium text-[#2c4f6e] no-underline transition-colors hover:border-[#9fb6c9] hover:bg-[#dde7f0] hover:no-underline"
          >
            <span>{c.label}</span>
            <span
              aria-hidden="true"
              className="ml-0.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[14px] leading-none text-[#2c4f6e] hover:bg-[#2c4f6e]/15"
            >
              ×
            </span>
          </Link>
        );
      })}
      <Link
        href={clearAllHref}
        scroll={false}
        className="ml-1 text-xs text-muted-foreground hover:text-[#2c4f6e]"
      >
        Clear all
      </Link>
    </div>
  );
}

/* ============================================================
 * Results toolbar — left: count line; right: sort dropdown
 * ============================================================ */
function ResultsToolbar({
  tab,
  total,
  page,
  pageSize,
  sort,
  buildSortHref,
  hasActiveFilters,
  meshOnly = false,
  meshOnlyRemoveHref,
  extraControls,
}: {
  tab: "people" | "publications";
  total: number;
  page: number;
  pageSize: number;
  sort: PeopleSort | PublicationsSort;
  buildSortHref: (value: string) => string;
  hasActiveFilters: boolean;
  /** Issue #396 — pub-tab "Show only MeSH-tagged matches" active. When true and
   *  total>0 the count line reads "Showing N MeSH-tagged matches." + a
   *  "Remove filter" link (no fractional "N of M" denominator). */
  meshOnly?: boolean;
  /** Issue #396 — href that drops `searchMode` (the "Remove filter" target). */
  meshOnlyRemoveHref?: string;
  /** Optional trailing controls rendered before the Sort group (#89 — Export). */
  extraControls?: React.ReactNode;
}) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  // "matching filters" only when at least one facet is active. Without
  // filters, the qualifier reads like the count is filtered when it isn't.
  const noun =
    tab === "people"
      ? `${total === 1 ? "scholar" : "scholars"}${hasActiveFilters ? " matching filters" : ""}`
      : "publications";

  const peopleOpts: Array<{ value: PeopleSort; label: string }> = [
    { value: "relevance", label: "Relevance" },
    { value: "lastname", label: "Last name (A–Z)" },
    { value: "recentPub", label: "Most recent publication" },
  ];
  // Issue #259 §1.8 — pub-tab sort options swap under the §1.8 flag:
  // Relevance / Impact / Recency replaces Relevance / Year / Citations.
  // Flag check is server-side (this is a Server Component); the legacy
  // values still resolve correctly in `searchPublications` so old URLs
  // don't 500 mid-deploy. Default-off mirrors the §1.6 rollout pattern.
  const pubImpactOn = (process.env.SEARCH_PUB_TAB_IMPACT ?? "off") === "on";
  const pubOpts: Array<{ value: PublicationsSort; label: string }> = pubImpactOn
    ? [
        { value: "relevance", label: "Relevance" },
        { value: "impact", label: "Impact" },
        { value: "recency", label: "Recency" },
      ]
    : [
        { value: "relevance", label: "Relevance" },
        { value: "year", label: "Year (newest)" },
        { value: "citations", label: "Citation count" },
      ];
  const opts = tab === "people" ? peopleOpts : pubOpts;
  // Pre-compute hrefs server-side so the SortLinks client component
  // receives only serializable string props (no function across the
  // server→client boundary).
  const optsWithHref = opts.map((o) => ({
    value: o.value,
    label: o.label,
    href: buildSortHref(o.value),
  }));

  // Issue #285 — single page-level disclosure pointing at the methodology
  // anchor explaining the 0–100 impact score. Pub-tab only, gated on the
  // same §1.8 flag that surfaces the inline score so the link doesn't
  // promise an explanation for a number that isn't being shown.
  const showAboutImpact = tab === "publications" && pubImpactOn && total > 0;

  return (
    <div className="mb-2 flex items-center border-b border-[#e3e2dd] pb-3 text-[13px] text-muted-foreground">
      {total > 0 ? (
        meshOnly ? (
          // Issue #396 — MeSH-only count line. No fractional "N of M"
          // denominator (the set IS the mesh-tagged subset), plus a
          // "Remove filter" escape styled like the "About impact" link below.
          <span>
            Showing{" "}
            <strong className="font-semibold text-[#4a4a4a]">{total.toLocaleString()}</strong>{" "}
            MeSH-tagged matches.
            {meshOnlyRemoveHref ? (
              <>
                {" "}
                <span aria-hidden="true" className="text-muted-foreground/60">
                  ·
                </span>{" "}
                <Link
                  href={meshOnlyRemoveHref}
                  scroll={false}
                  className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
                >
                  Remove filter
                </Link>
              </>
            ) : null}
          </span>
        ) : (
          <span>
            Showing {start}–{end} of{" "}
            <strong className="font-semibold text-[#4a4a4a]">{total.toLocaleString()}</strong> {noun}
            {showAboutImpact ? (
              <>
                {" "}
                <span aria-hidden="true" className="text-muted-foreground/60">
                  ·
                </span>{" "}
                <Link
                  href={methodologyHref("impact")}
                  className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
                >
                  About impact
                </Link>
              </>
            ) : null}
          </span>
        )
      ) : null}
      <span className="ml-auto inline-flex items-center gap-3 text-[#4a4a4a]">
        {extraControls}
        <span className="inline-flex items-center gap-2">
          Sort:
          <SortLinks current={sort} options={optsWithHref} />
        </span>
      </span>
    </div>
  );
}

/* ============================================================
 * Sidebar — checkbox-style facet lists
 * ============================================================ */
function FacetSidebar({
  deptDivs,
  personTypes,
  activity,
  piFacets,
  activeDeptDiv,
  activePersonType,
  activeActivity,
  activePi,
  activePiMin,
  toggleHref,
  setPiHref,
  setPiMinHref,
  clearAllHref,
  hasActiveFilters,
}: {
  deptDivs: DeptDivBucket[];
  personTypes: SearchFacetBucket[];
  activity: { hasGrants: number; recentPub: number };
  piFacets: { none: number; any: number; active: number; multi: number };
  activeDeptDiv: string[];
  activePersonType: string[];
  activeActivity: ActivityFilter[];
  activePi: PiFilter | undefined;
  activePiMin: number;
  toggleHref: (axis: string, value: string) => string;
  setPiHref: (next: PiFilter | null) => string;
  setPiMinHref: (next: number) => string;
  clearAllHref: string;
  hasActiveFilters: boolean;
}) {
  // Issue #233 — `pi=active|multi` is a strict subset of `hasActiveGrants:true`,
  // so the Activity checkbox is presentational-only disabled with a tooltip
  // to prevent dead-click confusion. URL contract still accepts both.
  const piImpliesActive = activePi === "active" || activePi === "multi";
  return (
    <aside className="text-[13px]">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Filters
        </span>
        {hasActiveFilters ? (
          <Link
            href={clearAllHref}
            scroll={false}
            className="text-xs font-medium text-[#2c4f6e] hover:underline"
          >
            Clear all
          </Link>
        ) : null}
      </div>

      {personTypes.length > 0 ? (
        <FacetGroup label="Scholar type" collapseAfter={5}>
          {sortActiveFirst(personTypes, (p) => activePersonType.includes(p.value)).map((p) => (
            <FacetCheckbox
              key={p.value}
              label={formatRoleCategory(p.value) ?? p.value}
              count={p.count}
              isActive={activePersonType.includes(p.value)}
              href={toggleHref("personType", p.value)}
            />
          ))}
        </FacetGroup>
      ) : null}

      {deptDivs.length > 0 ? (
        <FacetGroup label="Department / division / center" collapseAfter={5}>
          {sortActiveFirst(deptDivs, (d) => activeDeptDiv.includes(d.value)).map((d) => (
            <FacetCheckbox
              key={d.value}
              label={d.label}
              count={d.count}
              isActive={activeDeptDiv.includes(d.value)}
              href={toggleHref("deptDiv", d.value)}
              wrap
            />
          ))}
        </FacetGroup>
      ) : null}

      <FacetGroup label="Activity">
        <FacetCheckbox
          label="Has active grants"
          count={activity.hasGrants}
          isActive={activeActivity.includes("has_grants") || piImpliesActive}
          href={toggleHref("activity", "has_grants")}
          disabled={piImpliesActive}
          tooltip={piImpliesActive ? "Implied by current PI filter." : undefined}
        />
        <FacetCheckbox
          label="Published in last 2 years"
          count={activity.recentPub}
          isActive={activeActivity.includes("recent_pub")}
          href={toggleHref("activity", "recent_pub")}
        />
      </FacetGroup>

      {/* Issue #233 — Principal Investigator facet. Single-select radio
          immediately after Activity; numeric stepper renders only when
          "Multi-grant PI" is selected. */}
      <FacetGroup label="Principal Investigator">
        <FacetCheckbox
          radio
          label="No filter"
          count={piFacets.none}
          isActive={activePi === undefined}
          href={setPiHref(null)}
        />
        <FacetCheckbox
          radio
          label="Any PI role, ever"
          count={piFacets.any}
          isActive={activePi === "any"}
          href={setPiHref("any")}
        />
        <FacetCheckbox
          radio
          label="Active PI"
          count={piFacets.active}
          isActive={activePi === "active"}
          href={setPiHref("active")}
        />
        <FacetCheckbox
          radio
          label="Multi-grant PI"
          count={piFacets.multi}
          isActive={activePi === "multi"}
          href={setPiHref("multi")}
        />
        {activePi === "multi" ? (
          <PiMinStepper
            value={activePiMin}
            min={PI_MIN_FLOOR}
            max={PI_MIN_CEILING}
            setMinHref={setPiMinHref}
          />
        ) : null}
      </FacetGroup>
    </aside>
  );
}

/**
 * Issue #233 — numeric stepper for `pi=multi&pi_min=N`. State lives in the
 * URL; −/+ render as `<Link>` so the whole page is still server-rendered
 * with no client JS. Boundary buttons render as visually-muted spans.
 */
function PiMinStepper({
  value,
  min,
  max,
  setMinHref,
}: {
  value: number;
  min: number;
  max: number;
  setMinHref: (next: number) => string;
}) {
  const decDisabled = value <= min;
  const incDisabled = value >= max;
  const buttonBase =
    "inline-flex h-6 w-6 items-center justify-center rounded border border-[#d6d6d6] text-[14px] leading-none";
  const buttonActive = "bg-white text-[#1a1a1a] hover:border-[#2c4f6e]";
  const buttonMuted = "bg-[#f4f4f4] text-[#bdbdbd] cursor-default";
  return (
    <li className="mt-1 ml-6 flex items-center gap-2 py-1 leading-[1.4]">
      <span className="text-[12.5px] text-[#5a5a5a]">Min active grants:</span>
      {decDisabled ? (
        <span className={`${buttonBase} ${buttonMuted}`} aria-disabled="true">
          −
        </span>
      ) : (
        <Link
          href={setMinHref(value - 1)}
          scroll={false}
          aria-label={`Decrease minimum to ${value - 1}`}
          className={`${buttonBase} ${buttonActive} no-underline`}
        >
          −
        </Link>
      )}
      <span className="min-w-[1.5em] text-center text-[13px] tabular-nums">{value}</span>
      {incDisabled ? (
        <span className={`${buttonBase} ${buttonMuted}`} aria-disabled="true">
          +
        </span>
      ) : (
        <Link
          href={setMinHref(value + 1)}
          scroll={false}
          aria-label={`Increase minimum to ${value + 1}`}
          className={`${buttonBase} ${buttonActive} no-underline`}
        >
          +
        </Link>
      )}
    </li>
  );
}

function FacetSidebarPubs({
  yearMin,
  activePublicationType,
  publicationTypes,
  journalItems,
  authorItems,
  authorTotalDistinct,
  wcmAuthorRoleCounts,
  activeWcmAuthorRole,
  departmentItems,
  activeMentoringProgram,
  mentoringProgramCounts,
  toggleHref,
  buildHref,
  meshOnlyFilterEnabled,
  meshOnly,
  meshOnlyHref,
  q,
  hasActiveFilters,
  clearAllHref,
}: {
  yearMin?: number;
  activePublicationType?: string;
  publicationTypes: SearchFacetBucket[];
  journalItems: import("@/components/search/journal-facet").JournalFacetItem[];
  authorItems: import("@/components/search/author-facet").AuthorFacetItem[];
  authorTotalDistinct: number;
  wcmAuthorRoleCounts: { first: number; senior: number; middle: number };
  activeWcmAuthorRole: Array<"first" | "senior" | "middle">;
  /** Issue #837 — Department facet rows (label-resolved, active-first,
   *  count-desc). Empty when `SEARCH_PUB_DEPARTMENT_FILTER` is off, so the
   *  group renders nothing. */
  departmentItems: Array<{
    value: string;
    label: string;
    count: number;
    isActive: boolean;
    href: string;
  }>;
  activeMentoringProgram: Array<"md" | "mdphd" | "phd" | "postdoc" | "ecr">;
  mentoringProgramCounts: Record<"md" | "mdphd" | "phd" | "postdoc" | "ecr", number>;
  toggleHref: (axis: string, value: string) => string;
  buildHref: (overrides: Record<string, string>) => string;
  /** Issue #396 — whether the "Show only MeSH-tagged matches" toggle renders
   *  (the `SEARCH_PUB_MESH_ONLY_FILTER` flag). */
  meshOnlyFilterEnabled: boolean;
  /** Issue #396 — current MeSH-only active state. */
  meshOnly: boolean;
  /** Issue #396 — toggle target href: the ON url when off, the OFF url when on. */
  meshOnlyHref: string;
  /** Query string, forwarded to the MeSH-only toggle's turn-ON telemetry beacon. */
  q: string;
  hasActiveFilters: boolean;
  clearAllHref: string;
}) {
  const yearChoices = [2024, 2020, 2015, 2010];
  return (
    <aside className="text-[13px]">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Filters
        </span>
        {hasActiveFilters ? (
          <Link
            href={clearAllHref}
            scroll={false}
            className="text-xs font-medium text-[#2c4f6e] hover:underline"
          >
            Clear all
          </Link>
        ) : null}
      </div>

      {/* Issue #396 — "Show only MeSH-tagged matches" toggle. Rendered only
          when the flag is on; styled like the other facet groups (single
          checkbox-style row). A client component so it can fire the
          `search_mesh_restrict` beacon on turn-ON without blocking nav. */}
      {meshOnlyFilterEnabled ? (
        <FacetGroup label="Match quality">
          <MeshOnlyToggle href={meshOnlyHref} isActive={meshOnly} q={q} />
        </FacetGroup>
      ) : null}

      {/* WCM author role first — it's the highest-signal pub filter
          for promotion/recruiting use cases. */}
      <FacetGroup label="WCM author role">
        <FacetCheckbox
          label="First author"
          count={wcmAuthorRoleCounts.first}
          isActive={activeWcmAuthorRole.includes("first")}
          href={toggleHref("wcmAuthorRole", "first")}
        />
        <FacetCheckbox
          label="Senior author"
          count={wcmAuthorRoleCounts.senior}
          isActive={activeWcmAuthorRole.includes("senior")}
          href={toggleHref("wcmAuthorRole", "senior")}
        />
        <FacetCheckbox
          label="Middle author"
          count={wcmAuthorRoleCounts.middle}
          isActive={activeWcmAuthorRole.includes("middle")}
          href={toggleHref("wcmAuthorRole", "middle")}
        />
      </FacetGroup>

      {/* Issue #88 — Author facet sits between WCM author role and Year
          per spec: the two authorship axes are conceptually paired and
          users combine them ("first-author papers by Wolf"). */}
      {authorItems.length > 0 ? (
        <AuthorFacet items={authorItems} totalDistinct={authorTotalDistinct} />
      ) : null}

      {/* Issue #837 — Department facet (WCM-author department). Renders only
          when the flag is on AND the result set has departments (or an active
          selection); empty `departmentItems` ⇒ no group. Collapses past 6
          like the People-tab dept facet. */}
      {departmentItems.length > 0 ? (
        <FacetGroup label="Department / division / center" collapseAfter={6}>
          {departmentItems.map((d) => (
            <FacetCheckbox
              key={d.value}
              label={d.label}
              count={d.count}
              isActive={d.isActive}
              href={d.href}
              wrap
            />
          ))}
        </FacetGroup>
      ) : null}

      <FacetGroup label="Year (since)">
        {yearChoices.map((y) => (
          <FacetCheckbox
            key={y}
            label={`${y}–present`}
            isActive={yearMin === y}
            href={buildHref({ yearMin: yearMin === y ? "" : String(y) })}
            radio
          />
        ))}
      </FacetGroup>

      {publicationTypes.length > 0 ? (
        <FacetGroup label="Publication type" collapseAfter={5}>
          {publicationTypes.map((p) => (
            <FacetCheckbox
              key={p.value}
              label={displayPublicationType(p.value)}
              count={p.count}
              isActive={p.value === activePublicationType}
              href={buildHref({
                publicationType: p.value === activePublicationType ? "" : p.value,
              })}
            />
          ))}
        </FacetGroup>
      ) : null}

      {journalItems.length > 0 ? <JournalFacet items={journalItems} /> : null}

      {/* Mentoring activity — multi-select on mentee program at time of
          mentorship. Restricts results to publications co-authored between a
          known WCM mentor and a mentee in the chosen program(s). Placed
          below Journals per issue #226. */}
      <FacetGroup label="Mentoring activity">
        <FacetCheckbox
          label="MD mentee"
          count={mentoringProgramCounts.md}
          isActive={activeMentoringProgram.includes("md")}
          href={toggleHref("mentoringProgram", "md")}
        />
        <FacetCheckbox
          label="MD-PhD mentee"
          count={mentoringProgramCounts.mdphd}
          isActive={activeMentoringProgram.includes("mdphd")}
          href={toggleHref("mentoringProgram", "mdphd")}
        />
        <FacetCheckbox
          label="PhD mentee"
          count={mentoringProgramCounts.phd}
          isActive={activeMentoringProgram.includes("phd")}
          href={toggleHref("mentoringProgram", "phd")}
        />
        <FacetCheckbox
          label="Postdoc mentee"
          count={mentoringProgramCounts.postdoc}
          isActive={activeMentoringProgram.includes("postdoc")}
          href={toggleHref("mentoringProgram", "postdoc")}
        />
        <FacetCheckbox
          label="Early career mentee"
          count={mentoringProgramCounts.ecr}
          isActive={activeMentoringProgram.includes("ecr")}
          href={toggleHref("mentoringProgram", "ecr")}
        />
      </FacetGroup>
    </aside>
  );
}

/**
 * Sidebar facet group. When `collapseAfter` is set and the group has more
 * than that many items, the tail is hidden inside a native <details> with
 * a "Show all N" toggle. We split children into a head and tail server-
 * side so the cap is consistent regardless of viewport width.
 *
 * Two practical notes:
 *   - The toggle uses native <details>, no client JS, so it stays open
 *     on the same render. Navigation away (clicking a checkbox) collapses
 *     it — but the caller is expected to sort buckets so currently-active
 *     values appear in the head, so the user never has to re-expand to
 *     see what they ticked.
 *   - The summary marker is suppressed in favor of a Lucide chevron for
 *     visual consistency with the rest of the page.
 */
function FacetGroup({
  label,
  children,
  collapseAfter,
}: {
  label: string;
  children: React.ReactNode;
  collapseAfter?: number;
}) {
  const items = React.Children.toArray(children);
  const shouldCollapse = collapseAfter !== undefined && items.length > collapseAfter;
  const head = shouldCollapse ? items.slice(0, collapseAfter!) : items;
  const tail = shouldCollapse ? items.slice(collapseAfter!) : [];
  return (
    <div className="mb-5">
      <h2 className="mb-2 text-[13px] font-semibold text-[#1a1a1a]">{label}</h2>
      <ul className="m-0 flex list-none flex-col p-0">{head}</ul>
      {tail.length > 0 ? (
        // Tailwind 4 lacks `group-open:` directly; arbitrary descendant
        // variants (`[&[open]_.x]:hidden`) compile to
        // `details[open] .x { display: none }` and let the open/closed
        // labels swap without any client JS.
        <details className="mt-1 [&:not([open])_.fg-hide]:hidden [&[open]_.fg-chevron]:rotate-180 [&[open]_.fg-show]:hidden">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12.5px] font-medium text-[#2c4f6e] hover:underline [&::-webkit-details-marker]:hidden">
            <ChevronDown
              aria-hidden
              className="fg-chevron h-3.5 w-3.5 transition-transform"
              strokeWidth={2}
            />
            <span className="fg-show">Show all {items.length}</span>
            <span className="fg-hide">Show fewer</span>
          </summary>
          <ul className="m-0 mt-1 flex list-none flex-col p-0">{tail}</ul>
        </details>
      ) : null}
    </div>
  );
}

function FacetCheckbox({
  label,
  /** Optional expansion shown in a styled hover/focus tooltip wrapping the
   *  whole row. Mirrors the author-chip-row treatment so a user hovering a
   *  mechanism code or NIH-IC facet sees the long form without overlapping
   *  with the row's click target. */
  tooltip,
  count,
  isActive,
  href,
  wrap,
  radio,
  disabled,
}: {
  label: React.ReactNode;
  tooltip?: string;
  count?: number;
  isActive?: boolean;
  href: string;
  /** When true, allow the label to wrap to multiple lines (matches the
   *  Journal facet treatment) and pin the input + count to the first
   *  line via items-start. Default behavior truncates with ellipsis. */
  wrap?: boolean;
  /** When true, render the input as a single-select radio rather than a
   *  multi-select checkbox. Used by mutually-exclusive facets like the
   *  year-since range. Toggling the active option still clears it. */
  radio?: boolean;
  /** When true, render the row as visually disabled (muted text, no link).
   *  Presentational only — caller is responsible for any URL-level
   *  enforcement. Used by issue #233 to suppress the redundant `Has active
   *  grants` checkbox when `pi=active|multi` is set. */
  disabled?: boolean;
}) {
  const inputType = radio ? "radio" : "checkbox";
  if (disabled) {
    return (
      <li className="flex items-center gap-2 py-1 leading-[1.4] opacity-50">
        {(() => {
          const row = (
            <span
              className="flex flex-1 items-center gap-2 text-[#1a1a1a]"
              aria-disabled="true"
              title={typeof label === "string" ? label : undefined}
            >
              <input
                type={inputType}
                readOnly
                disabled
                checked={!!isActive}
                tabIndex={-1}
                aria-hidden="true"
                className="cursor-not-allowed accent-[#2c4f6e]"
              />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {count !== undefined ? (
                <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                  {count.toLocaleString()}
                </span>
              ) : null}
            </span>
          );
          return tooltip ? <HoverTooltip text={tooltip}>{row}</HoverTooltip> : row;
        })()}
      </li>
    );
  }
  const fallbackTitle = tooltip ?? (typeof label === "string" ? label : undefined);
  const wrapInTooltip = (children: React.ReactNode) =>
    tooltip ? <HoverTooltip text={tooltip}>{children}</HoverTooltip> : children;
  if (wrap) {
    return (
      <li className="py-1 leading-[1.4]">
        {wrapInTooltip(
          <Link
            href={href}
            scroll={false}
            title={tooltip ? undefined : fallbackTitle}
            className="flex items-start gap-2 text-[#1a1a1a] no-underline hover:no-underline"
          >
            <input
              type={inputType}
              readOnly
              checked={!!isActive}
              tabIndex={-1}
              aria-hidden="true"
              className="mt-[3px] cursor-pointer accent-[#2c4f6e]"
            />
            <span className="min-w-0 flex-1 break-words">{label}</span>
            {count !== undefined ? (
              <span className="mt-[1px] shrink-0 text-[12px] text-muted-foreground tabular-nums">
                {count.toLocaleString()}
              </span>
            ) : null}
          </Link>,
        )}
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 py-1 leading-[1.4]">
      {wrapInTooltip(
        <Link
          href={href}
          scroll={false}
          title={tooltip ? undefined : fallbackTitle}
          className="flex flex-1 items-center gap-2 text-[#1a1a1a] no-underline hover:no-underline"
        >
          {/* readOnly input: state lives in the URL; the link toggles it. */}
          <input
            type={inputType}
            readOnly
            checked={!!isActive}
            tabIndex={-1}
            aria-hidden="true"
            className="cursor-pointer accent-[#2c4f6e]"
          />
          {/* Truncate keeps the count column straight when names are short
            and predictable. The title attribute surfaces the full label
            on hover for the rare overflow. */}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count !== undefined ? (
            <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
              {count.toLocaleString()}
            </span>
          ) : null}
        </Link>,
      )}
    </li>
  );
}

/* ============================================================
 * Empty state + Pagination (with ellipsis)
 * ============================================================ */
function EmptyState({ query, tip }: { query: string; tip: string }) {
  return (
    <div className="mt-12 flex flex-col items-center text-center">
      <div className="text-lg font-medium">No results{query ? ` for "${query}"` : ""}</div>
      <div className="mt-1 text-sm text-muted-foreground">{tip}</div>
    </div>
  );
}

/**
 * Issue #396 — empty state when the "Show only MeSH-tagged matches" filter
 * leaves zero hits. Mirrors `EmptyState`'s centered markup, swapping the tip
 * for a "Remove filter" link that drops `searchMode` so the user lands back on
 * the full (unrestricted) result set for the same query.
 */
function MeshOnlyEmptyState({ removeHref }: { removeHref: string }) {
  return (
    <div className="mt-12 flex flex-col items-center text-center">
      <div className="text-lg font-medium">No MeSH-tagged matches for this query.</div>
      <div className="mt-1 text-sm text-muted-foreground">
        <Link
          href={removeHref}
          scroll={false}
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
        >
          Remove filter
        </Link>
      </div>
    </div>
  );
}

function Pagination({
  page,
  total,
  pageSize,
  buildHref,
}: {
  page: number;
  total: number;
  pageSize: number;
  buildHref: (p: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  // Always include first + last; ellipsis when the window doesn't reach them.
  const window = new Set<number>();
  window.add(0);
  window.add(totalPages - 1);
  for (let p = page - 1; p <= page + 1; p++) {
    if (p >= 0 && p < totalPages) window.add(p);
  }
  // Fill so the first 5 pages (or last 5) render densely without ellipsis.
  for (let p = 0; p < Math.min(5, totalPages); p++) window.add(p);
  for (let p = Math.max(0, totalPages - 5); p < totalPages; p++) window.add(p);

  const sorted = [...window].sort((a, b) => a - b);

  type Cell = { kind: "page"; n: number } | { kind: "ellipsis"; key: string };
  const cells: Cell[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] !== sorted[i - 1] + 1) {
      cells.push({ kind: "ellipsis", key: `e-${sorted[i - 1]}-${sorted[i]}` });
    }
    cells.push({ kind: "page", n: sorted[i] });
  }

  return (
    <nav className="mt-8 flex items-center justify-center gap-1 pt-6" aria-label="Pagination">
      <PaginationButton href={page > 0 ? buildHref(page - 1) : null} label="‹ Prev" />
      {cells.map((c) =>
        c.kind === "ellipsis" ? (
          <span key={c.key} className="px-1 text-[13px] text-muted-foreground">
            …
          </span>
        ) : (
          <PaginationButton
            key={c.n}
            href={buildHref(c.n)}
            label={String(c.n + 1)}
            active={c.n === page}
          />
        ),
      )}
      <PaginationButton href={page < totalPages - 1 ? buildHref(page + 1) : null} label="Next ›" />
    </nav>
  );
}

function PaginationButton({
  href,
  label,
  active,
}: {
  href: string | null;
  label: string;
  active?: boolean;
}) {
  const base =
    "inline-flex h-8 min-w-[32px] items-center justify-center rounded-sm border px-2 text-[13px] no-underline transition-colors";
  if (!href) {
    return (
      <span className={`${base} cursor-not-allowed border-[#e3e2dd] bg-white text-[#c8c6be]`}>
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={
        active
          ? `${base} border-[#2c4f6e] bg-[#2c4f6e] font-medium text-white`
          : `${base} border-[#c8c6be] bg-white text-[#4a4a4a] hover:border-[#2c4f6e] hover:text-[#2c4f6e]`
      }
    >
      {label}
    </Link>
  );
}
