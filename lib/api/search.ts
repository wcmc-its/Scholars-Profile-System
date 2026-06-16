/**
 * Search API — pure-function handlers (production-extractable per Q1').
 *
 * The Next.js route handlers in /api/search/* are thin delegators to these
 * functions. Per-field boost weights live in lib/search.ts.
 *
 * Sort options per spec lines 194, 202:
 *   People:       Relevance (default) | Last name (A–Z) | Most recent publication
 *   Publications: Relevance (default) | Year (newest first) | Citation count
 *
 * Filters per spec lines 195, 203:
 *   People:       person type, department, hasActiveGrants
 *   Publications: year range
 *
 * Default-result filtering: every active scholar is included by default so
 * the directory headline count (#152) matches the real population. Callers
 * can opt back into the `isComplete: true` cull by passing
 * `filters.includeIncomplete = false` explicitly; current callers (the /search
 * page and /api/search) leave it unset.
 */
import { identityImageEndpoint } from "@/lib/headshot";
import { prisma } from "@/lib/db";
import { profilePath } from "@/lib/profile-url";
import { isPubliclyDisplayed } from "@/lib/eligibility";
import { fetchAuthorBylineForPmids, fetchWcmAuthorsForPmids } from "@/lib/api/topics";
import { isMethodPagesEnabled } from "@/lib/profile/methods-lens-flags";
import {
  loadFamilyOverlayGate,
  isFamilyPubliclyVisible,
} from "@/lib/api/methods-overlay";
import { supercategoryLabel } from "@/lib/methods/supercategory-labels";
import { methodFamilyPath } from "@/lib/method-url";
import {
  getMentoringPmidBuckets,
  EMPTY_MENTORING_BUCKETS,
  type MentoringProgramKey,
} from "@/lib/api/mentoring-pmids";
import {
  capFill,
  chooseKindOrder,
  classifyQueryShape,
  plausibilityHits,
  promoteStartsWith,
  tiebreakPeople,
  tryFullNameCarveOut,
  type RankingSources,
} from "@/lib/api/search-ranking";
import {
  MESH_ADMIT_WEIGHT,
  MESH_ATTRIBUTION_WEIGHT,
  MESH_ESCALATION_THRESHOLD,
  MESH_MIN_MATCHED_FORM_LEN,
  PEOPLE_ABSTRACTS_BOOST,
  PEOPLE_DEPT_LEADERSHIP_CHAIR_WEIGHT,
  PEOPLE_DEPT_LEADERSHIP_CHIEF_WEIGHT,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE,
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS,
  PEOPLE_INDEX,
  PEOPLE_PROMINENCE_BASE_WEIGHT,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT,
  PEOPLE_PROMINENCE_GRANT_WEIGHT,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR,
  FUNDING_INDEX,
  PEOPLE_RESTRUCTURED_MSM,
  PEOPLE_TOPIC_ABSTRACTS_BOOST,
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS,
  PUBLICATION_FIELD_BOOSTS,
  PUBLICATIONS_INDEX,
  PUBLICATIONS_RESTRUCTURED_MSM,
  searchClient,
  type MeshMatchTier,
} from "@/lib/search";
import type { MeshConceptCandidate, MeshResolution } from "@/lib/api/search-taxonomy";
import { descriptorLabelsForUis, suggestMeshConcepts } from "@/lib/api/search-taxonomy";
import {
  computeMatchProvenance,
  type MatchProvenance,
} from "@/lib/api/match-provenance";
import {
  resolveConceptMode,
  resolveFundingMeshGateField,
  resolvePeopleConceptGrantAxis,
  resolvePeopleConceptPrecount,
  resolvePeopleMatchAwareSnippet,
  resolvePeopleMethodFamilyBoost,
  resolvePubRecencyMode,
  resolvePublicationDepartmentFilter,
  type PubRecencyMode,
  type Scope,
} from "@/lib/api/search-flags";
// Issue #309 / SPEC §6.1.2 — the classifier's shape enum (cwid / name / …),
// distinct from the OS-body `PeopleQueryShape` telemetry label below. Aliased
// to keep both names unambiguous within this module.
import type { PeopleQueryShape as PeopleQueryClassification } from "@/lib/api/people-query-shape";

const PAGE_SIZE = 20;

export type PeopleSort = "relevance" | "lastname" | "recentPub";
/**
 * Pub-tab sort options.
 *
 * Issue #259 §1.8 replaces the original `year` / `citations` options with
 * `impact` (doc-level MAX `impactScore` desc) and `recency` (`year` desc,
 * tiebreak on `dateAddedToEntrez`). The §1.8 options only render in the
 * UI when `SEARCH_PUB_TAB_IMPACT=on`; under flag-off the dropdown surfaces
 * `year` / `citations` as before. Both sets are accepted by
 * `searchPublications` regardless of flag state so saved URLs and the
 * cross-tab transition window keep working.
 */
export type PublicationsSort =
  | "relevance"
  | "year"
  | "citations"
  | "impact"
  | "recency";

/**
 * Issue #8 / #9 — multi-select facets. All filter axes are now arrays so a
 * single URL can carry e.g. `personType=full_time_faculty&personType=affiliated_faculty`,
 * which is OR'd within the group and AND'd across groups in OpenSearch.
 *
 * `deptDiv` values are the composite key emitted by the ETL: a bare
 * `${deptCode}` for dept-only rows, `${deptCode}--${divCode}` for division
 * rows, or `name:${deptName}` for the long-tail of scholars without an FK.
 *
 * `activity` is a small enum: `has_grants` filters `hasActiveGrants:true`,
 * `recent_pub` filters `mostRecentPubDate >= now-2y`. Multi-select within
 * the group is OR (matches the mockup checkboxes).
 */
export type ActivityFilter = "has_grants" | "recent_pub";

/**
 * Issue #233 — Principal Investigator facet. Single-select radio in the
 * People-tab sidebar. Definitions are locked in `.planning/drafts/SPEC-pi-facet.md`.
 *   - `any`    : ≥1 grant with role in ('PI','PI-Subaward'), any date
 *   - `active` : ≥1 currently-active (NCE grace) PI/PI-Subaward grant that
 *                is not a training-only mechanism
 *   - `multi`  : ≥N grants meeting the `active` criteria (N = piMin)
 */
export type PiFilter = "any" | "active" | "multi";

export const PI_MIN_FLOOR = 2;
export const PI_MIN_CEILING = 30;

export type PeopleFilters = {
  /** Composite dept/division keys. */
  deptDiv?: string[];
  personType?: string[];
  activity?: ActivityFilter[];
  /** Issue #233 — Principal Investigator facet. Absent = "no filter". */
  pi?: PiFilter;
  /** Issue #233 — threshold for `pi=multi`. Clamped to [PI_MIN_FLOOR,
   *  PI_MIN_CEILING] by the caller; out-of-range URL values are accepted
   *  permissively (saved bookmarks with stale ceilings should still return
   *  the highest-defined bucket, not an empty set). */
  piMin?: number;
  /**
   * Sparse-profile cull. Default (undefined) includes every active scholar
   * — the directory baseline (#152). Pass `false` to opt back into the old
   * "isComplete only" behaviour (overview + ≥3 pubs + active grant).
   */
  includeIncomplete?: boolean;
};

export type WcmAuthorRole = "first" | "senior" | "middle";

export type PublicationsFilters = {
  yearMin?: number;
  yearMax?: number;
  publicationType?: string;
  /** Multi-select journal title (verbose form, exact match). */
  journal?: string[];
  /** Multi-select WCM author position role. OR within group. */
  wcmAuthorRole?: WcmAuthorRole[];
  /** Issue #88 — multi-select WCM author CWID. OR within group. */
  wcmAuthor?: string[];
  /** Issue #837 — multi-select WCM-author department key. OR within group.
   *  Values are the composite key emitted by the search-index ETL onto
   *  `wcmAuthorDepartments`: a bare `${deptCode}` (FK-resolved), or a
   *  `name:${deptName}` long-tail key for scholars without an FK code.
   *  Only honored when `SEARCH_PUB_DEPARTMENT_FILTER` is on. */
  department?: string[];
  /** Mentoring activity facet. Multi-select on the mentee's program at time
   *  of mentorship: 'md' (AOC + AOC-2025), 'mdphd' (MD-PhD), 'ecr' (Early
   *  Career Researcher). Selecting one or more buckets restricts results to
   *  publications co-authored between a known mentor and a mentee in any of
   *  the chosen programs. Empty array (or undefined) disables the filter. */
  mentoringPrograms?: MentoringProgramKey[];
};

export type PeopleHit = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  /** FK-resolved department name (preferred) or free-text fallback. */
  deptName: string | null;
  divisionName: string | null;
  roleCategory: string | null;
  pubCount: number;
  grantCount: number;
  hasActiveGrants: boolean;
  identityImageEndpoint: string;
  /** Highlight fragments from the scholar's self-reported fields
   *  (`preferredName` / `areasOfInterest` / `overview`). The card renders the
   *  first as a self-evident snippet fallback when no `matchReason` was computed. */
  highlight?: string[];
  /**
   * PLAN R4 / #967 / #824-follow-up — the single "why this match" reason line the
   * card renders. A discriminated union:
   *
   *   - `{ kind: "method"; family; tools[] }` — #824 follow-up. The matched method
   *     family label + up to 3 exemplar tool names, derived at query time from
   *     `scholar_family`. HIGHEST priority. Only produced when
   *     `SEARCH_PEOPLE_MATCH_AWARE_SNIPPET` is on and the query resolved to a
   *     publicly-visible method family the scholar works in.
   *   - `{ kind: "topic"; label }` — #824 follow-up. The matched research-area
   *     topic shown as a clean human label. Produced when the snippet flag is on
   *     and one of the matched topic slugs appears in the scholar's
   *     `areasOfInterest`. Lower priority than method, higher than the legacy
   *     icon reasons below.
   *   - `{ icon: "publications" | "concept" | "area"; text; pub? }` — the legacy
   *     PLAN R4 (#688/#702) pub-evidence / concept reason, unchanged. Present when
   *     a concept resolved and `SEARCH_PEOPLE_MATCH_EXPLAIN` is on; on a
   *     pub-evidence reason, `pub` carries a representative publication when
   *     `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` is on.
   *
   * Serializable (it crosses to the `PeopleResultCard` client component).
   */
  matchReason?: PeopleMatchReason;
  /**
   * #824 follow-up (match-aware snippet) — humanized, comma-separated research
   * areas (no under_scores) used as the LAST-resort snippet line when no
   * method/topic/concept/pub reason fires and no bio highlight is present. Each
   * area is a clean human label (real `Topic.label` when known, else a sentence-
   * cased humanization of the slug); `matchedIndex` flags which entry should be
   * bold (the area whose slug the query matched), or -1 when none. Present only
   * when `SEARCH_PEOPLE_MATCH_AWARE_SNIPPET` is on; absent (and the card falls
   * back to today's raw slug highlight) when off.
   */
  humanizedAreas?: { labels: string[]; matchedIndex: number };
};

/**
 * #824 follow-up — the discriminated reason-line union. The two NEW kinds carry
 * structured data (method tools / topic label) so the card can render the
 * mockup's badge styles; the legacy `icon`/`text` variant is unchanged so the
 * #688/#702/#967 render path keeps working. Discriminated by the presence of
 * `kind` (new) vs `icon` (legacy).
 */
export type PeopleMatchReason =
  | { kind: "method"; family: string; tools: string[] }
  | { kind: "topic"; label: string }
  | LegacyMatchReason;

/**
 * The legacy PLAN R4 (#688/#702/#967) reason variant: a leading icon + a text
 * line, optionally carrying a representative pub. Named separately so
 * `composeMatchReason` can return exactly this (it never produces the #824
 * method/topic kinds), keeping the existing `.text` / `.pub` test assertions
 * precise.
 */
export type LegacyMatchReason = {
  icon: "publications" | "concept" | "area";
  text: string;
  pub?: RepresentativePub;
};

/**
 * Issue #967 — a single representative publication surfaced inside a People
 * reason line. Drawn from a `top_hits` sub-agg on the publications index (the
 * same aggregation that computes the reason count), so there is no people-index
 * field and no reindex. `titleHtml` is the title with the literal query wrapped
 * in `<mark>` when it appears there (the card renders it via `HighlightedSnippet`);
 * it is absent on a descriptor-tagged match whose title carries no literal term,
 * in which case the card renders the plain `title`.
 */
export type RepresentativePub = {
  pmid: string;
  title: string;
  titleHtml?: string;
  year?: number | null;
};

/** The shape of a reason filter's optional `top` (top_hits) sub-agg. */
type ReasonTopHitsAgg = {
  top?: {
    hits?: {
      hits?: Array<{
        _source?: { pmid?: string | number; title?: string; year?: number | null };
        highlight?: { title?: string[] };
      }>;
    };
  };
};

/**
 * Issue #967 — pull the single representative publication out of a reason
 * filter's `top` (top_hits) sub-agg. Returns undefined when the sub-agg is
 * absent (flag off), the filter matched no pub, or the hit lacks a pmid/title.
 * `titleHtml` is set only when the literal query produced a `<mark>` fragment
 * in the title.
 */
export function parseReasonTopHit(
  agg: ReasonTopHitsAgg | undefined,
): RepresentativePub | undefined {
  const hit = agg?.top?.hits?.hits?.[0];
  const src = hit?._source;
  if (!src || src.pmid == null || !src.title) return undefined;
  const titleHtml = hit?.highlight?.title?.[0];
  return {
    pmid: String(src.pmid),
    title: src.title,
    ...(titleHtml ? { titleHtml } : {}),
    ...(src.year != null ? { year: src.year } : {}),
  };
}

/**
 * PLAN R4 / #967 — the per-scholar reason line. Strongest signal first:
 * pub-evidence count (tagged → mention) then the resolved-concept fallback.
 * When `rep` carries a representative pub for the firing pub-evidence branch
 * (`SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB`), it rides along as `pub`. The
 * concept fallback never carries a pub. Pure — extracted so the precedence and
 * the count cap (`Math.min(count, pubCount)`) are unit-testable without a live
 * cluster.
 */
export function composeMatchReason(args: {
  counts: { tagged: number; mention: number } | undefined;
  rep: { tagged?: RepresentativePub; mention?: RepresentativePub } | undefined;
  pubCount: number;
  hasProvenance: boolean;
  provenanceParent: string;
  contentQuery: string;
}): LegacyMatchReason | undefined {
  const { counts: c, rep, pubCount, hasProvenance, provenanceParent, contentQuery } = args;
  if (c && c.tagged > 0)
    return {
      icon: "publications",
      text: `${Math.min(c.tagged, pubCount)} of ${pubCount} publications tagged ${provenanceParent}`,
      ...(rep?.tagged ? { pub: rep.tagged } : {}),
    };
  if (c && c.mention > 0)
    return {
      icon: "publications",
      text: `${Math.min(c.mention, pubCount)} of ${pubCount} publications mention “${contentQuery}”`,
      ...(rep?.mention ? { pub: rep.mention } : {}),
    };
  if (hasProvenance)
    return { icon: "concept", text: `via related concept ${provenanceParent}` };
  return undefined;
}

/**
 * #824 follow-up — sentence-case a snake_case topic/area slug for the humanized
 * research-areas fallback. Splits on "_", joins with spaces, upper-cases only the
 * first letter of the whole string (sentence case, matching the mockup's
 * "Metabolic & endocrine disease"). `"single_cell_spatial_biology"` →
 * `"Single cell spatial biology"`; `""` → `""`. Used only when no real
 * `Topic.label` is known for the slug.
 */
export function humanizeAreaSlug(slug: string): string {
  const words = slug.split("_").filter(Boolean).join(" ");
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * #824 follow-up — clean exemplar-tool names off a `scholar_family.exemplarTools`
 * JSON value: coerce to string, trim, drop empties, dedupe (case-insensitively),
 * cap at `limit` (3). Defensive against the Json column shape (non-array → []).
 */
export function cleanExemplarTools(raw: unknown, limit = 3): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const name = String(t).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * #824 follow-up — derive the humanized research-areas fallback for a scholar from
 * the space-joined `areasOfInterest` slug string, a topic slug→label map (real
 * `Topic.label` preferred, else {@link humanizeAreaSlug}), and the matched topic
 * slugs (so the matched area can be bolded as a WHOLE label). Returns null when
 * the scholar has no areas. `matchedIndex` is the index of the first area whose
 * slug is in `matchedSlugs`, or -1.
 */
export function buildHumanizedAreas(
  areasOfInterest: string | undefined,
  labelBySlug: Map<string, string>,
  matchedSlugs: Set<string>,
): { labels: string[]; matchedIndex: number } | null {
  const slugs = (areasOfInterest ?? "").trim().split(/\s+/).filter(Boolean);
  if (slugs.length === 0) return null;
  const labels = slugs.map((s) => labelBySlug.get(s) ?? humanizeAreaSlug(s));
  const matchedIndex = slugs.findIndex((s) => matchedSlugs.has(s));
  return { labels, matchedIndex };
}

export type PublicationHit = {
  pmid: string;
  title: string;
  /**
   * The matched title with the query terms wrapped in `<mark>`, present only
   * when `SEARCH_PUB_HIGHLIGHT` is on and the title matched. The row renders this
   * (with the marks restyled) instead of the plain `title`; falls back to
   * `title` otherwise. The indexed title is plain text, so the fragment carries
   * no other markup.
   */
  titleHighlight: string | null;
  journal: string | null;
  year: number | null;
  publicationType: string | null;
  citationCount: number;
  doi: string | null;
  pmcid: string | null;
  pubmedUrl: string | null;
  /** Chip-ready WCM author list with first/senior flags + headshot endpoint,
   *  matching the topic page's TopicPublicationHit.authors shape. */
  wcmAuthors: Array<{
    name: string;
    cwid: string;
    /** Nullable: a soft-deleted doctoral-student co-author (#1026) may have no
     *  slug. A null slug forces a NON-LINKED chip — the FERPA-required rendering. */
    slug: string | null;
    identityImageEndpoint: string;
    isFirst: boolean;
    isLast: boolean;
    /** #536 — drives co-author chip link suppression for hidden roles. */
    roleCategory: string | null;
  }>;
  /**
   * Issue #259 §1.8 — doc-level MAX `impactScore` across this pub's
   * `publication_topic` rows (max over cwids and parent topics). Null when
   * the pub has no non-null impact rows, OR when the §1.8 flag is off
   * (in which case the field is suppressed at the API boundary). Renders
   * as `"Impact: 78"` on the row when `conceptImpactScore` is null.
   */
  impactScore: number | null;
  /**
   * Issue #259 §1.8 — MAX `impactScore` across the pub's topic rows whose
   * `parentTopicId` matches one of the resolved MeSH descriptor's anchored
   * curated topics (from `meshResolution.curatedTopicAnchors`, §1.4).
   * Null when no MeSH descriptor resolved, no anchors, no matching rows,
   * or all matching impact values are null. When non-null, the row renders
   * `"Concept impact: 78"` and the "Impact" fallback is suppressed.
   */
  conceptImpactScore: number | null;
  /**
   * Issue #316 PR-C follow-up — GPT-generated rubric justification for
   * `impactScore`. Sourced from `Publication.impactJustification` via
   * the OS `_source` payload (search-index ETL emits it). When present
   * alongside a non-null `impactScore`, the UI surfaces the text as a
   * hover/focus tooltip on the inline `Impact: NN` value. Null when the
   * pub has no LLM impact data or the impact flag is off (same gating as
   * `impactScore`).
   */
  impactJustification: string | null;
  /**
   * Issue #288 PR-A — plain-text article abstract sourced from
   * `Publication.abstract` via the OS `_source` payload (the search-index
   * ETL writes it on the per-pub doc; see etl/search-index/index.ts).
   * Null when the publication has no abstract or the ETL wrote an empty
   * string. Rendered inline via `<AbstractDisclosure>` on the row.
   */
  abstract: string | null;
  /**
   * Issue #707 — the publications twin of `PeopleHit.matchProvenance` (#688).
   * Present only when `SEARCH_PUB_MATCH_PROVENANCE` is on, the topic query
   * resolved to a MeSH descriptor, AND this publication is tagged with the
   * descriptor (`concept`) or a narrower descendant (`narrower`) — the concept
   * match the title highlighter can't explain. Omitted otherwise. Rendered as
   * the same "Why this match" note the Scholars tab uses.
   */
  matchProvenance?: MatchProvenance;
  /**
   * Issue #718 — unstructured author byline shown when `wcmAuthors` is empty
   * because the pub's only confirmed WCM author was soft-deleted (left WCM), so
   * the row would otherwise render with no attribution at all. Suppression-safe:
   * null whenever the emptiness involves a suppressed author (ADR-005-dark or
   * `scholar.status='suppressed'`), so the byline can never surface a suppressed
   * scholar. Cleaned of `authors_string`'s `(( ))` WCM markers. Hydrated from
   * MySQL per page (no reindex) — see `fetchAuthorBylineForPmids`. Always null
   * when `wcmAuthors` is non-empty (chips win).
   */
  authorsFallback: string | null;
};

export type SearchFacetBucket = { value: string; count: number };

/** Issue #88 — Author facet bucket, hydrated server-side with display
 *  name, slug, and avatar endpoint so the client component just renders. */
export type WcmAuthorFacetBucket = {
  cwid: string;
  displayName: string;
  slug: string;
  identityImageEndpoint: string;
  count: number;
};

/** Dept/division facet bucket — keyed by the ETL-emitted composite key,
 * carries a pre-rendered display label (e.g. "Cardiology — Medicine"). */
export type DeptDivBucket = { value: string; label: string; count: number };

/**
 * Discriminator for which query shape `searchPeople` used for a given
 * request. Logged by the search route (issue #259 §1.1) so the analytics
 * stream can attribute result-count and ranking changes to the correct
 * code path. Reserved values (`concept_filtered`, `concept_fallback`) name
 * future §1.6 shapes up front to avoid a schema migration later.
 *
 * Issue #309 / SPEC §6.1.2 — `name_template` names the v3 name-shape body
 * (name fields only). Issue #310 / SPEC §6.1.3 — `topic_template` names the v3
 * topic-shape body (re-weighted cross_fields ladder wrapped in a
 * function_score). Issue #311 / SPEC §6.1.4 — `department_template` names the
 * v3 department-shape body (dept/title/name fields, no pub fields, no
 * function_score) and `hybrid_template` names the additive name⊕topic body
 * (name-template clauses + the topic boost ladder in a single bool, no
 * function_score). All four are independent of the #259 restructure flag: when
 * the relevance mode is `v3` and the classifier returns the matching shape,
 * these labels supersede `restructured_msm` so analytics can tell each v3 body
 * apart from the cross_fields fallback. SPEC §12 PR-5 (#312) retired the
 * `SEARCH_PEOPLE_QUERY_RESTRUCTURE` flag and its `legacy_multi_match`
 * (flat best_fields) body; `restructured_msm` is now the sole non-template
 * label (legacy rollback mode + unrouted shapes).
 */
export type PeopleQueryShape =
  | "restructured_msm"
  | "name_template"
  | "topic_template"
  | "department_template"
  | "hybrid_template"
  | "concept_filtered"
  | "concept_fallback";

export type PeopleSearchResult = {
  hits: PeopleHit[];
  total: number;
  page: number;
  pageSize: number;
  /** Which query shape served this request — telemetry-only (issue #259). */
  queryShape: PeopleQueryShape;
  /**
   * Issue #310 / SPEC §9 — did the §6.1.3 attribution boost move any result?
   * `true` / `false` when the v3 topic template ran against a resolved
   * descriptor; `null` when the boost wasn't in play (non-topic shape, legacy
   * mode, or no MeSH resolution). Per-request, not per-result.
   */
  attributionBoostFired: boolean | null;
  facets: {
    deptDivs: DeptDivBucket[];
    personTypes: SearchFacetBucket[];
    activity: { hasGrants: number; recentPub: number };
    /** Issue #233 — bucket counts for the PI facet. `multi` reflects the
     *  current `piMin`. `none` is the baseline (all results matching the
     *  other filters; used as the count beside the "No filter" radio). */
    pi: { none: number; any: number; active: number; multi: number };
  };
};

/**
 * Discriminator for which query shape `searchPublications` used. Mirrors
 * `PeopleQueryShape` so downstream analytics can group by `type +
 * queryShape`. Reserved values name the §1.6 concept-filter shapes up
 * front to avoid a schema migration when they ship.
 */
export type PublicationsQueryShape =
  | "legacy_multi_match"
  | "restructured_msm"
  | "concept_filtered"
  | "concept_fallback"
  | "concept_expanded";

export type PublicationsSearchResult = {
  hits: PublicationHit[];
  total: number;
  page: number;
  pageSize: number;
  /** Which query shape served this request — telemetry-only (issue #259). */
  queryShape: PublicationsQueryShape;
  /**
   * Issue #259 SPEC §7.5 — telemetry fields surfaced for the route-handler
   * log line. Populated unconditionally so the per-request log schema is
   * stable across modes; `null` distinguishes "no resolution" from
   * "resolution with N anchors" (N >= 0). PR 2 populates `descendantUis`
   * on every resolution regardless of consumption, so under `strict` /
   * `off` modes the field carries the *would-be* set size — the baseline
   * distribution for §7.3 pre-flip latency/recall comparison.
   */
  meshDescendantSetSize: number | null;
  meshAnchorCount: number | null;
  /**
   * Issue #645 — recency tilt applied to this request (telemetry). The resolved
   * `SEARCH_PUB_RELEVANCE_RECENCY` mode; `recencyOriginYear` is the gauss origin
   * actually used, or `null` when the tilt was NOT applied (mode `off`, or an
   * explicit non-relevance sort). Surfaced so the route log can attribute a
   * ranking shift to the tilt and confirm the origin year (clock-seam guard).
   */
  recencyMode: PubRecencyMode;
  recencyOriginYear: number | null;
  facets: {
    publicationTypes: SearchFacetBucket[];
    journals: SearchFacetBucket[];
    wcmAuthorRoles: { first: number; senior: number; middle: number };
    /** Issue #88 — top WCM authors in the current result set, hydrated. */
    wcmAuthors: WcmAuthorFacetBucket[];
    /** Total distinct WCM authors across the current result set (header
     *  count). May be larger than `wcmAuthors.length` when the agg cap is
     *  hit; surface the true cardinality so the rail can render `Author 1,619`. */
    wcmAuthorsTotal: number;
    /** Issue #183 — contextual count per Mentoring activity bucket. Each
     *  value is the number of publications that would be returned if the
     *  user ticked just that checkbox, holding all other filters constant
     *  (i.e. matches the filtersExcept pattern used by the other facets). */
    mentoringPrograms: Record<MentoringProgramKey, number>;
    /** Issue #837 — Department facet buckets (WCM-author department key →
     *  count) in the current result set, computed excluding the department
     *  axis itself (the `filtersExcept` pattern). Empty when
     *  `SEARCH_PUB_DEPARTMENT_FILTER` is off. The /search page resolves each
     *  `value` key to a display label via `resolveDeptDivLabels()`. */
    departments: SearchFacetBucket[];
  };
};

// Issue #692 — generic-term demotion. The "discount" boost applied to the full
// query when scoring on the content query: a doc that also contains the removed
// generic terms ranks marginally above one that doesn't, but generics can never
// outweigh content. "Discounted, not ignored."
const GENERIC_DISCOUNT_BOOST = 0.1;

/**
 * Issue #692 §4.2 — gate(content) + discount(full) scoring clause. The content
 * query is the recall/scoring driver (with the caller's msm, if any); the full
 * query rides as a low-boost `should` so generic terms only tie-break. Called
 * ONLY when demoting; off-mode call sites keep their original inline clause, so
 * the default-off body is byte-identical to today's.
 */
function demoteScoringClause(opts: {
  contentQuery: string;
  fullQuery: string;
  fields: string[];
  type: "best_fields" | "cross_fields";
  msm?: string;
  boost?: number;
}): Record<string, unknown> {
  const mm = (query: string, extra: Record<string, unknown>) => ({
    multi_match: {
      query,
      fields: opts.fields,
      type: opts.type,
      operator: "or",
      ...(opts.msm ? { minimum_should_match: opts.msm } : {}),
      ...extra,
    },
  });
  return {
    bool: {
      must: [mm(opts.contentQuery, opts.boost !== undefined ? { boost: opts.boost } : {})],
      should: [
        {
          multi_match: {
            query: opts.fullQuery,
            fields: opts.fields,
            type: opts.type,
            operator: "or",
            boost: GENERIC_DISCOUNT_BOOST,
          },
        },
      ],
    },
  };
}

/**
 * #921 — concept-scope grant axis. The People index carries no grant MeSH, so
 * to include scholars FUNDED on a concept (not only those who PUBLISHED on it)
 * we ask the Funding index which WCM investigators hold a grant whose concept
 * gate field (`SEARCH_FUNDING_MESH_GATE` via {@link resolveFundingMeshGateField})
 * intersects the resolved descendant set, then union those cwids into the People
 * query. Size-capped: a concept broader than the cap undercounts the union,
 * acceptable for a dark count-oriented feature (no silent ranking change).
 */
const GRANT_AXIS_CWID_CAP = 5000;

async function collectGrantMatchedCwids(descendantUis: string[]): Promise<string[]> {
  if (descendantUis.length === 0) return [];
  const meshGateField = resolveFundingMeshGateField();
  const resp = await searchClient().search({
    index: FUNDING_INDEX,
    body: {
      size: 0,
      query: { bool: { filter: [{ terms: { [meshGateField]: descendantUis } }] } },
      aggs: {
        cwids: { terms: { field: "wcmInvestigatorCwids", size: GRANT_AXIS_CWID_CAP } },
      },
    } as object,
  });
  const buckets =
    (
      resp.body as unknown as {
        aggregations?: { cwids?: { buckets?: Array<{ key: string }> } };
      }
    ).aggregations?.cwids?.buckets ?? [];
  return buckets.map((b) => b.key);
}

export async function searchPeople(opts: {
  q: string;
  page?: number;
  sort?: PeopleSort;
  filters?: PeopleFilters;
  /** Phase 3 D-10 — filter results to scholars who have publications in this topic (parent topic slug). */
  topic?: string;
  /**
   * Issue #309 / SPEC §6.1 — the `SEARCH_PEOPLE_RELEVANCE_MODE` value at
   * request time. The route reads the env and classifies the query; both are
   * passed down so this function stays env-free and re-uses the route's
   * already-computed classification (no second classifier run, no second
   * surname-set fetch). Defaults to `legacy` so headless callers that don't
   * opt in keep today's behavior.
   */
  relevanceMode?: "legacy" | "v3";
  /**
   * Issue #309 / SPEC §6.1.1 — the classifier shape from the route
   * (`classifyPeopleQuery`). `name` routes to the §6.1.2 name template (#309);
   * `topic` / `unclassified` route to the §6.1.3 topic template (#310);
   * `department` routes to the §6.1.4 department template and `hybrid` to the
   * §6.1.4 additive name⊕topic template (#311). `cwid` / `empty` still ride the
   * existing cwid short-circuit / `match_all` browse paths.
   */
  shape?: PeopleQueryClassification;
  /**
   * Issue #310 / SPEC §6.1.3 — the resolved MeSH descriptor's `descendantUis`
   * (descriptor UIs subsumed by the resolved descriptor's tree numbers),
   * computed once by the route via `matchQueryToTaxonomy()`. Drives the
   * topic-shape attribution boost (`terms { publicationMeshUi: descendantUis }`,
   * ×1.5). Empty/absent when the query didn't resolve to a descriptor — the
   * boost function is simply omitted then.
   */
  meshDescendantUis?: string[];
  /**
   * #726 — match-type signals for the MeSH concept-admission escalation,
   * derived by the caller from the resolved `MeshResolution`. `meshMatchTier`
   * grades trust (exact > anchored-entry > entry) to weight admission + the
   * attribution boost; `meshAmbiguous` / `meshMatchedFormLength` gate the
   * sparse-escalation floor (don't escalate on an ambiguous or ultra-short
   * resolution). Absent ⇒ no concept-admission escalation (boost-only — today's
   * behaviour).
   */
  meshMatchTier?: MeshMatchTier;
  meshAmbiguous?: boolean;
  meshMatchedFormLength?: number;
  /**
   * PLAN R5 / handoff item 3 — the user-facing match scope. Drives the
   * concept-only result-SET gate: when `concept`, an additional
   * `terms { publicationMeshUi: descendantUis }` predicate is pushed into the
   * always-on `queryFilter` so the People list AND all badge counts shrink to
   * scholars with at least one publication tagged within the resolved
   * descriptor's descendant set (the same set the ×1.5 boost and the per-row
   * reason counts already use). `exact` rides the empty-`descendantUis` path
   * (boost dropped, no set gate); `expanded` (default) is byte-identical to the
   * pre-gate body — it pushes nothing. Absent ⇒ `expanded`.
   */
  scope?: Scope;
  /**
   * Issue #688 — `SEARCH_PEOPLE_MATCH_PROVENANCE` resolved at request time by
   * the route. When true (and the topic template ran against a resolved
   * descriptor), each hit that matched via a narrower descendant term carries
   * `matchProvenance` so the UI can explain the subsumption match. Pure
   * additive metadata: no effect on the query, scoring, or result set.
   */
  matchProvenance?: boolean;
  /**
   * Issue #702 / PLAN R4 — `SEARCH_PEOPLE_MATCH_EXPLAIN` resolved at request time
   * by the route. When true (and a concept resolved against the topic template),
   * `searchPeople` runs ONE extra publications-index aggregation to count each
   * page scholar's on-topic publications (the `reasonCounts` distinct-pmid agg),
   * which feeds the per-row `matchReason` line. Pure presentation metadata: no
   * effect on the people query predicate, scoring, or result set. Headless
   * callers default to `false`.
   */
  matchExplain?: boolean;
  /**
   * Issue #967 — when true (and `matchExplain` is on), the `reasonCounts`
   * aggregation also fetches a representative publication per page cwid via a
   * `top_hits` sub-agg, surfaced as `matchReason.pub`. Pure presentation; no
   * effect on ranking or the result set. Headless callers default to `false`.
   */
  representativePub?: boolean;
  /**
   * Issue #688 — the resolved descriptor's display name (the term the user
   * effectively searched), passed alongside `meshDescendantUis` so the
   * provenance string can read "… narrower term of {name}". Absent when the
   * query didn't resolve to a descriptor.
   */
  meshDescriptorName?: string;
  /**
   * Issue #532 — `SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST` resolved at request
   * time by the route (`resolveDeptLeadershipBoost()`). When true, the
   * department-shape template wraps its body in a multiplicative
   * `function_score` that promotes the queried dept's chair (×3.0) over
   * other dept members. The signal source is `leadership.chairOf` on the
   * scholars-people doc; if the index hasn't been rebuilt with that field
   * (omit-on-empty when not chair / chief), the filter simply never fires
   * and the template's behavior is unchanged. Headless callers default to
   * `false` so the rollout is opt-in.
   */
  deptLeadershipBoost?: boolean;
  /**
   * Issue #692 — generic-term demotion (mode `on`). When true and `contentQuery`
   * differs from the raw query, the topic + hybrid bodies score on the content
   * query (full query discounted) and highlighting is restricted to the content
   * query. Inert for name/department/cwid/empty shapes. Default false.
   */
  genericDemote?: boolean;
  /** Issue #692 — the query with deprioritized filler tokens removed (computed
   *  once in the route by `stripDeprioritized`). Only consumed when
   *  `genericDemote` is true; ignored otherwise. */
  contentQuery?: string;
  /**
   * Perf — count-only mode for the inactive search tabs. The /search page
   * runs all three corpora on every request, but the two tabs the user
   * isn't viewing need only their total for the "{n} people · {n} pubs ·
   * {n} funding" subhead + tab badges. When true, skip the facet
   * aggregations, scoring, highlighting, and hit emission and return just
   * `total` (with empty hits/facets). `hits.total.value` is computed from
   * the query predicate, so the count is identical to the full search;
   * `post_filter` and scoring don't affect the total, so omitting them is
   * safe. Headless callers default to a full search.
   */
  countOnly?: boolean;
  /**
   * #824 follow-up (match-aware snippet) — resolved-match context the page/route
   * derives from the already-computed `taxonomyMatch` (so there is no added
   * taxonomy resolution inside `searchPeople`). Consumed ONLY when
   * `resolvePeopleMatchAwareSnippet()` is on; absent/ignored otherwise.
   *
   *   - `methodFamily` — the resolved method family's stable
   *     `(supercategory, familyLabel)` identity (from `taxonomyMatch.methodMatches[0]`).
   *     When set, `searchPeople` runs ONE batched `scholar_family` query over the
   *     page cwids (overlay-gated — a suppressed/sensitive family never surfaces)
   *     and emits a `{ kind: "method" }` reason per matching scholar.
   *   - `topics` — the matched research-area topics `{ slug, label }` (from
   *     `taxonomyMatch.areas`). A scholar whose `areasOfInterest` contains a
   *     matched slug gets a `{ kind: "topic" }` reason (lower priority than method).
   *
   * No reindex: both derive at query time. Flag-OFF ⇒ this is never read, no
   * extra query fires, and the per-hit reason/snippet shape is byte-identical to
   * today.
   */
  matchAwareContext?: {
    methodFamily?: { supercategory: string; familyLabel: string } | null;
    topics?: { slug: string; label: string }[];
  };
}): Promise<PeopleSearchResult> {
  const { q, page = 0 } = opts;
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();

  // Issue #692 — generic-term demotion. Only active when the route asked for it
  // AND there is a real content/full split; otherwise `contentQuery === trimmed`
  // and every demote-gated branch falls back to its original clause.
  const demoteGeneric =
    opts.genericDemote === true &&
    !!opts.contentQuery &&
    opts.contentQuery !== trimmed;
  const contentQuery = demoteGeneric ? (opts.contentQuery as string) : trimmed;

  // Issue #702 — match-explainability. When on, widen the highlight request so a
  // pub-only match has something to show ("Matched in publications: …") and the
  // card can derive a "Matched on …" chip. Default-off ⇒ the highlight block and
  // hit emission below are byte-identical to the pre-#702 shape.
  const matchExplain = opts.matchExplain === true;
  const representativePub = opts.representativePub === true;

  // #824 follow-up — match-aware snippet. When on, `searchPeople` may derive a
  // method/topic reason and a humanized-areas fallback (all from query-time data,
  // no reindex). Gating on the flag here keeps the off path byte-identical: no
  // extra `_source` field, no extra `scholar_family` query, no new reason kinds.
  const matchAwareSnippet = resolvePeopleMatchAwareSnippet();
  const matchAwareContext = matchAwareSnippet ? opts.matchAwareContext : undefined;

  // Issue #259 §1.1 — the people-index query restructure (cross_fields + msm
  // over high-evidence fields, abstracts in a scoring-only should). It was a
  // prod-verified env flag (`SEARCH_PEOPLE_QUERY_RESTRUCTURE`) cutting the
  // 4,303 → low-4-figure scholar-tab result for "electronic health records".
  // SPEC §12 PR-5 (#312) retired the flag: the restructured body is now the
  // unconditional non-template body — the body for the `legacy` rollback mode
  // and the fallback for any shape the §6.1 templates don't route (cwid's
  // secondary interpretation). The old `=off` flat best_fields path is gone.

  // Issue #309 / SPEC §6.1.2 — name-shape template. When the relevance mode is
  // `v3` and the route classified the query as `name`, the body restricts to
  // name fields only (the Problem #2 fix: a surname matching unrelated pubs no
  // longer fans those scholars in via cross_fields). Empty/whitespace queries
  // fall through to the `match_all` browse branch, so gate on a non-empty
  // trimmed query. SPEC §12 PR-5 flipped the default to `v3`; headless callers
  // that don't pass `relevanceMode` get `v3` (a template still requires a
  // matching `shape`, so a shape-less call stays on the restructured body).
  const relevanceMode = opts.relevanceMode ?? "v3";
  const applyNameTemplate =
    relevanceMode === "v3" && opts.shape === "name" && trimmed.length > 0;

  // Issue #310 / SPEC §6.1.3 — topic-shape template. `topic` (MeSH-resolvable
  // or long queries) and `unclassified` (the soft fallback per §6.1.1) both
  // route here: a re-weighted cross_fields body (pub evidence leads over
  // self-reported AOI, the Problem #1 fix) wrapped in a multiplicative
  // function_score (attribution + productive-author boosts, sparse decay).
  const applyTopicTemplate =
    relevanceMode === "v3" &&
    (opts.shape === "topic" || opts.shape === "unclassified") &&
    trimmed.length > 0;

  // Issue #311 / SPEC §6.1.4 — department-shape template. The classifier returns
  // `department` only for a query that is exactly a known department name (an
  // empty leftover after the dept-prefix strip); a dept name plus extra tokens
  // is routed to `hybrid` instead. So this body never has to fold in "remaining
  // topic tokens" — it is the dept/title/name ladder over the full query, with
  // no pub-derived fields and no function_score wrapper (§6.1.5 decay is
  // topic-shape-only).
  const applyDeptTemplate =
    relevanceMode === "v3" && opts.shape === "department" && trimmed.length > 0;

  // Issue #311 / SPEC §6.1.4 — hybrid template. A surname anchor plus a topic
  // signal (e.g. `cantley ras`), or a department name plus extra tokens. The
  // name-template clauses and the topic boost ladder are combined additively in
  // a single bool (BM25 sums matching should-clauses), so the strong name boost
  // pins the anchored scholar at the top while the topic ladder still ranks the
  // rest by topical evidence. The topic ladder rides as a no-msm cross_fields
  // should-clause (soft/additive, not the topic template's must+msm) so a
  // scholar matching only the topic token still scores. No function_score
  // wrapper: attribution / productive-author / sparse decay are §6.1.3-scoped.
  const applyHybridTemplate =
    relevanceMode === "v3" && opts.shape === "hybrid" && trimmed.length > 0;

  // Descendant-UI set for the attribution boost — empty unless the route
  // resolved the query to a MeSH descriptor.
  const meshDescendantUis = opts.meshDescendantUis ?? [];

  let queryShape: PeopleQueryShape = "restructured_msm";
  if (applyNameTemplate) queryShape = "name_template";
  if (applyTopicTemplate) queryShape = "topic_template";
  if (applyDeptTemplate) queryShape = "department_template";
  if (applyHybridTemplate) queryShape = "hybrid_template";

  // D-10 topic pre-filter: resolve cwids via Prisma before hitting OpenSearch.
  // This ensures the search is scoped to scholars attributed to the topic regardless
  // of whether the OpenSearch index has a dedicated topic field. Pre-filtered at the DB layer.
  let topicCwidFilter: string[] | undefined;
  if (opts.topic && opts.topic.length > 0) {
    const topicCwidRows = await prisma.publicationTopic.groupBy({
      by: ["cwid"],
      where: {
        parentTopicId: opts.topic,
        scholar: { deletedAt: null, status: "active" },
      },
      _count: { _all: true },
    });
    const topicCwids = topicCwidRows.map((r: { cwid: string }) => r.cwid);
    // Edge case: no scholars match the topic — return empty result without hitting OpenSearch.
    if (topicCwids.length === 0) {
      return {
        hits: [],
        total: 0,
        page,
        pageSize: PAGE_SIZE,
        queryShape,
        // No OpenSearch call ran, so the attribution boost was never evaluated.
        attributionBoostFired: null,
        facets: {
          deptDivs: [],
          personTypes: [],
          activity: { hasGrants: 0, recentPub: 0 },
          pi: { none: 0, any: 0, active: 0, multi: 0 },
        },
      };
    }
    topicCwidFilter = topicCwids;
  }

  // Sparse-profile filter (#152): the indexer flags scholars as
  // `isComplete` only when they have an overview, ≥3 publications, AND an
  // active grant. That collapsed the default browse view to ~190 of ~8.9k
  // active scholars, which read as a directory bug. Apply the filter only
  // when a caller explicitly opts in via `includeIncomplete: false`; the
  // default browse experience now shows the full active scholar set.
  const applySparseFilter = filters.includeIncomplete === false;
  // "Published in last 2 years" cutoff (issue #8 item 15).
  const recentPubCutoff = new Date();
  recentPubCutoff.setFullYear(recentPubCutoff.getFullYear() - 2);

  // Issue #259 §1.1 — when the restructure flag is on, the multi_match
  // branch is split into a must clause over high-evidence fields (with msm)
  // and a should clause for the publicationAbstracts blob (scoring only).
  // The default `best_fields` multi_match has no token-coverage floor, and
  // `publicationAbstracts` is a concatenated blob of every abstract on the
  // scholar that clears any per-field threshold on its own — so adding msm
  // to the existing flat shape barely tightens anything. The restructure
  // is the fix.
  // Spec correction (v2.2): `type` switched from `best_fields` to
  // `cross_fields`. The §1.1 prose described cross_fields semantics — "a
  // scholar with 'electronic' + 'health' + 'record' scattered across name,
  // areasOfInterest, title, publicationTitles should match" — but the code
  // snippet specified `best_fields`, which picks the single best-matching
  // field and applies msm to its tokens alone. With best_fields, a scholar
  // whose three tokens land in three different fields fails msm (each field
  // sees only 1 of 3). cross_fields blends the field group as one big field
  // for IDF and matching, which is what concept queries actually want.
  //
  // `operator: "or"` is kept (not "and") because OpenSearch ignores msm
  // when operator is "and", and the msm table is exactly what §1.1
  // committed to enforce. For a 3-token query like "electronic health
  // records", and/or are equivalent (msm requires all 3 anyway); they
  // diverge on 4+ tokens where msm allows 25% missing and "and" doesn't.
  //
  // Issue #824 §4c — method-family boost. When `SEARCH_PEOPLE_METHOD_FAMILY` is
  // on, append the index-time `methodFamily` rollup field to the topic + default
  // boost ladders so a free-text method/tool query ranks scholars who work in
  // that method family. `methodFamily` uses the SAME `scholar_text` analyzer as
  // the other ladder fields, so it joins the `cross_fields` blended group
  // cleanly and does not perturb the `minimum_should_match` token accounting.
  // Default OFF (reindex-then-flip): when off, these are byte-identical spreads
  // of the unchanged constant ladders, so the query is unchanged. The exported
  // constant arrays are NEVER mutated (their msm-parser + snapshot tests stay
  // green) — we only build local copies. Built LAZILY (thunks) so a shape that
  // never reaches the topic/default branch — e.g. a pure name-template query —
  // does not spread a ladder it doesn't use; this preserves the prior
  // per-branch evaluation (a name query never referenced these constants).
  const methodBoostOn = resolvePeopleMethodFamilyBoost();
  const peopleTopicFields = (): string[] =>
    methodBoostOn
      ? [...PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS, "methodFamily^4"]
      : [...PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS];
  const peopleDefaultFields = (): string[] =>
    methodBoostOn
      ? [...PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS, "methodFamily^3"]
      : [...PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS];

  // Issue #311 / SPEC §6.1.4 — name-template should-clauses, reused by the name
  // template (#309) and as the name half of the hybrid template. The cwid^100
  // term stays in the outer `should` (the existing short-circuit), so it is NOT
  // repeated here.
  const nameTemplateClauses: Record<string, unknown>[] = [
    { match_phrase: { preferredName: { query: trimmed, slop: 2, boost: 30 } } },
    { match: { preferredName: { query: trimmed, boost: 10 } } },
    { match_phrase: { fullName: { query: trimmed, slop: 2, boost: 30 } } },
    { match: { fullName: { query: trimmed, boost: 10 } } },
    { term: { lastNameSort: { value: trimmed.toLowerCase(), boost: 25 } } },
  ];

  // Issue #309 / SPEC §6.1.2 — name-shape template takes precedence over both
  // bodies above when active. Name fields only (preferredName, fullName,
  // lastNameSort): match_phrase (slop 2) rewards exact-order names, plain
  // match catches reversed/initial-only order, and the lastNameSort keyword
  // term is the single-token surname exact hit.
  const queryBranch: Record<string, unknown> = applyNameTemplate
    ? {
        bool: {
          should: nameTemplateClauses,
          minimum_should_match: 1,
        },
      }
    : applyDeptTemplate
    ? {
        // Issue #311 / SPEC §6.1.4 — department-shape body. Dept/title/name
        // ladder only: primaryDepartment as a match_phrase (boost 20; a
        // single-token dept name behaves identically to `match`), title at 8,
        // and a soft preferredName/fullName fallback at 2 so an ambiguous
        // surname-like dept query can still surface people. areasOfInterest at
        // 1 is the soft topical fallback. No pub-derived fields, no overview,
        // no function_score (the §6.1.5 sparse decay is topic-shape-only).
        bool: {
          should: [
            { match_phrase: { primaryDepartment: { query: trimmed, boost: 20 } } },
            { match: { primaryTitle: { query: trimmed, boost: 8 } } },
            { match: { preferredName: { query: trimmed, boost: 2 } } },
            { match: { fullName: { query: trimmed, boost: 2 } } },
            { match: { areasOfInterest: { query: trimmed, boost: 1 } } },
          ],
          minimum_should_match: 1,
        },
      }
    : applyHybridTemplate
    ? {
        // Issue #311 / SPEC §6.1.4 — hybrid body. Name-template clauses ⊕ the
        // topic boost ladder, summed by BM25 in one bool. The topic ladder
        // rides as a no-msm cross_fields should-clause (soft/additive — unlike
        // the §6.1.3 topic template's must+msm) so a scholar matching only the
        // topic token still scores; the anchored name's boost (30/25/10) keeps
        // the named scholar at rank 1 (§10 row 4: `cantley ras`).
        bool: {
          should: [
            ...nameTemplateClauses,
            // Issue #692 — topic ladder scores on the content query (full query
            // discounted) when demoting; otherwise the original cross_fields.
            demoteGeneric
              ? demoteScoringClause({
                  contentQuery,
                  fullQuery: trimmed,
                  fields: peopleTopicFields(), // #824 §4c — incl. methodFamily^4 when flag on
                  type: "cross_fields",
                })
              : {
                  multi_match: {
                    query: trimmed,
                    fields: peopleTopicFields(), // #824 §4c — incl. methodFamily^4 when flag on
                    type: "cross_fields",
                    operator: "or",
                  },
                },
            {
              match: {
                publicationAbstracts: {
                  query: contentQuery,
                  boost: PEOPLE_TOPIC_ABSTRACTS_BOOST,
                },
              },
            },
          ],
          minimum_should_match: 1,
        },
      }
    : applyTopicTemplate
    ? {
        // Issue #310 / SPEC §6.1.3 — topic-shape body. Same cross_fields + msm
        // shape as the #259 restructure body, but the re-weighted ladder
        // (PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS) leads with pub-derived
        // evidence over self-reported AOI. publicationAbstracts stays in the
        // scoring-only `should` at the raised topic boost. The three
        // multiplicative modifiers wrap this body via function_score below.
        bool: {
          must: [
            // Issue #692 — the topic must-clause gates on the content query
            // (full query discounted) when demoting; otherwise unchanged.
            demoteGeneric
              ? demoteScoringClause({
                  contentQuery,
                  fullQuery: trimmed,
                  fields: peopleTopicFields(), // #824 §4c — incl. methodFamily^4 when flag on
                  type: "cross_fields",
                  msm: PEOPLE_RESTRUCTURED_MSM,
                })
              : {
                  multi_match: {
                    query: trimmed,
                    fields: peopleTopicFields(), // #824 §4c — incl. methodFamily^4 when flag on
                    type: "cross_fields",
                    operator: "or",
                    minimum_should_match: PEOPLE_RESTRUCTURED_MSM,
                  },
                },
          ],
          should: [
            {
              match: {
                publicationAbstracts: {
                  query: contentQuery,
                  boost: PEOPLE_TOPIC_ABSTRACTS_BOOST,
                },
              },
            },
          ],
        },
      }
    : {
        // Issue #259 §1.1 / SPEC §12 PR-5 — the restructured body, now the
        // unconditional non-template fallback (legacy rollback mode + any shape
        // the §6.1 templates don't route). cross_fields + msm over the
        // high-evidence fields; publicationAbstracts is a scoring-only should
        // (the blob clears any per-field msm on its own, so it can't admit).
        bool: {
          must: [
            {
              multi_match: {
                query: trimmed,
                fields: peopleDefaultFields(), // #824 §4c — incl. methodFamily^3 when flag on
                type: "cross_fields",
                operator: "or",
                minimum_should_match: PEOPLE_RESTRUCTURED_MSM,
              },
            },
          ],
          should: [
            {
              match: {
                publicationAbstracts: {
                  query: trimmed,
                  boost: PEOPLE_ABSTRACTS_BOOST,
                },
              },
            },
          ],
        },
      };

  // #921 — concept-scope grant axis. When ON (dark by default), collect the
  // cwids of WCM investigators funded on the resolved concept so the People set
  // / facets / count can union them with the publication-tagged scholars below.
  // Flag-off (or non-concept scope / no descriptors) → no Funding round-trip and
  // an empty set, so the query bodies stay byte-identical to today.
  const grantAxisOn =
    opts.scope === "concept" &&
    meshDescendantUis.length > 0 &&
    resolvePeopleConceptGrantAxis();
  const grantMatchedCwids = grantAxisOn
    ? await collectGrantMatchedCwids(meshDescendantUis)
    : [];
  const grantAxisActive = grantMatchedCwids.length > 0;

  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    const conceptScopeShould: Record<string, unknown>[] = [
      // CWIDs are stored lowercase as a `keyword` field; an exact term
      // match wins over the multi_match by a wide boost so a pasted
      // CWID resolves to its scholar at the top of the result list.
      { term: { cwid: { value: trimmed.toLowerCase(), boost: 100 } } },
      queryBranch,
    ];
    // #921 — admit grant-funded-on-concept scholars into the scoring gate so a
    // scholar funded on the concept but WITHOUT a concept-tagged publication
    // still satisfies `must`. The low constant boost keeps these grant-only
    // matches below publication BM25 evidence (acceptance #3); the always-on
    // filter gate below admits them to the result SET.
    if (grantAxisActive) {
      conceptScopeShould.push({ terms: { cwid: grantMatchedCwids, boost: 0.1 } });
    }
    must.push({
      bool: {
        should: conceptScopeShould,
        minimum_should_match: 1,
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  // Build named filter clauses so we can rebuild per-facet aggregations that
  // EXCLUDE the facet's own selection (mockup behaviour: ticking
  // "Full-time faculty" should not collapse the Person-type list to just
  // that one bucket — the other type rows still need accurate counts).
  const deptDivClause = filters.deptDiv && filters.deptDiv.length > 0
    ? { terms: { deptDivKey: filters.deptDiv } }
    : null;
  const personTypeClause = filters.personType && filters.personType.length > 0
    ? { terms: { personType: filters.personType } }
    : null;
  const activityClauses: Record<string, unknown>[] = [];
  if (filters.activity && filters.activity.length > 0) {
    const should: Record<string, unknown>[] = [];
    if (filters.activity.includes("has_grants")) {
      should.push({ term: { hasActiveGrants: true } });
    }
    if (filters.activity.includes("recent_pub")) {
      should.push({ range: { mostRecentPubDate: { gte: recentPubCutoff.toISOString() } } });
    }
    activityClauses.push({ bool: { should, minimum_should_match: 1 } });
  }
  const sparseClause = applySparseFilter ? { term: { isComplete: true } } : null;
  const topicClause = topicCwidFilter && topicCwidFilter.length > 0
    ? { terms: { cwid: topicCwidFilter } }
    : null;

  // Issue #233 — PI facet clause. Single-select; `pi=multi` carries an
  // additional `piMin` threshold clamped to [PI_MIN_FLOOR, PI_MIN_CEILING].
  // Out-of-range `piMin` values are clamped silently so saved bookmarks with
  // stale values still return the highest-defined bucket rather than empty.
  const piMode: PiFilter | undefined = filters.pi;
  const piMin = Math.min(
    PI_MIN_CEILING,
    Math.max(PI_MIN_FLOOR, filters.piMin ?? PI_MIN_FLOOR),
  );
  const piClauseFor = (mode: PiFilter, threshold: number): Record<string, unknown> => {
    if (mode === "any") return { term: { piRoleEver: true } };
    if (mode === "active") return { range: { activePiGrantCount: { gte: 1 } } };
    return { range: { activePiGrantCount: { gte: threshold } } };
  };
  const piClause = piMode ? piClauseFor(piMode, piMin) : null;

  // Filter classification:
  //   - "Always-on" filters (sparse-profile, topic pre-filter) belong on
  //     the main query so aggregations respect them — bucket counts for
  //     hidden profiles or out-of-topic scholars would be misleading.
  //   - "User-axis" filters (deptDiv, personType, activity) move to
  //     post_filter so the aggregations see the unfiltered hit set and
  //     each per-axis agg can re-apply only the OTHER user-axis filters
  //     to compute correct excluding-self counts. Without this split, a
  //     filter aggregation operating inside a query that already has
  //     personType=X applied would only ever see personType=X docs and
  //     collapse the personType facet to one bucket.
  const queryFilter: Record<string, unknown>[] = [];
  if (sparseClause) queryFilter.push(sparseClause);
  if (topicClause) queryFilter.push(topicClause);

  // PLAN R5 / handoff item 3 — concept-only result-SET gate. Under `concept`
  // scope (and only when the query resolved to a descriptor, so
  // `meshDescendantUis` is non-empty), admit only scholars with at least one
  // publication tagged within the descendant set — the same set already used by
  // the ×1.5 attribution boost and the per-row reason counts. Pushed into the
  // always-on filter so the People list, the facet aggregations, AND the
  // countOnly badge all shrink together. `expanded` pushes nothing here, so its
  // query body stays byte-identical to today; `exact` rides the empty-set path
  // (`meshDescendantUis = []` ⇒ the guard is skipped, boost-drop only).
  if (opts.scope === "concept" && meshDescendantUis.length > 0) {
    // #921 — when the grant axis is active, the set gate admits scholars tagged
    // with the concept in a publication OR funded on it (a should over the two
    // cwid/mesh predicates); de-dup is automatic. Flag-off keeps the original
    // single `terms` gate, so the body is byte-identical to today.
    queryFilter.push(
      grantAxisActive
        ? {
            bool: {
              should: [
                { terms: { publicationMeshUi: meshDescendantUis } },
                { terms: { cwid: grantMatchedCwids } },
              ],
              minimum_should_match: 1,
            },
          }
        : { terms: { publicationMeshUi: meshDescendantUis } },
    );
  }

  // Issue #726 — match-type tier (set by the caller from the resolved
  // descriptor's confidence + curated-anchor count). Drives the graduated
  // attribution weight below and the concept-admission boost. Defaults to
  // `exact` so an un-threaded caller keeps the pre-#726 flat ×1.5 attribution.
  const meshTier: MeshMatchTier = opts.meshMatchTier ?? "exact";

  // Issue #726 — escalate-on-sparse concept admission (recall floor, not a
  // maximizer). When the topic query resolved to a TRUSTWORTHY descriptor
  // (unambiguous, matched form >= MESH_MIN_MATCHED_FORM_LEN) and the lexical
  // result is sparse (< MESH_ESCALATION_THRESHOLD), OR-in a
  // `terms { publicationMeshUi }` admission so concept-tagged scholars surface
  // on an otherwise-thin page (e.g. tylenol → acetaminophen authors). The
  // decision is COUNT-GATED so common queries keep count == lexical and aren't
  // diluted; the two-pass cost is paid only on the eligible/sparse path. The
  // floor is ambiguity OR an ultra-short matched form — NOT anchor status — so
  // an unanchored entry-term still escalates (the tylenol 0→N recall win).
  //
  // HOW the count gate is sourced is the B2 lever below: by default a dedicated
  // cheap size:0 pre-count of the lexical predicate decides up front; with
  // SEARCH_PEOPLE_CONCEPT_PRECOUNT=off the count comes from the main search's
  // OWN total and we re-run escalated only on sparse (one fewer round-trip on
  // the common non-sparse path). Both source the SAME lexical total against the
  // SAME predicate, so the escalation decision — and therefore `badge == list`
  // — is identical under either state.
  //
  // EXCLUDES `concept` scope: that scope already pushes the SAME
  // `terms { publicationMeshUi }` clause into the always-on `queryFilter`
  // above (the #718 result-SET gate), so every surviving doc carries the tag.
  // OR-ing it into the topic `must` would then satisfy minimum_should_match for
  // every doc and make the lexical clause optional — silently widening the
  // precision gate from "lexical ∩ tagged" to "all tagged", the opposite of
  // what concept scope promises. Under `concept` the gate is the admission, so
  // escalation is both redundant and harmful (and any pre-count is wasted).
  const meshConceptEligible =
    applyTopicTemplate &&
    opts.scope !== "concept" &&
    meshDescendantUis.length > 0 &&
    !opts.meshAmbiguous &&
    (opts.meshMatchedFormLength ?? 0) >= MESH_MIN_MATCHED_FORM_LEN;

  // The escalate-on-sparse mutation, factored out so the flag-on pre-count path
  // and the flag-off reorder path apply the IDENTICAL admission. applyTopic-
  // Template ⇒ queryBranch IS the topic-shape body (the name / dept / hybrid
  // arms are mutually exclusive shapes), so its `bool.must` is the lexical
  // clause. Wrap it in a should that ALSO admits concept-tagged docs. A
  // concept-only doc (no lexical hit) scores ONLY this terms clause's constant
  // boost (MESH_ADMIT_WEIGHT[tier]); a genuine lexical hit scores BM25 over the
  // high-evidence topic fields (publicationTitles^6, publicationMesh^4, …),
  // which empirically runs well above the admit boosts (entry 0.7 … exact 3),
  // so lexical sorts on top and the admit weights only order the concept-only
  // tail by match-type trust (see docs/search-recall.md; the runtime order
  // check is the gate). `must`, the facet aggs, and the count-only body all
  // reference queryBranch, so this single mutation is reflected in every body
  // that carries the topic clause — the count-only badge and the full search
  // share the admitted set however the gate was sourced.
  const applyConceptEscalation = () => {
    const topicBool = (
      queryBranch as { bool: { must: Record<string, unknown>[] } }
    ).bool;
    topicBool.must = [
      {
        bool: {
          should: [
            ...topicBool.must,
            {
              terms: {
                publicationMeshUi: meshDescendantUis,
                boost: MESH_ADMIT_WEIGHT[meshTier],
              },
            },
          ],
          minimum_should_match: 1,
        },
      },
    ];
  };

  // B2 — SEARCH_PEOPLE_CONCEPT_PRECOUNT (default on = today's pre-count path).
  const conceptPrecount = resolvePeopleConceptPrecount();

  // Flag-ON (default): a dedicated size:0 pre-count of the LEXICAL predicate
  // gates the escalation up front, so the count/full bodies built below
  // dispatch once (already escalated when sparse). Mutating AFTER the pre-count
  // request was dispatched keeps that count lexical. Flag-OFF: skip the
  // dedicated pre-count — the reordered count-only and full paths below read
  // the main search's own total (already track_total_hits) and re-run escalated
  // only on sparse, dropping this hop on the common non-sparse case (the win).
  if (meshConceptEligible && conceptPrecount) {
    const preCount = await searchClient().search({
      index: PEOPLE_INDEX,
      body: {
        size: 0,
        track_total_hits: true,
        query: { bool: { must, filter: queryFilter } },
      } as object,
    });
    const lexicalTotal =
      (preCount.body as unknown as { hits: { total: { value: number } } })
        .hits.total.value;
    if (lexicalTotal < MESH_ESCALATION_THRESHOLD) applyConceptEscalation();
  }

  // Perf — count-only fast path (inactive tab). `hits.total.value` reflects
  // the query predicate (must + always-on filters); scoring, post_filter,
  // aggs, and highlight don't change it, so a bare size:0 query returns the
  // same total the full search would, far cheaper. Returns the same empty
  // shape as the no-topic short-circuit above.
  if (opts.countOnly) {
    const runCount = async () =>
      (
        (
          await searchClient().search({
            index: PEOPLE_INDEX,
            body: {
              size: 0,
              track_total_hits: true,
              query: { bool: { must, filter: queryFilter } },
            } as object,
          })
        ).body as unknown as { hits: { total: { value: number } } }
      ).hits.total.value;
    let total = await runCount();
    // Flag-OFF reorder: no up-front pre-count mutated the predicate, so the
    // count above is the LEXICAL total. Escalate + re-count only when eligible
    // and sparse — the IDENTICAL deterministic decision the flag-on pre-count
    // makes, off the same lexical predicate and threshold, so the badge equals
    // the full list under BOTH flag states. (Flag-ON already escalated up
    // front when sparse, so `runCount` returned the escalated total in one hop
    // and this never fires.)
    if (
      meshConceptEligible &&
      !conceptPrecount &&
      total < MESH_ESCALATION_THRESHOLD
    ) {
      applyConceptEscalation();
      total = await runCount();
    }
    return {
      hits: [],
      total,
      page,
      pageSize: PAGE_SIZE,
      queryShape,
      attributionBoostFired: null,
      facets: {
        deptDivs: [],
        personTypes: [],
        activity: { hasGrants: 0, recentPub: 0 },
        pi: { none: 0, any: 0, active: 0, multi: 0 },
      },
    };
  }

  const userAxisFilters: Record<string, unknown>[] = [];
  if (deptDivClause) userAxisFilters.push(deptDivClause);
  if (personTypeClause) userAxisFilters.push(personTypeClause);
  for (const c of activityClauses) userAxisFilters.push(c);
  if (piClause) userAxisFilters.push(piClause);

  // Helper: user-axis filters with one axis omitted, for that axis's
  // excluding-self aggregation. Always-on filters are inherited from the
  // main query context, so they don't appear here.
  const filtersExcept = (axis: "deptDiv" | "personType" | "activity" | "pi") => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "deptDiv" && deptDivClause) out.push(deptDivClause);
    if (axis !== "personType" && personTypeClause) out.push(personTypeClause);
    if (axis !== "activity") for (const c of activityClauses) out.push(c);
    if (axis !== "pi" && piClause) out.push(piClause);
    return out;
  };

  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "lastname") {
    // Issue #82 — preferredName is "Given Last", so its keyword sort is
    // by first name. The dedicated lastNameSort keyword on each doc
    // carries the lowercased surname (suffix-stripped) for true A–Z
    // ordering by last name.
    sortClause.push({ lastNameSort: "asc" });
  } else if (sort === "recentPub") {
    sortClause.push({ mostRecentPubDate: "desc" });
  }
  // 'relevance' uses default _score sort.

  // Per-facet "filter aggregation" pattern: each agg re-applies all filters
  // EXCEPT its own axis, so the bucket counts you see on the unticked rows
  // reflect what would happen if you ticked them in addition to the current
  // selection. Ticking another row in the same group OR's within that
  // group; ticking a row in another group AND's. Implementation lives
  // entirely in the request body — no separate round-trip per facet.
  const aggs: Record<string, unknown> = {
    deptDivs: {
      filter: { bool: { must, filter: filtersExcept("deptDiv") } },
      // 200 covers the long tail comfortably — ~30 departments × handful
      // of divisions + ~20 centers + free-text fallbacks. Labels are
      // resolved server-side in the page (see PeopleResults) so the
      // bucket key is the only thing OpenSearch needs to return.
      aggs: { keys: { terms: { field: "deptDivKey", size: 200 } } },
    },
    personTypes: {
      filter: { bool: { must, filter: filtersExcept("personType") } },
      aggs: { keys: { terms: { field: "personType", size: 10 } } },
    },
    activityHasGrants: {
      filter: {
        bool: {
          must,
          filter: [
            ...filtersExcept("activity"),
            { term: { hasActiveGrants: true } },
          ],
        },
      },
    },
    activityRecentPub: {
      filter: {
        bool: {
          must,
          filter: [
            ...filtersExcept("activity"),
            { range: { mostRecentPubDate: { gte: recentPubCutoff.toISOString() } } },
          ],
        },
      },
    },
    // Issue #233 — PI facet bucket counts. Each agg re-applies the
    // user-axis filters EXCEPT `pi`, then layers the option's own predicate
    // on top — so the count beside an unticked radio reflects what the
    // result set would be if the user picked that option (filters-except
    // pattern, matching `activityHasGrants`). `piNone` carries the
    // total-without-pi-filter so the "No filter" radio shows a baseline
    // count next to it. `piMulti` uses the current `piMin`.
    piNone: {
      filter: { bool: { must, filter: filtersExcept("pi") } },
    },
    piAny: {
      filter: {
        bool: {
          must,
          filter: [...filtersExcept("pi"), piClauseFor("any", piMin)],
        },
      },
    },
    piActive: {
      filter: {
        bool: {
          must,
          filter: [...filtersExcept("pi"), piClauseFor("active", piMin)],
        },
      },
    },
    piMulti: {
      filter: {
        bool: {
          must,
          filter: [...filtersExcept("pi"), piClauseFor("multi", piMin)],
        },
      },
    },
    // Issue #310 / SPEC §9 — `attributionBoostFired` telemetry. Counts docs in
    // the scored set (must + always-on filters, i.e. the function_score scope,
    // before post_filter) that ALSO carry a descendant UI. `doc_count > 0`
    // means the attribution boost (#726-graduated) moved at least one result.
    // Only added when the topic template is active AND the query resolved.
    ...(applyTopicTemplate && meshDescendantUis.length > 0
      ? {
          attributionMatch: {
            filter: {
              bool: {
                must,
                filter: [
                  ...queryFilter,
                  { terms: { publicationMeshUi: meshDescendantUis } },
                ],
              },
            },
          },
        }
      : {}),
  };

  // Issue #310 / SPEC §6.1.3 — the three multiplicative function_score
  // modifiers that wrap the topic-shape body. All `boost_mode: multiply`,
  // composed via `score_mode: multiply`; a function whose filter doesn't match
  // a doc contributes a factor of 1, so they compose cleanly.
  //
  //   1. Attribution: MESH_ATTRIBUTION_WEIGHT[tier] (#726: exact 1.5 /
  //      anchored-entry 1.3 / entry 1.15) for scholars whose publicationMeshUi
  //      intersects the resolved descriptor's descendantUis (the §0.3 Phase-2A
  //      mechanism). Omitted when the query didn't resolve to a descriptor.
  //   2. Productive-author: ×1.2 for >= 20 pubs, ×1.1 for [5, 20). Mutually
  //      exclusive ranges so a prolific author gets 1.2, not 1.1×1.2.
  //   3. Sparse decay (§6.1.5): ×0.7 for scholars lacking ALL of a non-trivial
  //      overview (> 200 chars), >= 3 AOI terms, and any publications. Gated
  //      off when the #152 hard cull is on (test row 7 — no double-up).
  const applySparseDecay = applyTopicTemplate && !applySparseFilter;
  const scoreFunctions: Record<string, unknown>[] = [];
  if (applyTopicTemplate) {
    if (meshDescendantUis.length > 0) {
      scoreFunctions.push({
        filter: { terms: { publicationMeshUi: meshDescendantUis } },
        // Issue #726 — graduate the former flat ×1.5 by match-type trust
        // (exact 1.5 / anchored-entry 1.3 / entry 1.15). Always-on when a
        // descriptor resolved, independent of the escalation gate above.
        weight: MESH_ATTRIBUTION_WEIGHT[meshTier],
      });
    }
    scoreFunctions.push({
      filter: { range: { publicationCount: { gte: 20 } } },
      weight: 1.2,
    });
    scoreFunctions.push({
      filter: { range: { publicationCount: { gte: 5, lt: 20 } } },
      weight: 1.1,
    });
    if (applySparseDecay) {
      scoreFunctions.push({
        filter: {
          bool: {
            must: [
              { range: { overviewLength: { lte: 200 } } },
              { range: { aoiTermCount: { lt: 3 } } },
              { term: { publicationCount: 0 } },
            ],
          },
        },
        weight: 0.7,
      });
    }
  }

  // Issue #513 / baseline §5.4 — prominence factor across all v3 shapes. The
  // composition is additive (`score_mode: sum`) so the final score is
  //   inner_score × (BASE + ln1p(FACTOR·publicationCount) + FACULTY[·faculty] + GRANT[·grant])
  // where `inner_score` is the raw text score for name / dept / hybrid, OR the
  // topic template's multiplicative inner_score for the topic shape. For topic,
  // the prominence factor is the OUTER function_score wrapping the existing
  // multiplicative attribution + productive-author + sparse-decay layer
  // (#513-followup: the deferred §5.4 calibration step). Additive-over-
  // multiplicative is load-bearing — a blunt multiplicative pub-count factor
  // composed with attribution × productivity blew up established authors
  // disproportionately ("melanoma distortion") in the §5.4 probe; nesting keeps
  // the topic-relevance shape intact and applies prominence once.
  //
  // BASE floors the multiplier at 1 so a no-pub non-faculty scholar keeps its
  // inner score rather than being zeroed by ln1p(0)=0; faculty / active-grant
  // are additive boosts that can't override a large pub-count gap.
  const applyProminence =
    applyNameTemplate ||
    applyDeptTemplate ||
    applyHybridTemplate ||
    applyTopicTemplate;
  const prominenceFunctions: Record<string, unknown>[] = applyProminence
    ? [
        { weight: PEOPLE_PROMINENCE_BASE_WEIGHT },
        {
          field_value_factor: {
            field: "publicationCount",
            modifier: "ln1p",
            factor: PEOPLE_PROMINENCE_PUBCOUNT_FACTOR,
            missing: 0,
          },
        },
        {
          filter: { term: { personType: PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE } },
          weight: PEOPLE_PROMINENCE_FACULTY_WEIGHT,
        },
        {
          filter: { term: { hasActiveGrants: true } },
          weight: PEOPLE_PROMINENCE_GRANT_WEIGHT,
        },
      ]
    : [];

  // Issue #532 — dept-shape leadership boost. Mutually exclusive with the
  // topic-shape body above (different `shape` values), so the inner
  // function_score slot is shared. `score_mode: max` so a scholar who
  // happens to be both a chair AND a chief (rare, but legal at WCM) takes
  // the stronger of the two factors rather than the product. The chief
  // filter is included for forward compatibility — today's classifier never
  // routes division-name queries to dept-shape, so the chief filter is
  // dormant on dept queries; it will fire once a future division-shape
  // (or division-name expansion to `knownDepartments`) lands.
  const applyDeptLeadershipBoost =
    applyDeptTemplate &&
    (opts.deptLeadershipBoost ?? false) &&
    trimmed.length > 0;
  const deptLeadershipFunctions: Record<string, unknown>[] = applyDeptLeadershipBoost
    ? [
        {
          filter: { term: { "leadership.chairOf": trimmed.toLowerCase() } },
          weight: PEOPLE_DEPT_LEADERSHIP_CHAIR_WEIGHT,
        },
        {
          filter: { term: { "leadership.chiefOf": trimmed.toLowerCase() } },
          weight: PEOPLE_DEPT_LEADERSHIP_CHIEF_WEIGHT,
        },
      ]
    : [];

  const baseQuery = { bool: { must, filter: queryFilter } };
  // Inner scoring: topic shape wraps `baseQuery` in the multiplicative
  // attribution + productivity + sparse-decay function_score; dept shape
  // (when the leadership boost is on) wraps it in its own multiplicative
  // leadership factor; every other shape uses the plain bool.
  const innerScoringQuery =
    applyTopicTemplate && scoreFunctions.length > 0
      ? {
          function_score: {
            query: baseQuery,
            functions: scoreFunctions,
            score_mode: "multiply",
            boost_mode: "multiply",
          },
        }
      : applyDeptLeadershipBoost
      ? {
          function_score: {
            query: baseQuery,
            functions: deptLeadershipFunctions,
            score_mode: "max",
            boost_mode: "multiply",
          },
        }
      : baseQuery;
  // Outer scoring: the additive prominence function_score wraps the inner
  // score for all v3 shapes (#513 + the §5.4 topic follow-up).
  const scoringQuery = applyProminence
    ? {
        function_score: {
          query: innerScoringQuery,
          functions: prominenceFunctions,
          score_mode: "sum",
          boost_mode: "multiply",
        },
      }
    : innerScoringQuery;

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    // Perf — return only the scalars the People hit mapper reads (verified
    // against the `Hit._source` type + the mapper below). Without this,
    // OpenSearch ships the entire `_source` per hit (incl. concatenated
    // abstracts) only to be discarded. Highlight fragments arrive on
    // `hit.highlight`, independent of `_source`, so they are unaffected.
    _source: [
      "cwid",
      "slug",
      "preferredName",
      "primaryTitle",
      "primaryDepartment",
      "deptName",
      "divisionName",
      "personType",
      "publicationCount",
      "grantCount",
      "hasActiveGrants",
      "publicationMeshUi",
      // #824 follow-up — the topic-slug rollup, returned ONLY when the
      // match-aware snippet flag is on, so the topic-reason match and the
      // humanized-areas fallback can read the scholar's areas without a highlight
      // round-trip. Off ⇒ the field is not requested (today's `_source` shape).
      ...(matchAwareSnippet ? ["areasOfInterest"] : []),
    ],
    // OpenSearch's default cap of 10000 short-circuits the total counter
    // and would make the subhead read "10,000 publications" even when
    // there are 90k. Costs more on truly broad queries but the people
    // index is small (~9k docs) so the impact is negligible.
    track_total_hits: true,
    // Issue #310 — `scoringQuery` is the plain bool for every shape except the
    // v3 topic template, which wraps it in the multiplicative function_score.
    // Aggregations keep using the un-scored `must` (counts don't need scoring).
    query: scoringQuery,
    // User-axis filters live here so aggregations see the unfiltered hit
    // set and can compute excluding-self counts. Hits returned by the
    // main response still respect every active filter (post_filter is
    // applied after aggregation but before hit emission).
    ...(userAxisFilters.length > 0
      ? { post_filter: { bool: { filter: userAxisFilters } } }
      : {}),
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
    aggs,
    highlight: {
      // The card's only highlight surface is the self-reported snippet fallback,
      // so only the three self-reported fields are highlighted. (The #702
      // pub-evidence / detection-field widening fed the now-removed
      // `pubHighlight` / `matchedOnFields` card surfaces; the per-row reason line
      // is driven by the `reasonCounts` aggregation below, not by highlighting.)
      //
      // #824 follow-up — when the match-aware snippet is active (`matchAwareContext`
      // set), the raw `areasOfInterest` highlight is REPLACED by the server-built
      // humanized-areas fallback (`buildHumanizedAreas`, emitted per hit below).
      // We must NOT request its highlight then: the flattened fragment is a raw
      // `under_score` slug dump that the card renders BEFORE `humanizedAreas`
      // (priority: method > topic > legacy > bio highlight > humanized areas), so
      // leaving it on lets the ugly slug line win. `overview` (real bio sentence)
      // stays highlighted — it's the desired snippet above humanized areas.
      fields: {
        preferredName: {},
        ...(matchAwareContext ? {} : { areasOfInterest: {} }),
        overview: {},
      },
      // Issue #692 — when demoting, restrict highlighting to the content query
      // so stripped generics ("Research") are never <mark>-ed. Without this the
      // discount clause's full query would still drive highlights. Omitted when
      // not demoting, so the default-off highlight body is unchanged.
      ...(demoteGeneric
        ? {
            highlight_query: {
              multi_match: {
                query: contentQuery,
                // Mirror the `fields` set above — drop areasOfInterest when the
                // match-aware snippet replaces it with humanized areas (#824).
                fields: matchAwareContext
                  ? ["preferredName", "overview"]
                  : ["preferredName", "areasOfInterest", "overview"],
                type: "best_fields",
                operator: "or",
              },
            },
          }
        : {}),
      pre_tags: ["<mark>"],
      post_tags: ["</mark>"],
    },
  };

  let resp = await searchClient().search({ index: PEOPLE_INDEX, body: body as object });

  // Flag-OFF reorder: the dispatch above ran the LEXICAL query (no up-front
  // pre-count mutated it). Read its own total — the body is track_total_hits —
  // and, only when eligible and sparse, escalate the SHARED query objects
  // (`body.query` resolves through `must` to `queryBranch`) and re-run the full
  // search escalated. Non-sparse is the common case and stops at one dispatch
  // (the win: the dedicated pre-count hop is gone); the rare sparse path pays a
  // second full search with aggs + hydration. Flag-ON already escalated up
  // front when sparse, so this never fires and the single dispatch stands.
  if (meshConceptEligible && !conceptPrecount) {
    const lexicalTotal =
      (resp.body as unknown as { hits: { total: { value: number } } }).hits.total
        .value;
    if (lexicalTotal < MESH_ESCALATION_THRESHOLD) {
      applyConceptEscalation();
      resp = await searchClient().search({ index: PEOPLE_INDEX, body: body as object });
    }
  }

  type Hit = {
    _source: {
      cwid: string;
      slug: string;
      preferredName: string;
      primaryTitle: string | null;
      primaryDepartment: string | null;
      deptName: string | null;
      divisionName: string | null;
      personType: string | null;
      publicationCount: number;
      grantCount: number;
      hasActiveGrants: boolean;
      // Issue #688 — descriptor UIs the scholar is tagged with (omit-on-empty
      // in the ETL). Read only for the match-provenance path; the field is
      // already in `_source` (no `_source` include-list trims it).
      publicationMeshUi?: string[];
      // #824 follow-up — space-joined topic SLUGS (e.g. "single_cell_spatial_biology
      // cell_molecular_biology"). Present only when the match-aware snippet flag
      // is on (added to `_source` above); drives the topic-reason match and the
      // humanized-areas fallback.
      areasOfInterest?: string;
    };
    highlight?: Record<string, string[]>;
  };
  type Bucket = { key: string; doc_count: number };
  const r = resp.body as unknown as {
    hits: { hits: Hit[]; total: { value: number } };
    aggregations?: {
      deptDivs?: { keys: { buckets: Bucket[] } };
      personTypes?: { keys: { buckets: Bucket[] } };
      activityHasGrants?: { doc_count: number };
      activityRecentPub?: { doc_count: number };
      piNone?: { doc_count: number };
      piAny?: { doc_count: number };
      piActive?: { doc_count: number };
      piMulti?: { doc_count: number };
      attributionMatch?: { doc_count: number };
    };
  };

  // Issue #310 / SPEC §9 — null unless the topic template ran against a
  // resolved descriptor; otherwise true iff at least one scored doc carried a
  // descendant UI (the agg counts the function_score's attribution scope).
  const attributionBoostFired =
    applyTopicTemplate && meshDescendantUis.length > 0
      ? (r.aggregations?.attributionMatch?.doc_count ?? 0) > 0
      : null;

  // Issue #688 — narrower-term match provenance. Only when the flag is on, the
  // topic template ran against a resolved descriptor with at least one
  // descendant, and we have the descriptor's display name to frame the "…
  // narrower term of {name}" string. Labels for the whole descendant set are
  // resolved once, then intersected per hit by `computeMatchProvenance`.
  const provenanceOn =
    opts.matchProvenance === true &&
    applyTopicTemplate &&
    meshDescendantUis.length > 1 &&
    (opts.meshDescriptorName?.length ?? 0) > 0;
  const provenanceLabels = provenanceOn
    ? await descriptorLabelsForUis(meshDescendantUis)
    : new Map<string, string>();
  const provenanceParent = opts.meshDescriptorName ?? "";

  // PLAN R4 — per-scholar "why this match" reason. When a concept resolved, ONE
  // aggregation on the publications index gives, per page cwid, the distinct
  // pmid count of the scholar's pubs tagged with the resolved descriptor set
  // (`tagged`) and matching the literal query in title/abstract (`mention`),
  // both exact via `cardinality` — distinct by construction, so neither can
  // exceed the scholar's total. No reindex. Skipped on the count-only badge path
  // (returned above) and under `exact` scope (empty `meshDescendantUis`).
  const reasonCounts = new Map<string, { tagged: number; mention: number }>();
  // Issue #967 — representative pub per cwid, keyed by which reason branch it
  // belongs to (tagged vs mention). Populated only under `representativePub`;
  // empty otherwise, so `composeMatchReason` attaches no `pub`.
  const reasonReps = new Map<
    string,
    { tagged?: RepresentativePub; mention?: RepresentativePub }
  >();
  const pageCwids = r.hits.hits.map((h) => h._source.cwid);
  if (
    matchExplain &&
    applyTopicTemplate &&
    meshDescendantUis.length > 0 &&
    provenanceParent.length > 0 &&
    pageCwids.length > 0
  ) {
    // Issue #967 — fetch the strongest representative pub within a reason filter:
    // most recent, then most cited. Highlight is keyed to the LITERAL query (not
    // the filter), so the title shows the matched term when it appears; a
    // descriptor-tagged title with no literal term highlights nothing and the
    // card renders plain text. Added to each filter only when the flag is on, so
    // the flag-off agg body is byte-identical to the pre-#967 shape.
    const repPubTopHits = {
      top_hits: {
        size: 1,
        sort: [
          { year: { order: "desc", missing: "_last" } },
          { citationCount: { order: "desc", missing: "_last" } },
        ],
        _source: ["pmid", "title", "year"],
        highlight: {
          fields: { title: {} },
          highlight_query: {
            multi_match: { query: contentQuery, fields: ["title"], operator: "or" },
          },
          pre_tags: ["<mark>"],
          post_tags: ["</mark>"],
        },
      },
    };
    const aggResp = await searchClient().search({
      index: PUBLICATIONS_INDEX,
      body: {
        size: 0,
        query: { bool: { filter: [{ terms: { wcmAuthorCwids: pageCwids } }] } },
        aggs: {
          byAuthor: {
            terms: { field: "wcmAuthorCwids", include: pageCwids, size: pageCwids.length },
            aggs: {
              tagged: {
                filter: { terms: { meshDescriptorUi: meshDescendantUis } },
                aggs: {
                  d: { cardinality: { field: "pmid" } },
                  ...(representativePub ? { top: repPubTopHits } : {}),
                },
              },
              mention: {
                filter: {
                  multi_match: {
                    query: contentQuery,
                    fields: ["title", "abstract"],
                    operator: "and",
                  },
                },
                aggs: {
                  d: { cardinality: { field: "pmid" } },
                  ...(representativePub ? { top: repPubTopHits } : {}),
                },
              },
            },
          },
        },
      } as object,
    });
    const buckets =
      (
        aggResp.body as {
          aggregations?: {
            byAuthor?: {
              buckets?: Array<{
                key: string;
                tagged?: { d?: { value?: number } } & ReasonTopHitsAgg;
                mention?: { d?: { value?: number } } & ReasonTopHitsAgg;
              }>;
            };
          };
        }
      ).aggregations?.byAuthor?.buckets ?? [];
    for (const b of buckets) {
      reasonCounts.set(b.key, {
        tagged: b.tagged?.d?.value ?? 0,
        mention: b.mention?.d?.value ?? 0,
      });
      if (representativePub) {
        reasonReps.set(b.key, {
          tagged: parseReasonTopHit(b.tagged),
          mention: parseReasonTopHit(b.mention),
        });
      }
    }
  }

  // #824 follow-up — match-aware snippet derivation. All query-time; no reindex.
  //   methodReasonByCwid — per-scholar method-family reason ({ kind:"method" }).
  //     ONE batched `scholar_family` query over the page cwids for the resolved
  //     `(supercategory, familyLabel)`, overlay-gated so a #800-suppressed /
  //     #801-sensitive family NEVER surfaces (same invariant as the index emit).
  //   matchedTopicSlugs / topicLabelByMatchedSlug — drive { kind:"topic" }.
  //   topicLabelBySlug — slug→`Topic.label` map for the humanized-areas fallback.
  // Guarded by `matchAwareContext` (already null when the flag is off), so the
  // off path runs none of this and adds no query.
  const methodReasonByCwid = new Map<string, { family: string; tools: string[] }>();
  const matchedTopicSlugs = new Set<string>();
  const topicLabelByMatchedSlug = new Map<string, string>();
  const topicLabelBySlug = new Map<string, string>();
  if (matchAwareContext && pageCwids.length > 0) {
    const family = matchAwareContext.methodFamily;
    if (family) {
      // The overlay gate forces sensitive loading (#824 §4c): the public people
      // surface must exclude #801-sensitive families regardless of the runtime
      // sensitivity flag. SKIP the whole query when the resolved family is not
      // publicly visible — suppressed/sensitive must never surface here.
      const gate = await loadFamilyOverlayGate({ forceSensitive: true });
      if (isFamilyPubliclyVisible(family.supercategory, family.familyLabel, gate)) {
        const rows = await prisma.scholarFamily.findMany({
          where: {
            cwid: { in: pageCwids },
            supercategory: family.supercategory,
            familyLabel: family.familyLabel,
            scholar: { deletedAt: null, status: "active" },
          },
          select: { cwid: true, familyLabel: true, exemplarTools: true },
        });
        for (const row of rows) {
          // One row per (cwid, family) via the @@unique, so first-wins is exact.
          if (methodReasonByCwid.has(row.cwid)) continue;
          methodReasonByCwid.set(row.cwid, {
            family: row.familyLabel,
            tools: cleanExemplarTools(row.exemplarTools),
          });
        }
      }
    }

    const topics = matchAwareContext.topics ?? [];
    for (const t of topics) {
      if (t.slug) {
        matchedTopicSlugs.add(t.slug);
        topicLabelByMatchedSlug.set(t.slug, t.label);
      }
    }

    // Real `Topic.id`→`Topic.label` map for the humanized-areas fallback (no
    // under_scores). `areasOfInterest` is a space-join of `Topic.id` slugs, so a
    // single `topic.findMany` resolves every area to its curated label; unknown
    // slugs fall back to `humanizeAreaSlug`.
    const topicRows = await prisma.topic.findMany({ select: { id: true, label: true } });
    for (const tr of topicRows) topicLabelBySlug.set(tr.id, tr.label);
  }

  // Strongest-signal reason: pub-evidence count (document) → concept fallback
  // (sparkle). Delegates to the pure `composeMatchReason` (count cap +
  // precedence + #967 representative-pub attach).
  const buildMatchReason = (
    cwid: string,
    pubCount: number,
    hasProvenance: boolean,
  ): PeopleHit["matchReason"] =>
    composeMatchReason({
      counts: reasonCounts.get(cwid),
      rep: reasonReps.get(cwid),
      pubCount,
      hasProvenance,
      provenanceParent,
      contentQuery,
    });

  // #824 follow-up — pick the per-hit reason with the match-aware PRIORITY:
  // method > topic > (legacy concept/pub reason). Off ⇒ `matchAwareContext` is
  // null, both new branches are skipped, and this returns `buildMatchReason` —
  // byte-identical to today.
  const resolveHitMatchReason = (
    cwid: string,
    areasOfInterest: string | undefined,
    pubCount: number,
    hasProvenance: boolean,
  ): PeopleHit["matchReason"] => {
    if (matchAwareContext) {
      const method = methodReasonByCwid.get(cwid);
      if (method) return { kind: "method", family: method.family, tools: method.tools };
      if (matchedTopicSlugs.size > 0 && areasOfInterest) {
        const areaSlugs = areasOfInterest.trim().split(/\s+/).filter(Boolean);
        const hitSlug = areaSlugs.find((s) => matchedTopicSlugs.has(s));
        if (hitSlug) {
          return { kind: "topic", label: topicLabelByMatchedSlug.get(hitSlug) ?? hitSlug };
        }
      }
    }
    return buildMatchReason(cwid, pubCount, hasProvenance);
  };

  return {
    hits: r.hits.hits.map((h) => {
      const hl = h.highlight;
      // The self-reported fields are highlighted (see the request body above):
      // {preferredName, areasOfInterest, overview} normally, or {preferredName,
      // overview} when the match-aware snippet is active (areasOfInterest is then
      // surfaced as the humanized-areas fallback, never a raw slug highlight).
      // The flattened fragments are the self snippet the card falls back to when
      // no `matchReason` was computed.
      const highlight = hl ? Object.values(hl).flat() : undefined;
      // `prov` still feeds the per-row reason (`buildMatchReason`, concept
      // fallback); it is no longer surfaced as a hit field of its own.
      const prov = provenanceOn
        ? computeMatchProvenance({
            publicationMeshUi: h._source.publicationMeshUi,
            descendantUis: meshDescendantUis,
            parentTerm: provenanceParent,
            labels: provenanceLabels,
          })
        : undefined;
      return {
        cwid: h._source.cwid,
        slug: h._source.slug,
        preferredName: h._source.preferredName,
        primaryTitle: h._source.primaryTitle,
        primaryDepartment: h._source.primaryDepartment,
        deptName: h._source.deptName ?? h._source.primaryDepartment,
        divisionName: h._source.divisionName,
        roleCategory: h._source.personType,
        pubCount: h._source.publicationCount,
        grantCount: h._source.grantCount,
        hasActiveGrants: h._source.hasActiveGrants,
        identityImageEndpoint: identityImageEndpoint(h._source.cwid),
        highlight,
        matchReason: resolveHitMatchReason(
          h._source.cwid,
          h._source.areasOfInterest,
          h._source.publicationCount,
          prov != null,
        ),
        // #824 follow-up — humanized research-areas fallback (no under_scores),
        // emitted only when the flag is on. The card renders it as the last-resort
        // snippet line when no method/topic/concept/pub reason fires and no bio
        // highlight is present; null/absent when off (card falls back to today's
        // raw slug highlight).
        ...(matchAwareContext
          ? (() => {
              const ha = buildHumanizedAreas(
                h._source.areasOfInterest,
                topicLabelBySlug,
                matchedTopicSlugs,
              );
              return ha ? { humanizedAreas: ha } : {};
            })()
          : {}),
      };
    }),
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    queryShape,
    attributionBoostFired,
    facets: {
      deptDivs: (r.aggregations?.deptDivs?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        // Label is resolved server-side in the page (PeopleResults) by
        // joining b.value against Department / Division / Center via
        // Prisma. Returning the raw key as a fallback keeps callers that
        // don't resolve labels (e.g. the analytics log) intelligible.
        label: b.key,
        count: b.doc_count,
      })),
      personTypes: (r.aggregations?.personTypes?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      activity: {
        hasGrants: r.aggregations?.activityHasGrants?.doc_count ?? 0,
        recentPub: r.aggregations?.activityRecentPub?.doc_count ?? 0,
      },
      pi: {
        none: r.aggregations?.piNone?.doc_count ?? 0,
        any: r.aggregations?.piAny?.doc_count ?? 0,
        active: r.aggregations?.piActive?.doc_count ?? 0,
        multi: r.aggregations?.piMulti?.doc_count ?? 0,
      },
    },
  };
}

export async function searchPublications(opts: {
  q: string;
  page?: number;
  sort?: PublicationsSort;
  filters?: PublicationsFilters;
  /**
   * Issue #259 §5 — when set AND `SEARCH_PUB_TAB_CONCEPT_MODE=strict` (or
   * `=expanded` with `meshStrict: true`), the query is restructured as
   * `must(MeSH-evidence OR ReciterAI-evidence) + should(BM25 free-text)`.
   * Null/undefined → no restructure, byte-identical to the §1.2 shape.
   */
  meshResolution?: MeshResolution | null;
  /**
   * Issue #259 SPEC §5.1 + §6.1. When true AND the active concept mode is
   * `expanded`, the function falls back to today's `concept_filtered` /
   * `concept_fallback` body (chip's "Narrow to this concept only" opt-in).
   * Under `strict` mode this is a no-op (already strict); under `off` mode
   * this is ignored (resolution is suppressed upstream by the route handler
   * setting `meshResolution: null`, same pattern as `?mesh=off`).
   *
   * Source: `?mesh=strict` URL param, parsed in `app/api/search/route.ts`
   * and `app/(public)/search/page.tsx` via `parseMeshParam`.
   */
  meshStrict?: boolean;
  /**
   * Perf — count-only mode for the inactive search tabs. See the
   * `searchPeople` `countOnly` doc: skips the facet aggregations and the
   * Prisma author/co-author hydration (the dominant cost on this corpus),
   * returning just `total` for the tab badge. The total is computed from
   * the same query predicate, so the badge is identical to a full search.
   */
  countOnly?: boolean;
  /**
   * Perf — hits-only mode for the sparse/empty concept-fallback preview
   * (`#298`, gated by `resolveConceptFallbackSparseEnabled`). Like `countOnly`
   * it omits the OpenSearch `aggs` block and the ≤500-row facet
   * `scholar.findMany` (the wcmAuthors-bucket hydration) — the dominant cost —
   * but UNLIKE `countOnly` it keeps `size`, scoring, and per-hit hydration
   * (`fetchWcmAuthorsForPmids` / `fetchAuthorBylineForPmids` / impact) so the
   * returned `hits` render in the fallback preview. `total` + hit order are
   * byte-identical to a full search (same `query` / `post_filter` / sort);
   * `facets` come back empty (every reader is `?.… ?? []`) and the caller
   * discards them. Mentoring buckets are loaded only when a `mentoringPrograms`
   * filter is active (so the filtered total stays correct); otherwise the
   * stall-prone ReciterDB round-trip is skipped too.
   */
  hitsOnly?: boolean;
  /**
   * Issue #645 — injectable "current year" for the recency-decay origin (§7 of
   * the spec). Defaults to `new Date().getUTCFullYear()`. Tests pass a fixed
   * value so the emitted `gauss.year.origin` (and the §5.4 calibration) is
   * deterministic without leaning on fake timers.
   */
  nowYear?: number;
  /**
   * Issue #692 — generic-term demotion (mode `on`). When true and `contentQuery`
   * differs from the raw query, the BM25-over-surface-query clauses score on the
   * content query (full query discounted). The descriptor-name / MeSH-terms
   * clauses are unaffected (they already score on `resolution.name`). Default
   * false → byte-identical body.
   */
  genericDemote?: boolean;
  /** Issue #692 — query with deprioritized filler tokens removed (computed in
   *  the route). Only consumed when `genericDemote` is true. */
  contentQuery?: string;
  /**
   * `SEARCH_PUB_HIGHLIGHT` resolved at request time by the route. When true, the
   * body requests a `title` highlight (on the content query when demoting) and
   * each hit carries `titleHighlight`. Pure presentation metadata — it only adds
   * a `highlight` clause; the query predicate, scoring, and result set are
   * unchanged. Headless callers default to `false`.
   */
  highlightMatches?: boolean;
  /**
   * Issue #707 — `SEARCH_PUB_MATCH_PROVENANCE` resolved at request time. When
   * true and `meshResolution` is non-null, each hit tagged with the resolved
   * descriptor or a narrower descendant carries `matchProvenance`. Pure additive
   * metadata; no effect on the query, scoring, or result set. Default `false`.
   */
  matchProvenance?: boolean;
}): Promise<PublicationsSearchResult> {
  const { q, page = 0 } = opts;
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();

  // Issue #692 — generic-term demotion, active only with a real content/full
  // split. Off → `contentQuery === trimmed` and every demote-gated clause keeps
  // its original inline shape.
  const demoteGeneric =
    opts.genericDemote === true &&
    !!opts.contentQuery &&
    opts.contentQuery !== trimmed;
  const contentQuery = demoteGeneric ? (opts.contentQuery as string) : trimmed;

  // SEARCH_PUB_HIGHLIGHT — request a title highlight so the row can show which
  // terms matched. Default-off ⇒ the body below is byte-identical to today.
  const highlightMatches = opts.highlightMatches === true;
  // #707 — the *significant* query for highlighting: the full query with the
  // 251-term academic-common set (`deprioritized-terms.json`) stripped, so a
  // near-stopword like "research" never lights up scattered across a title set
  // (where its document frequency makes the color carry no information). The
  // route always passes this as `contentQuery`; fall back to the full query when
  // a headless caller omits it, or when every token is generic (strip-to-empty).
  // Decoupled from `demoteGeneric` on purpose — gating highlights by term
  // significance is the right default regardless of the ranking-demote flag.
  const highlightSignificantQuery =
    opts.contentQuery && opts.contentQuery.length > 0 ? opts.contentQuery : trimmed;

  // Issue #259 §1.2 — pub-tab minimum_should_match floor. Now default-on
  // after prod verification of the >50% p95 cut for resolved-concept
  // queries (#261 shipped flag-off; this is the promised default flip).
  // Separate flag from SEARCH_PEOPLE_QUERY_RESTRUCTURE because spec §1.12
  // attaches surface-specific rollback triggers — pub-tab has the "p95 < 50"
  // over-tightening floor, people-tab has the count-cut acceptance — and
  // separable rollback means flipping one off without disturbing the other.
  // Set SEARCH_PUB_TAB_MSM=off as an emergency rollback without redeploying.
  const usePubMsm =
    (process.env.SEARCH_PUB_TAB_MSM ?? "on") === "on";

  // Issue #837 — Department facet. Default OFF; flipping requires the
  // publications index to have been reindexed with `wcmAuthorDepartments`
  // (reindex-then-flip). When off, the department filter is ignored and the
  // department facet aggregation is skipped (empty buckets), so a stale URL
  // param or a not-yet-reindexed cluster can't surface an empty rail.
  const useDepartmentFilter = resolvePublicationDepartmentFilter();

  // Issue #259 §5 / §7.1 — pub-tab concept mode. Three values:
  //   `strict`   — pre-PR-3 `concept_filtered` / `concept_fallback` admission
  //                shape (rollback target).
  //   `expanded` — §5.2 `concept_expanded` shape. MeSH adds, never gates.
  //                **Default since PR-4.**
  //   `off`      — pre-§1.6 fallback. `restructured_msm` for resolved queries
  //                (resolution is logged but not applied).
  // Resolution lives in `lib/api/search-flags.ts` so route handler + SSR
  // page agree.
  const conceptMode = resolveConceptMode();
  const resolution = opts.meshResolution ?? null;
  const meshStrict = opts.meshStrict ?? false;

  // Issue #259 §1.8 — impactScore display + three-way sort. Flag default-OFF;
  // flip requires the publications index to have been reindexed with the
  // new `impactScore` + `topicImpacts` fields. Flag controls API exposure
  // only: when off, hit-level `impactScore` and `conceptImpactScore` are
  // forced to null and new sort values (`impact` / `recency`) fall through
  // to relevance. ETL writes the fields unconditionally so flipping the
  // flag on requires no reindex if the data was already loaded with the
  // §1.8 ETL build.
  const useImpact =
    (process.env.SEARCH_PUB_TAB_IMPACT ?? "off") === "on";

  // Issue #645 — recency tilt on the Relevance sort. Resolved here (route
  // handler + SSR page share the resolver) so the server-rendered list and any
  // follow-up /api/search call rank identically. Only applied on the relevance
  // path (empty sortClause) below.
  const recencyMode = resolvePubRecencyMode();

  let queryShape: PublicationsQueryShape;
  const must: Record<string, unknown>[] = [];
  const topLevelShould: Record<string, unknown>[] = [];

  if (trimmed.length === 0) {
    must.push({ match_all: {} });
    queryShape = usePubMsm ? "restructured_msm" : "legacy_multi_match";
  } else if (
    // §5.2 `concept_expanded` admission. Engaged only under:
    //   - flag = `expanded`
    //   - resolution non-null
    //   - chip-narrow opt-in NOT set (`?mesh=strict` would force strict)
    //   - `descendantUis` populated (PR 2's invariant guarantees ≥ 1; the
    //     length check is a belt-and-braces against malformed
    //     `terms { meshDescriptorUi: [] }` at OpenSearch).
    // The predicate lives in the branch condition (not inside the body)
    // so TypeScript narrows `resolution` to non-null AND an empty
    // descendant set falls through to the trailing `else`, where the
    // §1.2 builder + the `concept_expanded_invariant_violated` log fire
    // together as a single coherent fall-back.
    conceptMode === "expanded" &&
    resolution !== null &&
    !meshStrict &&
    resolution.descendantUis.length > 0
  ) {
    queryShape = "concept_expanded";
    // Clause 1: BM25 over the original surface query. Same fields/boosts
    // as the §1.2 multi_match — preserves token-coverage signal.
    // Issue #692 — score on the content query (full query discounted) when demoting.
    topLevelShould.push(
      demoteGeneric
        ? demoteScoringClause({
            contentQuery,
            fullQuery: trimmed,
            fields: [...PUBLICATION_FIELD_BOOSTS],
            type: "best_fields",
            msm: PUBLICATIONS_RESTRUCTURED_MSM,
            boost: 1,
          })
        : {
            multi_match: {
              query: trimmed,
              fields: [...PUBLICATION_FIELD_BOOSTS],
              type: "best_fields",
              operator: "or",
              minimum_should_match: PUBLICATIONS_RESTRUCTURED_MSM,
              boost: 1,
            },
          },
    );
    // Clause 2: parallel BM25 over the descriptor's canonical name. Token
    // count drawn from `resolution.name` only (NOT the entry-term list)
    // so msm is computed against name-tokens, avoiding cross-contamination
    // with the surface query's tokens (§5.5). Always emitted when
    // resolution is non-null — even when name === q (snapshot byte-stability).
    topLevelShould.push({
      multi_match: {
        query: resolution.name,
        fields: [...PUBLICATION_FIELD_BOOSTS],
        type: "best_fields",
        operator: "or",
        minimum_should_match: PUBLICATIONS_RESTRUCTURED_MSM,
        boost: 1,
      },
    });
    // Clause 3: terms on the descriptor + descendants. PR 2's eager
    // precompute populates `descendantUis` with self at index 0, bounded
    // at DESCENDANT_HARD_CAP (200). Read as-is; no re-cap here.
    topLevelShould.push({
      terms: {
        meshDescriptorUi: resolution.descendantUis,
        boost: 8,
      },
    });
    // Clause 4: anchor terms, omitted when empty (§1.4 hasn't seeded
    // this descriptor yet, or it's a narrow leaf with no curated coverage).
    if (resolution.curatedTopicAnchors.length > 0) {
      topLevelShould.push({
        terms: {
          reciterParentTopicId: resolution.curatedTopicAnchors,
          boost: 6,
        },
      });
    }
    // No `must` clause: admission lives entirely in the top-level should
    // + minimum_should_match: 1 (emitted by the body assembly below). The
    // empty-must spread below omits the key, matching SPEC §5.2's literal
    // body.
  } else if (
    // §1.6 strict-admission path. Engaged under:
    //   - flag = `strict` with a resolution
    //   - flag = `expanded` with chip-narrow opt-in (`?mesh=strict`) and a resolution
    // Body byte-identical to today's prod `concept_filtered` / `concept_fallback`.
    resolution !== null &&
    (conceptMode === "strict" || (conceptMode === "expanded" && meshStrict))
  ) {
    // Path A: match_phrase chosen per spec footnote. The pre-merge probe
    // against pmid 25848412 verifies the analyzed `meshTerms` stream
    // injects position gaps between distinct MeSH terms so this works.
    const pathA = {
      match_phrase: { meshTerms: { query: resolution.name, boost: 8 } },
    };
    const evidenceShould: Record<string, unknown>[] = [pathA];
    if (resolution.curatedTopicAnchors.length > 0) {
      // Path B: ReciterAI evidence. Flat-score by design — a doc matching
      // N anchors scores the same as a doc matching 1. Admission is what
      // matters; ordering across the admitted set comes from the top-level
      // BM25 should-clause.
      evidenceShould.push({
        terms: {
          reciterParentTopicId: resolution.curatedTopicAnchors,
          boost: 6,
        },
      });
      queryShape = "concept_filtered";
    } else {
      // Anchors empty: Path A alone, admission is MeSH-only.
      queryShape = "concept_fallback";
    }
    must.push({
      bool: { should: evidenceShould, minimum_should_match: 1 },
    });
    // Issue #692 — score on the content query (full query discounted) when demoting.
    topLevelShould.push(
      demoteGeneric
        ? demoteScoringClause({
            contentQuery,
            fullQuery: trimmed,
            fields: [...PUBLICATION_FIELD_BOOSTS],
            type: "best_fields",
            msm: PUBLICATIONS_RESTRUCTURED_MSM,
          })
        : {
            multi_match: {
              query: trimmed,
              fields: [...PUBLICATION_FIELD_BOOSTS],
              type: "best_fields",
              operator: "or",
              minimum_should_match: PUBLICATIONS_RESTRUCTURED_MSM,
            },
          },
    );
  } else {
    // §1.2 path. Catches:
    //   - resolution null (mesh=off, no match, under-3-char)
    //   - conceptMode=off (with or without resolution)
    //   - PR 2 invariant violation: expanded + resolution + !meshStrict
    //     + empty `descendantUis`. The expanded branch's condition includes
    //     `descendantUis.length > 0`, so the empty case falls through to
    //     here. Log loudly before constructing the §1.2 body so the
    //     regression is observable (silent fall-through would mask a PR 2
    //     contract break).
    if (
      conceptMode === "expanded" &&
      resolution !== null &&
      !meshStrict &&
      resolution.descendantUis.length === 0
    ) {
      console.error(
        JSON.stringify({
          event: "concept_expanded_invariant_violated",
          reason: "empty_descendantUis",
          descriptorUi: resolution.descriptorUi,
          confidence: resolution.confidence,
        }),
      );
    }
    // Issue #692 — score on the content query (full query discounted) when demoting.
    must.push(
      demoteGeneric
        ? demoteScoringClause({
            contentQuery,
            fullQuery: trimmed,
            fields: [...PUBLICATION_FIELD_BOOSTS],
            type: "best_fields",
            msm: usePubMsm ? PUBLICATIONS_RESTRUCTURED_MSM : undefined,
          })
        : {
            multi_match: {
              query: trimmed,
              fields: [...PUBLICATION_FIELD_BOOSTS],
              type: "best_fields",
              ...(usePubMsm
                ? {
                    operator: "or",
                    minimum_should_match: PUBLICATIONS_RESTRUCTURED_MSM,
                  }
                : {}),
            },
          },
    );
    queryShape = usePubMsm ? "restructured_msm" : "legacy_multi_match";
  }

  // Build named filter clauses so per-facet aggs can re-apply every OTHER
  // axis (same excluding-self pattern as searchPeople).
  const yearClause = (() => {
    if (filters.yearMin === undefined && filters.yearMax === undefined) return null;
    const range: Record<string, number> = {};
    if (filters.yearMin !== undefined) range.gte = filters.yearMin;
    if (filters.yearMax !== undefined) range.lte = filters.yearMax;
    return { range: { year: range } };
  })();
  const publicationTypeClause = filters.publicationType
    ? { term: { publicationType: filters.publicationType } }
    : null;
  const journalClause = filters.journal && filters.journal.length > 0
    ? { terms: { "journal.keyword": filters.journal } }
    : null;
  const wcmRoleClause = filters.wcmAuthorRole && filters.wcmAuthorRole.length > 0
    ? { terms: { wcmAuthorPositions: filters.wcmAuthorRole } }
    : null;
  const wcmAuthorClause = filters.wcmAuthor && filters.wcmAuthor.length > 0
    ? { terms: { wcmAuthorCwids: filters.wcmAuthor } }
    : null;
  // Issue #837 — WCM-author department filter (union attribution). Gated on
  // the flag so the field's absence pre-reindex can never empty the result
  // set: off → null clause (axis ignored) even if a stale `?department=` URL
  // is present.
  const departmentClause =
    useDepartmentFilter && filters.department && filters.department.length > 0
      ? { terms: { wcmAuthorDepartments: filters.department } }
      : null;
  // Mentoring activity facet — union the precomputed pmid sets for the
  // selected program buckets. Empty union (e.g. all programs empty) becomes
  // a match_none clause so a stale-cache state returns zero rows rather
  // than all rows.
  //
  // Load the buckets on the full faceted render (not just when filtering) so we
  // can compute per-bucket contextual counts for the sidebar (the mentoring
  // facet agg below). They're cached 10 min and the refresh is now time-capped,
  // so an unreachable ReciterDB degrades to empty buckets fast instead of
  // stalling the render.
  //
  // The count-only badge path (inactive tabs) returns at the `countOnly`
  // short-circuit below and never reads the buckets, so skip the load there
  // entirely. Otherwise every /search render pays the ReciterDB round-trip once
  // per inactive-tab badge -- and when ReciterDB is unreachable that burns the
  // mariadb pool's ~10s acquireTimeout on each, the root cause of the /search
  // SSR stall.
  const mentoringPrograms = filters.mentoringPrograms ?? [];
  // Perf (B4 hits-only fallback) — `getMentoringPmidBuckets()` is the ReciterDB
  // round-trip the comment above flags as the /search SSR stall source.
  // `countOnly` skips it (the badge never reads buckets); `hitsOnly` skips it
  // too UNLESS a mentoring filter is active, in which case the buckets are
  // needed to build `mentoringPmids` so the broad total/hits honor the filter
  // (an active filter with an empty bucket set collapses to `match_none` below).
  const mentoringBuckets =
    opts.countOnly || (opts.hitsOnly === true && mentoringPrograms.length === 0)
      ? EMPTY_MENTORING_BUCKETS
      : await getMentoringPmidBuckets();
  const mentoringPmids = mentoringPrograms.length > 0
    ? Array.from(new Set(mentoringPrograms.flatMap((p) => mentoringBuckets.byProgram[p] ?? [])))
    : [];
  const mentoringClause = mentoringPrograms.length > 0
    ? mentoringPmids.length > 0
      ? { terms: { pmid: mentoringPmids } }
      : { match_none: {} }
    : null;

  // Same split as searchPeople: all axes here are user-controlled, so they
  // all go in post_filter; the main query carries only the multi_match.
  // This lets each per-facet agg compute excluding-self counts without
  // being collapsed to the active selection.
  const userAxisFilters: Record<string, unknown>[] = [];
  if (yearClause) userAxisFilters.push(yearClause);
  if (publicationTypeClause) userAxisFilters.push(publicationTypeClause);
  if (journalClause) userAxisFilters.push(journalClause);
  if (wcmRoleClause) userAxisFilters.push(wcmRoleClause);
  if (wcmAuthorClause) userAxisFilters.push(wcmAuthorClause);
  if (departmentClause) userAxisFilters.push(departmentClause);
  if (mentoringClause) userAxisFilters.push(mentoringClause);

  const filtersExcept = (
    axis:
      | "year"
      | "publicationType"
      | "journal"
      | "wcmAuthorRole"
      | "wcmAuthor"
      | "department"
      | "mentoring",
  ) => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "year" && yearClause) out.push(yearClause);
    if (axis !== "publicationType" && publicationTypeClause) out.push(publicationTypeClause);
    if (axis !== "journal" && journalClause) out.push(journalClause);
    if (axis !== "wcmAuthorRole" && wcmRoleClause) out.push(wcmRoleClause);
    if (axis !== "wcmAuthor" && wcmAuthorClause) out.push(wcmAuthorClause);
    if (axis !== "department" && departmentClause) out.push(departmentClause);
    if (axis !== "mentoring" && mentoringClause) out.push(mentoringClause);
    return out;
  };

  // Issue #259 §1.8 — pub-tab sort. Under the §1.8 flag the visible options
  // are Relevance / Impact / Recency; the legacy `year` and `citations`
  // values keep working for back-compat URLs regardless of flag state.
  // Off-flag callers passing `impact` or `recency` fall through to
  // relevance (no sort clause) — the new values aren't surfaced in the
  // dropdown when the flag is off, but a hand-crafted URL shouldn't 500.
  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "year") {
    sortClause.push({ year: "desc" });
  } else if (sort === "citations") {
    sortClause.push({ citationCount: "desc" });
  } else if (useImpact && sort === "impact") {
    // impactScore desc; stable tiebreak on pmid so paging is deterministic
    // across pages where many docs share an impact value.
    sortClause.push({ impactScore: "desc" });
    sortClause.push({ pmid: "asc" });
  } else if (useImpact && sort === "recency") {
    // Spec §1.8: year desc, tiebreak on dateAddedToEntrez.
    sortClause.push({ year: "desc" });
    sortClause.push({ dateAddedToEntrez: "desc" });
  }

  // Issue #259 §5.2 — facet aggs must mirror the admission shape:
  //   - strict / §1.2: must carries the admission clause; filter adds the
  //     other axes (today's `must`-only contract).
  //   - concept_expanded: should + msm=1 carries the admission; filter adds
  //     the other axes (`must` is empty so it would short-circuit to
  //     match-all, producing a wrong denominator).
  //
  // Scope caveat — filter-context aggregations only. Every current agg is a
  // filter-context `terms` / `filter` / `filters` aggregation: admission
  // count is what matters, scoring contribution is irrelevant. Filter
  // clauses don't score, so the `should`-with-msm shape admits the same
  // docs as `must` would while contributing zero to `_score`. Aggs that
  // consume `_score` (e.g. `top_hits` with `_score` sort, `significant_terms`)
  // would behave differently between modes and silently break the cross-mode
  // equivalence — none exist today; a future addition needs a
  // `must: { match_all }` + `should` + `msm: 1` + `filter` shape that
  // promotes admission into a scoring path.
  //
  // Closure captures: `queryShape`, `topLevelShould`, `must`. The msm
  // value is the literal `1` (the only value SPEC §5.2 specifies); not
  // threaded through a variable so a future rename can't accidentally
  // serialize `minimum_should_match: undefined`.
  const aggBoolFor = (
    filter: Record<string, unknown>[],
  ): Record<string, unknown> => {
    if (queryShape === "concept_expanded") {
      return {
        bool: {
          should: topLevelShould,
          minimum_should_match: 1,
          filter,
        },
      };
    }
    return { bool: { must, filter } };
  };

  const query = {
    bool: {
      // §5.2 — `concept_expanded` admission lives entirely in the
      // top-level should, so `must` is empty in that branch. Spread
      // conditionally so the body omits the `must` key (matches SPEC
      // §5.2's literal). Strict / §1.2 paths always populate `must`,
      // so this is a no-op for them — strict-mode body remains
      // byte-identical to pre-PR-3 (§7.2 rollback target).
      ...(must.length > 0 ? { must } : {}),
      // §1.6 — top-level BM25 scoring clause under strict modes; empty
      // array spreads to nothing so the §1.2 path produces a byte-
      // identical body.
      ...(topLevelShould.length > 0 ? { should: topLevelShould } : {}),
      // §5.2 — minimum_should_match: 1 only under `concept_expanded`
      // (the only shape where should-as-admission carries msm at the
      // outer bool). Strict-mode top-level `should` is BM25-scoring-
      // only; adding msm there would break the §7.2 byte-identical
      // guarantee.
      ...(queryShape === "concept_expanded" ? { minimum_should_match: 1 } : {}),
    },
  };

  // Perf — count-only fast path (inactive tab). Same `query` as the full
  // body, so the badge total is identical; skips the facet aggregations and
  // the Prisma author / co-author hydration below.
  if (opts.countOnly) {
    const countResp = await searchClient().search({
      index: PUBLICATIONS_INDEX,
      body: { size: 0, track_total_hits: true, query } as object,
    });
    const total =
      (countResp.body as unknown as { hits: { total: { value: number } } })
        .hits.total.value;
    return {
      hits: [],
      total,
      page,
      pageSize: PAGE_SIZE,
      queryShape,
      meshDescendantSetSize: resolution?.descendantUis.length ?? null,
      meshAnchorCount: resolution?.curatedTopicAnchors.length ?? null,
      // §645 — count path scores nothing (size:0, unwrapped `query`), so the
      // tilt is reported as resolved-but-not-applied.
      recencyMode,
      recencyOriginYear: null,
      facets: {
        publicationTypes: [],
        journals: [],
        wcmAuthorRoles: { first: 0, senior: 0, middle: 0 },
        wcmAuthors: [],
        wcmAuthorsTotal: 0,
        mentoringPrograms: { md: 0, mdphd: 0, phd: 0, postdoc: 0, ecr: 0 },
        departments: [],
      },
    };
  }

  // Issue #645 — recency tilt. Wrap the relevance-path query in a
  // `function_score` Gaussian decay on `year` so keyword match stays primary
  // while recent papers get a bounded lift (§5 of the spec). Mirrors the
  // People-tab dept-leadership wrapper (`searchPeople`, same file): wrapping the
  // whole `query` object is shape-agnostic, so a stale paper admitted via a
  // MeSH descendant (concept_expanded) is damped too.
  //
  // Applied ONLY when:
  //   - the mode is not `off`, AND
  //   - this is the relevance path (no explicit sort). An explicit
  //     year/citations/impact/recency sort overrides `_score` anyway, so we
  //     skip the wrapper to keep those bodies byte-identical and avoid paying
  //     for scoring we'd discard.
  // The count path above is intentionally left on the unwrapped `query`.
  const applyRecency = recencyMode !== "off" && sortClause.length === 0;
  const recencyOriginYear = applyRecency
    ? opts.nowYear ?? new Date().getUTCFullYear()
    : null;
  // The gauss term is gated by an `exists: year` filter so a missing/null
  // `year` (rare; `publication.year` is nullable) contributes nothing rather
  // than OpenSearch's neutral 1.0 — under `gentle`'s additive `sum` that 1.0
  // would otherwise read as max freshness (1 + W·1 = 3×) and float unknown-date
  // papers to the top. With the filter, a missing-year doc falls back to the
  // constant floor (1×) under `gentle` and to the no-function neutral (1×)
  // under `strong`.
  const recencyGauss = {
    filter: { exists: { field: "year" } },
    gauss: {
      year: { origin: recencyOriginYear, offset: 2, scale: 8, decay: 0.5 },
    },
  };
  const scoredQuery = !applyRecency
    ? query
    : recencyMode === "gentle"
      ? {
          // final = bm25 × (1 + W·gauss),  W = 2  → multiplier ∈ [1, 3]
          function_score: {
            query,
            functions: [{ weight: 1 }, { ...recencyGauss, weight: 2 }],
            score_mode: "sum",
            boost_mode: "multiply",
          },
        }
      : {
          // `strong`: final = bm25 × gauss (no floor; damps old papers toward 0)
          function_score: {
            query,
            functions: [recencyGauss],
            score_mode: "multiply",
            boost_mode: "multiply",
          },
        };

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    // OpenSearch's default cap of 10000 short-circuits the total counter
    // and would make the subhead read "10,000 publications" even when
    // there are 90k+. Larger publications index (~90k docs) so this
    // counts a few thousand extra docs on broad queries, but it's needed
    // for an accurate count line.
    track_total_hits: true,
    // §645 — `scoredQuery` is the recency-wrapped query on the relevance path,
    // otherwise the plain `query`. Aggregations below keep using the unscored
    // `aggBoolFor` (counts don't need scoring), so facet counts are unaffected.
    query: scoredQuery,
    // post_filter applies all user-axis filters to hits AFTER the
    // aggregations run, so each per-facet agg can compute correct
    // excluding-self counts (see searchPeople for the rationale).
    ...(userAxisFilters.length > 0
      ? { post_filter: { bool: { filter: userAxisFilters } } }
      : {}),
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
    // SEARCH_PUB_HIGHLIGHT — mark the matched terms in the title so the row shows
    // why it matched. The `highlight_query` (always present, not the raw query)
    // does two things the naive per-token highlighter can't:
    //   1. Significance gating — `match` runs only the SIGNIFICANT query, so a
    //      near-stopword generic ("research") scattered through a title is never
    //      marked; it carries no information at academic-title document
    //      frequencies. (The match clauses are analyzed by the field analyzer,
    //      so the highlighter marks exactly the stemmed forms the ranker matched
    //      — no more, no less.)
    //   2. Phrase preference — `match_phrase` on the FULL query marks the
    //      contiguous typed phrase when it exists ("Microbiome Research"), so the
    //      highlight mirrors the phrase-boosted rank; scattered, only the
    //      discriminating token lights up.
    // The indexed title is plain text and short, so no analyzer-offset cap is
    // needed (unlike the People `publicationTitles` blob). Omitted when the flag
    // is off ⇒ body unchanged.
    ...(highlightMatches
      ? {
          highlight: {
            fields: { title: { number_of_fragments: 0 } },
            highlight_query: {
              bool: {
                should: [
                  { match_phrase: { title: trimmed } },
                  { match: { title: highlightSignificantQuery } },
                ],
              },
            },
            pre_tags: ["<mark>"],
            post_tags: ["</mark>"],
          },
        }
      : {}),
    aggs: {
      publicationTypes: {
        filter: aggBoolFor(filtersExcept("publicationType")),
        aggs: { keys: { terms: { field: "publicationType", size: 15 } } },
      },
      // Top journals by count. 500 covers the mid-tail of any plausibly
      // broad query (e.g. ~1,300 distinct journals for q=cancer; the top
      // 500 by count own ≥99% of the result mass), while keeping the
      // payload trivially small. The client-side search-within in
      // JournalFacet narrows this list as the user types — beyond 500
      // they should sharpen the main query rather than scroll a facet.
      journals: {
        filter: aggBoolFor(filtersExcept("journal")),
        aggs: { keys: { terms: { field: "journal.keyword", size: 500 } } },
      },
      wcmRoleFirst: {
        filter: aggBoolFor([
          ...filtersExcept("wcmAuthorRole"),
          { term: { wcmAuthorPositions: "first" } },
        ]),
      },
      wcmRoleSenior: {
        filter: aggBoolFor([
          ...filtersExcept("wcmAuthorRole"),
          { term: { wcmAuthorPositions: "senior" } },
        ]),
      },
      wcmRoleMiddle: {
        filter: aggBoolFor([
          ...filtersExcept("wcmAuthorRole"),
          { term: { wcmAuthorPositions: "middle" } },
        ]),
      },
      // Issue #88 — Author facet. Top 500 mirrors the journal cap;
      // typeahead in the client narrows further. Cardinality sub-agg
      // surfaces the true distinct author count for the rail header
      // (`Author 1,619`) so users see the full scope of the facet.
      wcmAuthors: {
        filter: aggBoolFor(filtersExcept("wcmAuthor")),
        aggs: {
          keys: { terms: { field: "wcmAuthorCwids", size: 500 } },
          total: { cardinality: { field: "wcmAuthorCwids", precision_threshold: 4000 } },
        },
      },
      // Issue #837 — Department facet. Top 200 mirrors the People-tab dept
      // facet cap (WCM has well under 200 departments). Gated on the flag: a
      // no-op `match_none` keeps the agg key present (so the response shape is
      // stable) while contributing zero buckets when the field isn't indexed
      // yet — the page renders no Department group, same as flag-off.
      ...(useDepartmentFilter
        ? {
            departments: {
              filter: aggBoolFor(filtersExcept("department")),
              aggs: { keys: { terms: { field: "wcmAuthorDepartments", size: 200 } } },
            },
          }
        : {}),
      // Mentoring activity facet — contextual counts per program bucket.
      // One named filters-of-filters agg with 5 sub-buckets, each scoped to
      // the bucket's pmids + filtersExcept("mentoring") + the q-bound must.
      // Empty buckets become match_none so OpenSearch doesn't choke on
      // `terms: { pmid: [] }`.
      mentoringPrograms: {
        filters: {
          filters: (Object.keys(mentoringBuckets.byProgram) as MentoringProgramKey[]).reduce(
            (acc, key) => {
              const bucketPmids = mentoringBuckets.byProgram[key];
              acc[key] =
                bucketPmids.length > 0
                  ? aggBoolFor([
                      ...filtersExcept("mentoring"),
                      { terms: { pmid: bucketPmids } },
                    ])
                  : { bool: { must_not: [{ match_all: {} }] } };
              return acc;
            },
            {} as Record<MentoringProgramKey, Record<string, unknown>>,
          ),
        },
      },
    },
  };

  // Perf (B4 hits-only fallback) — drop the `aggs` block from the request when
  // the caller only needs total + hits (sparse-concept preview). Same `query` /
  // `post_filter` / `sort` / `size`, so `total` and the hit order are identical
  // to a full search; only the server-side facet aggregations are skipped.
  // Mirrors the `countOnly` short-circuit above, but keeps `size` and hit
  // emission. The facet `scholar.findMany` is skipped separately below.
  const skipAggs = opts.hitsOnly === true;
  const { aggs: _aggs, ...bodyNoAggs } = body;
  const resp = await searchClient().search({
    index: PUBLICATIONS_INDEX,
    body: (skipAggs ? bodyNoAggs : body) as object,
  });

  type Hit = {
    _source: {
      pmid: string;
      title: string;
      journal: string | null;
      year: number | null;
      publicationType: string | null;
      citationCount: number;
      doi: string | null;
      pmcid: string | null;
      pubmedUrl: string | null;
      // Issue #259 §1.8 — both optional in `_source`: ETL omits them on pubs
      // with zero non-null impact rows (OMIT-on-empty contract).
      impactScore?: number;
      topicImpacts?: Array<{ parentTopicId: string; impactScore: number }>;
      // Issue #316 PR-C follow-up — optional pass-through justification text.
      impactJustification?: string;
      // Issue #288 PR-A — pass-through abstract. ETL writes empty string on
      // pubs with no abstract, so this is always-present in practice but
      // optional-typed for defensive null handling on older index docs.
      abstract?: string;
      // Issue #707 — descriptor UIs this publication is tagged with (#259 uses
      // them for the concept-mode `terms { meshDescriptorUi }` clause). Read for
      // the match-provenance path; already in `_source` (no include-list trims it).
      meshDescriptorUi?: string[];
    };
    // SEARCH_PUB_HIGHLIGHT — `title` highlight fragment (whole field, marked),
    // present only when the flag is on and the title matched.
    highlight?: { title?: string[] };
  };
  type Bucket = { key: string; doc_count: number };
  const r = resp.body as unknown as {
    hits: { hits: Hit[]; total: { value: number } };
    aggregations?: {
      publicationTypes?: { keys: { buckets: Bucket[] } };
      journals?: { keys: { buckets: Bucket[] } };
      wcmRoleFirst?: { doc_count: number };
      wcmRoleSenior?: { doc_count: number };
      wcmRoleMiddle?: { doc_count: number };
      wcmAuthors?: {
        keys: { buckets: Bucket[] };
        total: { value: number };
      };
      // Issue #837 — present only when SEARCH_PUB_DEPARTMENT_FILTER is on.
      departments?: { keys: { buckets: Bucket[] } };
      mentoringPrograms?: {
        buckets: Record<MentoringProgramKey, { doc_count: number }>;
      };
    };
  };

  // Issue #88 — hydrate Author facet buckets with display name + slug +
  // avatar in a single Prisma round trip. Active selections may not
  // appear in the top-500 result set, so include them in the lookup so
  // the rail can pin them with a real label rather than the bare CWID.
  const authorBuckets = r.aggregations?.wcmAuthors?.keys.buckets ?? [];
  const facetCwids = new Set(authorBuckets.map((b) => b.key));
  if (filters.wcmAuthor) for (const c of filters.wcmAuthor) facetCwids.add(c);
  const facetCwidList = Array.from(facetCwids);
  // The page's pmids (for the chip-data hydration below). Computed up here so
  // the facet-scholar lookup and the author-chip lookup — independent reads,
  // one against Prisma, one against publication_author — issue concurrently
  // rather than serially. `fetchAuthorBylineForPmids` stays sequential after
  // this resolves; it depends on `wcmAuthorsByPmid`.
  const pmids = r.hits.hits.map((h) => h._source.pmid);
  const [scholarRows, wcmAuthorsByPmid] = await Promise.all([
    // Perf (B4 hits-only fallback) — skip the ≤500-row facet hydration when the
    // caller discards facets; the per-hit `fetchWcmAuthorsForPmids` below
    // (bounded to PAGE_SIZE) still runs so the preview rows render. With aggs
    // skipped `facetCwidList` is already empty, so this gate is self-documenting.
    opts.hitsOnly === true || facetCwidList.length === 0
      ? Promise.resolve([] as { cwid: string; preferredName: string; slug: string }[])
      : prisma.scholar.findMany({
          where: { cwid: { in: facetCwidList }, deletedAt: null, status: "active" },
          select: { cwid: true, preferredName: true, slug: true },
        }),
    // Enrich hits with topic-page-style chip data (avatar + isFirst/isLast)
    // by querying publication_author for the page's pmids. Bounded to PAGE_SIZE.
    fetchWcmAuthorsForPmids(pmids),
  ]);
  const scholarByCwid = new Map(scholarRows.map((s) => [s.cwid, s]));
  const wcmAuthorBuckets: WcmAuthorFacetBucket[] = authorBuckets.flatMap((b) => {
    const s = scholarByCwid.get(b.key);
    if (!s) return []; // scholar deleted/suppressed since the index was built
    return [{
      cwid: s.cwid,
      displayName: s.preferredName,
      slug: s.slug,
      identityImageEndpoint: identityImageEndpoint(s.cwid),
      count: b.doc_count,
    }];
  });
  // Always surface active selections in the bucket list so the rail can
  // render them in the pinned section even when other filters knocked
  // their count to zero (or to a value below the top-500 cutoff).
  if (filters.wcmAuthor) {
    const present = new Set(wcmAuthorBuckets.map((b) => b.cwid));
    for (const cwid of filters.wcmAuthor) {
      if (present.has(cwid)) continue;
      const s = scholarByCwid.get(cwid);
      if (!s) continue;
      wcmAuthorBuckets.push({
        cwid: s.cwid,
        displayName: s.preferredName,
        slug: s.slug,
        identityImageEndpoint: identityImageEndpoint(s.cwid),
        count: 0,
      });
    }
  }

  // `pmids` + `wcmAuthorsByPmid` (the topic-page-style chip data) were resolved
  // above in the same Promise.all as the facet-scholar lookup.

  // Issue #718 — a row whose displayable WCM author list is empty (its sole
  // confirmed WCM author was soft-deleted / left WCM) would otherwise render with
  // no author line at all. Hydrate a suppression-safe unstructured byline for just
  // those pmids so the row keeps attribution. Emptiness is measured against the
  // same `cwid+slug+headshot` predicate the per-hit chip map applies below.
  // #1026 — a hidden-class co-author (soft-deleted doctoral student) can be
  // slug-less; it still renders as a NON-LINKED chip, so it counts as a
  // displayable author. When the flag is off no such author is in the hydration,
  // so the `|| !isPubliclyDisplayed(...)` branch never matches and behavior is
  // byte-identical to the prior `cwid && slug && img` predicate.
  const hasDisplayableAuthor = (pmid: string): boolean =>
    (wcmAuthorsByPmid.get(pmid) ?? []).some(
      (a) =>
        a.cwid &&
        a.identityImageEndpoint &&
        (a.slug || !isPubliclyDisplayed(a.roleCategory)),
    );
  const authorsFallbackByPmid = await fetchAuthorBylineForPmids(
    pmids.filter((p) => !hasDisplayableAuthor(p)),
  );

  // Issue #259 §1.8 — anchored-topic set for "Concept impact" computation.
  // Empty Set when the §1.8 flag is off, when no MeSH resolved, or when
  // the resolved descriptor has no curated anchors (`curatedTopicAnchors`
  // empty per §1.4). In all three cases `conceptImpactScore` falls
  // through to null and the row renders the "Impact" fallback.
  const anchorSet =
    useImpact && resolution && resolution.curatedTopicAnchors.length > 0
      ? new Set(resolution.curatedTopicAnchors)
      : new Set<string>();

  // Issue #707 — MeSH match provenance, the publications twin of #688. Only when
  // the flag is on and the query resolved to a descriptor with at least one
  // descendant (so there's a tree to subsume). Labels for the whole descendant
  // set are resolved once, then intersected per hit by `computeMatchProvenance`
  // against the publication's own `meshDescriptorUi`.
  const pubProvenanceOn =
    opts.matchProvenance === true &&
    resolution != null &&
    resolution.descendantUis.length > 1 &&
    resolution.name.length > 0;
  const pubProvenanceLabels = pubProvenanceOn
    ? await descriptorLabelsForUis(resolution!.descendantUis)
    : new Map<string, string>();

  return {
    hits: r.hits.hits.map((h) => {
      const enriched = wcmAuthorsByPmid.get(h._source.pmid) ?? [];
      // #1026 — keep slug-less hidden-class co-authors (soft-deleted doctoral
      // students); their slug passes through as null so the chip renders
      // NON-LINKED. Flag-off → no such author is hydrated, so the predicate is
      // equivalent to the prior `cwid && slug && img`.
      const wcmAuthors = enriched.flatMap((a) =>
        a.cwid && a.identityImageEndpoint && (a.slug || !isPubliclyDisplayed(a.roleCategory))
          ? [
              {
                name: a.name,
                cwid: a.cwid,
                slug: a.slug,
                identityImageEndpoint: a.identityImageEndpoint,
                isFirst: a.isFirst,
                isLast: a.isLast,
                roleCategory: a.roleCategory,
              },
            ]
          : [],
      );
      // Compute per-hit impact display fields. Flag-off short-circuits to
      // both-null so legacy callers see unchanged shape.
      let impactScore: number | null = null;
      let conceptImpactScore: number | null = null;
      let impactJustification: string | null = null;
      if (useImpact) {
        impactScore = h._source.impactScore ?? null;
        const ti = h._source.topicImpacts;
        if (anchorSet.size > 0 && ti && ti.length > 0) {
          let max: number | null = null;
          for (const t of ti) {
            if (!anchorSet.has(t.parentTopicId)) continue;
            if (max === null || t.impactScore > max) max = t.impactScore;
          }
          conceptImpactScore = max;
        }
        // Only surface justification text when there's a score for it to
        // explain, matching the same gating used on /topics (#316 PR-C).
        if (
          impactScore !== null &&
          typeof h._source.impactJustification === "string" &&
          h._source.impactJustification.length > 0
        ) {
          impactJustification = h._source.impactJustification;
        }
      }
      return {
        pmid: h._source.pmid,
        title: h._source.title,
        titleHighlight: h.highlight?.title?.[0] ?? null,
        journal: h._source.journal,
        year: h._source.year,
        publicationType: h._source.publicationType,
        citationCount: h._source.citationCount,
        doi: h._source.doi,
        pmcid: h._source.pmcid,
        pubmedUrl: h._source.pubmedUrl,
        wcmAuthors,
        // Issue #718 — byline only when there is no displayable chip; chips win.
        authorsFallback:
          wcmAuthors.length === 0
            ? (authorsFallbackByPmid.get(h._source.pmid) ?? null)
            : null,
        impactScore,
        conceptImpactScore,
        impactJustification,
        abstract:
          typeof h._source.abstract === "string" && h._source.abstract.length > 0
            ? h._source.abstract
            : null,
        matchProvenance: pubProvenanceOn
          ? computeMatchProvenance({
              publicationMeshUi: h._source.meshDescriptorUi,
              descendantUis: resolution!.descendantUis,
              parentTerm: resolution!.name,
              labels: pubProvenanceLabels,
            })
          : undefined,
      };
    }),
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    queryShape,
    meshDescendantSetSize: resolution?.descendantUis.length ?? null,
    meshAnchorCount: resolution?.curatedTopicAnchors.length ?? null,
    recencyMode,
    recencyOriginYear,
    facets: {
      publicationTypes: (r.aggregations?.publicationTypes?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      journals: (r.aggregations?.journals?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      wcmAuthorRoles: {
        first: r.aggregations?.wcmRoleFirst?.doc_count ?? 0,
        senior: r.aggregations?.wcmRoleSenior?.doc_count ?? 0,
        middle: r.aggregations?.wcmRoleMiddle?.doc_count ?? 0,
      },
      wcmAuthors: wcmAuthorBuckets,
      wcmAuthorsTotal: r.aggregations?.wcmAuthors?.total.value ?? 0,
      mentoringPrograms: {
        md: r.aggregations?.mentoringPrograms?.buckets.md.doc_count ?? 0,
        mdphd: r.aggregations?.mentoringPrograms?.buckets.mdphd.doc_count ?? 0,
        phd: r.aggregations?.mentoringPrograms?.buckets.phd.doc_count ?? 0,
        postdoc: r.aggregations?.mentoringPrograms?.buckets.postdoc.doc_count ?? 0,
        ecr: r.aggregations?.mentoringPrograms?.buckets.ecr.doc_count ?? 0,
      },
      // Issue #837 — Department buckets (empty when the flag is off, so the
      // page renders no Department group).
      departments: (r.aggregations?.departments?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
    },
  };
}

/**
 * Autocomplete suggestions (spec line 184: fires on 2 chars).
 * Returns up to `size` distinct suggestions from the people index.
 */
export async function suggestNames(prefix: string, size = 5): Promise<
  Array<{
    text: string;
    slug: string;
    cwid: string;
    primaryTitle: string | null;
    primaryDepartment: string | null;
    personType: string | null;
    lastNameSort: string | null;
    pubCountBucket: number;
  }>
> {
  const trimmed = prefix.trim();
  if (trimmed.length < 2) return [];

  const resp = await searchClient().search({
    index: PEOPLE_INDEX,
    body: {
      size: 0,
      suggest: {
        scholar: {
          prefix: trimmed,
          completion: { field: "nameSuggest", size, skip_duplicates: true },
        },
      },
      _source: false,
    },
  });

  type SuggestOption = { text: string; _index: string; _id: string };
  type SuggestEntry = { options: SuggestOption[] };
  const suggestPayload = (resp.body as unknown as { suggest?: { scholar?: SuggestEntry[] } })
    .suggest?.scholar?.[0]?.options ?? [];

  if (suggestPayload.length === 0) return [];
  const cwids = suggestPayload.map((o) => o._id);
  const mget = await searchClient().mget({
    index: PEOPLE_INDEX,
    body: { ids: cwids },
  });
  type MGetDoc = {
    _id: string;
    _source?: {
      slug?: string;
      preferredName?: string;
      primaryTitle?: string | null;
      primaryDepartment?: string | null;
      personType?: string | null;
      lastNameSort?: string | null;
      pubCountBucket?: number;
    };
  };
  const sourceByCwid = new Map<string, MGetDoc["_source"]>();
  for (const d of (mget.body as unknown as { docs: MGetDoc[] }).docs) {
    if (d._source) sourceByCwid.set(d._id, d._source);
  }

  return suggestPayload.map((o) => {
    const src = sourceByCwid.get(o._id);
    // The completion suggester returns whichever input string matched the
    // prefix — for the last-name variant ("Wolchok") that's the bare last
    // token, which renders awkwardly in the dropdown. Prefer the doc's
    // canonical preferredName (which already includes any postnominal); fall
    // back to the matched text when the doc isn't in mget.
    return {
      text: src?.preferredName ?? o.text,
      cwid: o._id,
      slug: src?.slug ?? "",
      primaryTitle: src?.primaryTitle ?? null,
      primaryDepartment: src?.primaryDepartment ?? null,
      personType: src?.personType ?? null,
      lastNameSort: src?.lastNameSort ?? null,
      // #254 §10 — the §6 primary tiebreak key. Defaults to 0 (lowest) for a
      // doc missing the field (pre-reindex index) so it can never outrank a
      // bucketed peer; degrades to the v1 role→name→cwid order when every row
      // is 0.
      pubCountBucket: src?.pubCountBucket ?? 0,
    };
  });
}

export type EntityKind =
  | "person"
  | "topic"
  | "subtopic"
  | "department"
  | "division"
  | "center"
  | "institute"
  // #824 — a method-family suggestion (rust "Method" badge) linking to the
  // cross-scholar family page. Gated behind `isMethodPagesEnabled()` AND the
  // #800/#801 overlay gate, so suppressed/sensitive families never suggest.
  | "method"
  // #878 — a MeSH-concept suggestion (indigo "Concept" badge) linking to the
  // existing concept search. Gated behind `resolveSearchSuggestMeshConcept()`
  // inside `suggestMeshConcepts`, so when off no concept candidate is produced.
  | "concept";

export type EntitySuggestion = {
  kind: EntityKind;
  title: string;
  subtitle?: string;
  href: string;
  /** Present for `person` rows; powers avatar / future enrichment. */
  cwid?: string;
  /** Present for `person` rows; raw role-category code (e.g.
   *  "full_time_faculty"). Rendered as a chip in the dropdown via
   *  `formatRoleCategory`. */
  roleCategory?: string;
};

/**
 * #824 — a resolved method-family autocomplete candidate. Carries the stable
 * `(supercategory, familyLabel)` identity plus the latest `familyId` (for the URL
 * suffix) and a distinct-scholar count for the subtitle.
 */
type MethodFamilyCandidate = {
  supercategory: string;
  familyId: string;
  familyLabel: string;
  scholarCount: number;
};

/**
 * #824 — method-family autocomplete candidates. Returns `[]` UNLESS the Method
 * pages flag (`isMethodPagesEnabled()`) is on, so when off this contributes
 * NOTHING — no candidates, no `"method"` plausibility hit, no badge.
 *
 * #863 — a family also surfaces when the typed term matches one of its MEMBER
 * TOOL names (e.g. "CRISPR" → the family that contains the CRISPR tools, even
 * when the family label itself doesn't contain the word). `scholar_tool.category`
 * is the tool's `method_family_label` (etl/tools/scholar-tool-mapper-s3), i.e.
 * the same string surfaced as `scholar_family.familyLabel` — so a contains-match
 * over `toolName` resolves to family labels we can OR into the family groupBy.
 *
 * SECURITY: every candidate passes the shared #800/#801 overlay gate
 * (`loadFamilyOverlayGate` + `isFamilyPubliclyVisible`), so #800-suppressed and
 * #801-sensitive families are removed BEFORE they can surface in search. Distinct
 * by the stable `(supercategory, familyLabel)` identity (one row per family),
 * with the latest `familyId` for the URL suffix and a distinct-scholar count for
 * the subtitle — both cheap groupBys bounded by the contains-match fetch size.
 */
export async function loadMethodFamilyCandidates(
  trimmed: string,
  fetchN: number,
): Promise<MethodFamilyCandidate[]> {
  if (!isMethodPagesEnabled()) return [];

  // #863 — resolve families via a member-tool-name match. `scholar_tool` has no
  // family id, but its `category` IS the family label, so a contains-match over
  // `toolName` yields the family labels to OR into the groupBy below. Distinct on
  // `category` and bounded by `take` so the worst case is a single capped scan,
  // not one per matching tool row.
  const toolMatches = await prisma.scholarTool.findMany({
    where: { toolName: { contains: trimmed }, category: { not: null } },
    select: { category: true },
    distinct: ["category"],
    take: Math.max(fetchN * 4, fetchN),
  });
  const toolFamilyLabels = toolMatches
    .map((t) => t.category)
    .filter((c): c is string => Boolean(c));

  // One row per stable (supercategory, familyLabel) family; latest familyId for
  // the URL suffix; distinct-scholar count for the subtitle. `_count.cwid` over a
  // `(supercategory, familyLabel)` groupBy = distinct scholars (the table is
  // `@@unique([cwid, familyId])`, one row per (cwid, family)). Over-fetch a little
  // (fetchN * 4) before the overlay gate so a suppressed/sensitive family doesn't
  // starve the visible set below `fetchN`. The OR adds families matched only by a
  // member tool name (#863) alongside the label-contains match.
  const groups = await prisma.scholarFamily.groupBy({
    by: ["supercategory", "familyLabel"],
    where: {
      OR: [
        { familyLabel: { contains: trimmed } },
        ...(toolFamilyLabels.length > 0
          ? [{ familyLabel: { in: toolFamilyLabels } }]
          : []),
      ],
    },
    _max: { familyId: true },
    _count: { cwid: true },
    orderBy: { _count: { cwid: "desc" } },
    take: Math.max(fetchN * 4, fetchN),
  });
  if (groups.length === 0) return [];

  // Shared overlay gate — drop suppressed/sensitive families before they suggest.
  const gate = await loadFamilyOverlayGate();
  const out: MethodFamilyCandidate[] = [];
  for (const g of groups) {
    if (!isFamilyPubliclyVisible(g.supercategory, g.familyLabel, gate)) continue;
    out.push({
      supercategory: g.supercategory,
      familyId: g._max.familyId ?? "",
      familyLabel: g.familyLabel,
      scholarCount: g._count.cwid,
    });
    if (out.length >= fetchN) break;
  }
  return out;
}

/**
 * Mixed-entity autocomplete: returns people, topics, subtopics, departments,
 * divisions, centers, and (flag-gated, #824) method families in a single ranked
 * list.
 *
 * Two paths, gated by `SEARCH_RANKING_V2`:
 *   - `on` (default): #231 v1 algorithm — plausibility predicates, query-shape
 *     classifier, full-name carve-out, deterministic person tiebreak, 12-row
 *     position-anchored cap fill. Fetches up to 5 per source.
 *   - `off`: legacy path — fixed kind order, per-source `perKind` cap (default
 *     3). Kill switch for v1.
 *
 * The flag check lives here rather than at the route so any caller of
 * `suggestEntities` shares the same dispatch.
 */
export async function suggestEntities(
  prefix: string,
  perKind = 3,
): Promise<EntitySuggestion[]> {
  const trimmed = prefix.trim();
  if (trimmed.length < 2) return [];

  const useV2 = (process.env.SEARCH_RANKING_V2 ?? "on") !== "off";
  const fetchN = useV2 ? 5 : perKind;

  const [
    peopleR,
    topicsR,
    subtopicsR,
    departmentsR,
    divisionsR,
    centersR,
    methodsR,
    conceptsR,
  ] = await Promise.allSettled([
      suggestNames(trimmed, fetchN),
      prisma.topic.findMany({
        where: { label: { contains: trimmed } },
        orderBy: { label: "asc" },
        take: fetchN,
        select: { id: true, label: true },
      }),
      prisma.subtopic.findMany({
        // Search-on-label is intentional. `label` is the synthesis/retrieval-
        // canonical field per D-19; users typing research-domain words match
        // it more reliably than the UI-stylized `display_name`. Switching to
        // displayName for matching would shrink hit counts AND introduce
        // D-19-forbidden retrieval over UI fields. Render uses display_name;
        // matching uses label.
        where: { label: { contains: trimmed } },
        orderBy: { label: "asc" },
        take: fetchN,
        select: {
          id: true,
          label: true,
          displayName: true,
          shortDescription: true,
          parentTopicId: true,
          parentTopic: { select: { label: true } },
        },
      }),
      prisma.department.findMany({
        where: { name: { contains: trimmed } },
        orderBy: { name: "asc" },
        take: fetchN,
        select: { slug: true, name: true, scholarCount: true },
      }),
      prisma.division.findMany({
        where: { name: { contains: trimmed } },
        orderBy: { name: "asc" },
        take: fetchN,
        select: {
          slug: true,
          name: true,
          scholarCount: true,
          department: { select: { slug: true, name: true } },
        },
      }),
      prisma.center.findMany({
        where: { name: { contains: trimmed } },
        orderBy: { name: "asc" },
        take: fetchN,
        select: {
          slug: true,
          name: true,
          scholarCount: true,
          centerType: true,
        },
      }),
      // #824 — method-family candidates, flag-gated + overlay-gated inside the
      // helper (off ⇒ `[]`, so no slot leaks when the Method pages flag is off).
      loadMethodFamilyCandidates(trimmed, fetchN),
      // #878 — MeSH-concept candidates, flag-gated inside the helper (off ⇒ `[]`,
      // so no slot leaks when `SEARCH_SUGGEST_MESH_CONCEPT` is off). The cold
      // getMeshMap precompute is contained by allSettled — a slow/cold load
      // contributes zero rows instead of blocking or 500-ing the dropdown.
      suggestMeshConcepts(trimmed, fetchN),
    ]);

  // §7 — allSettled means one slow/broken source contributes zero rows
  // instead of 500-ing the dropdown.
  const unwrap = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === "fulfilled" ? r.value : fallback;
  const people = unwrap(peopleR, [] as Awaited<ReturnType<typeof suggestNames>>);
  const topics = unwrap(topicsR, [] as Array<{ id: string; label: string }>);
  const subtopics = unwrap(
    subtopicsR,
    [] as Array<{
      id: string;
      label: string;
      displayName: string | null;
      shortDescription: string | null;
      parentTopicId: string;
      parentTopic: { label: string } | null;
    }>,
  );
  const departments = unwrap(
    departmentsR,
    [] as Array<{ slug: string; name: string; scholarCount: number }>,
  );
  const divisions = unwrap(
    divisionsR,
    [] as Array<{
      slug: string;
      name: string;
      scholarCount: number;
      department: { slug: string; name: string } | null;
    }>,
  );
  const centers = unwrap(
    centersR,
    [] as Array<{
      slug: string;
      name: string;
      scholarCount: number;
      centerType: string;
    }>,
  );
  // #824 — method families. Empty when the Method pages flag is off (the helper
  // returns `[]`) or the source rejected — no candidates contributed either way.
  const methods = unwrap(methodsR, [] as MethodFamilyCandidate[]);
  // #878 — MeSH concepts. Empty when the flag is off (the helper returns `[]`)
  // or the source rejected / map was cold — no candidates contributed either way.
  const concepts = unwrap(conceptsR, [] as MeshConceptCandidate[]);

  type PersonRow = Awaited<ReturnType<typeof suggestNames>>[number];
  type TopicRow = (typeof topics)[number];
  type SubtopicRow = (typeof subtopics)[number];
  type DeptRow = (typeof departments)[number];
  type DivisionRow = (typeof divisions)[number];
  type CenterRow = (typeof centers)[number];
  type MethodRow = (typeof methods)[number];
  type ConceptRow = (typeof concepts)[number];

  const personToSuggestion = (p: PersonRow): EntitySuggestion | null => {
    if (!p.slug) return null;
    const subParts = [p.primaryTitle, p.primaryDepartment].filter(
      (s): s is string => Boolean(s),
    );
    return {
      kind: "person",
      title: p.text,
      subtitle: subParts.join(" · ") || undefined,
      href: profilePath(p.slug),
      cwid: p.cwid,
      roleCategory: p.personType ?? undefined,
    };
  };
  const topicToSuggestion = (t: TopicRow): EntitySuggestion => ({
    kind: "topic",
    title: t.label,
    subtitle: "Research topic",
    href: `/topics/${t.id}`,
  });
  const subtopicToSuggestion = (s: SubtopicRow): EntitySuggestion => {
    // D-09 universal fallback for the suggestion title.
    const title = s.displayName?.trim() || s.label?.trim() || s.id;
    // D-07: short_description is the autocomplete subtitle source for subtopic
    // entries. When the artifact's short_description is empty (legacy/long-tail
    // not yet relabeled), fall back to "Subtopic in {parent}" — more useful
    // than blank space, consistent with Phase 3 D-06 absence-as-default (no
    // generic absence-placeholder string).
    const trimmedShort = s.shortDescription?.trim();
    const subtitle = trimmedShort
      ? trimmedShort
      : s.parentTopic
        ? `Subtopic in ${s.parentTopic.label}`
        : "Subtopic";
    return {
      kind: "subtopic",
      title,
      subtitle,
      href: `/topics/${s.parentTopicId}?subtopic=${encodeURIComponent(s.id)}#publications`,
    };
  };
  const deptToSuggestion = (d: DeptRow): EntitySuggestion => ({
    kind: "department",
    title: d.name,
    subtitle: d.scholarCount
      ? `Department · ${d.scholarCount.toLocaleString()} scholars`
      : "Department",
    href: `/departments/${d.slug}`,
  });
  const divisionToSuggestion = (d: DivisionRow): EntitySuggestion | null => {
    if (!d.department) return null;
    return {
      kind: "division",
      title: d.name,
      subtitle: `Division of ${d.department.name}`,
      href: `/departments/${d.department.slug}/divisions/${d.slug}`,
    };
  };
  const centerToSuggestion = (c: CenterRow): EntitySuggestion => {
    const isInstitute = c.centerType === "institute";
    const kindLabel = isInstitute ? "Institute" : "Center";
    return {
      kind: isInstitute ? "institute" : "center",
      title: c.name,
      subtitle: c.scholarCount
        ? `${kindLabel} · ${c.scholarCount.toLocaleString()} members`
        : kindLabel,
      href: `/centers/${c.slug}`,
    };
  };
  // #824 — method-family row. Title = the family label; subtitle = the
  // supercategory display label (+ distinct-scholar count when present); href =
  // the cross-scholar family page. The candidate already passed the flag + overlay
  // gate in `loadMethodFamilyCandidates`, so this builder is render-only.
  const familyToSuggestion = (m: MethodRow): EntitySuggestion => {
    const sc = supercategoryLabel(m.supercategory);
    const subtitle = m.scholarCount
      ? `${sc} · ${m.scholarCount.toLocaleString()} ${m.scholarCount === 1 ? "scholar" : "scholars"}`
      : sc;
    return {
      kind: "method",
      title: m.familyLabel,
      subtitle,
      href: methodFamilyPath(m.supercategory, m.familyId, m.familyLabel),
    };
  };
  // #878 — MeSH-concept row. Title = the canonical descriptor name; subtitle
  // notes the concept and, for a synonym/entry-term match, the verbatim form the
  // query hit (so `FACS` reads "MeSH concept · via \"FACS\""); href = a bare
  // `/search?q=<name>`, which re-runs `resolveMeshDescriptor` on the results page
  // in default expanded mode (the existing concept search). The candidate already
  // passed the flag gate in `suggestMeshConcepts`, so this builder is render-only.
  const conceptToSuggestion = (c: ConceptRow): EntitySuggestion => ({
    kind: "concept",
    title: c.name,
    subtitle:
      c.confidence === "entry-term"
        ? `MeSH concept · via "${c.matchedForm}"`
        : "MeSH concept",
    href: `/search?q=${encodeURIComponent(c.name)}`,
  });

  if (!useV2) {
    // Legacy path — fixed order, per-source `perKind` cap. Kept reachable via
    // `SEARCH_RANKING_V2=off` as a kill switch.
    const out: EntitySuggestion[] = [];
    for (const p of people.slice(0, perKind)) {
      const s = personToSuggestion(p);
      if (s) out.push(s);
    }
    for (const t of topics.slice(0, perKind)) out.push(topicToSuggestion(t));
    for (const s of subtopics.slice(0, perKind)) out.push(subtopicToSuggestion(s));
    for (const d of departments.slice(0, perKind)) out.push(deptToSuggestion(d));
    for (const d of divisions.slice(0, perKind)) {
      const s = divisionToSuggestion(d);
      if (s) out.push(s);
    }
    for (const c of centers.slice(0, perKind)) out.push(centerToSuggestion(c));
    // #824 — method families (empty when the flag is off). Appended after the
    // base kinds in the legacy fixed-order path.
    for (const m of methods.slice(0, perKind)) out.push(familyToSuggestion(m));
    // #878 — MeSH concepts (empty when the flag is off). Appended last in the
    // legacy fixed-order path.
    for (const c of concepts.slice(0, perKind)) out.push(conceptToSuggestion(c));
    return out;
  }

  // v1 ranking — §1..§6 from #231.
  const peopleSorted = tiebreakPeople(people);

  // §3 carve-out: if the query is a full-name match against a single person,
  // collapse the dropdown to one row.
  const carveOut = tryFullNameCarveOut(trimmed, peopleSorted);
  if (carveOut) {
    const s = personToSuggestion(carveOut);
    return s ? [s] : [];
  }

  // Prisma sources return contains-matches in alphabetical order. Promote rows
  // whose primary field starts with the prefix to the front of each source so
  // the lead row in the dropdown is the prefix match, not the alpha-first
  // contains-match. People come from OS-scored completion suggester and don't
  // need this.
  const topicsPromoted = promoteStartsWith(topics, trimmed, (r) => r.label);
  const subtopicsPromoted = promoteStartsWith(subtopics, trimmed, (r) => r.label);
  const departmentsPromoted = promoteStartsWith(departments, trimmed, (r) => r.name, "tokenwise");
  const divisionsPromoted = promoteStartsWith(divisions, trimmed, (r) => r.name, "tokenwise");
  const centersPromoted = promoteStartsWith(centers, trimmed, (r) => r.name, "tokenwise");
  // #824 — promote prefix-matching family labels to the front (same tokenwise
  // lead rule as the named entities). Empty when the Method pages flag is off.
  const methodsPromoted = promoteStartsWith(
    methods,
    trimmed,
    (r) => r.familyLabel,
    "tokenwise",
  );
  // #878 — promote prefix-matching descriptor names to the front (label mode:
  // descriptor names are single research phrases, not multi-token org names).
  // Empty when the flag is off.
  const conceptsPromoted = promoteStartsWith(concepts, trimmed, (r) => r.name);

  const sources: RankingSources = {
    person: peopleSorted,
    topic: topicsPromoted,
    subtopic: subtopicsPromoted,
    department: departmentsPromoted,
    division: divisionsPromoted,
    center: centersPromoted,
    // #824 — only populated when the flag is on; an empty array yields no
    // `"method"` plausibility hit and no ordering slot.
    method: methodsPromoted.map((m) => ({ familyLabel: m.familyLabel })),
    // #878 — only populated when the flag is on; an empty array yields no
    // `"concept"` plausibility hit and no ordering slot.
    concept: conceptsPromoted.map((c) => ({ name: c.name })),
  };

  const shape = classifyQueryShape(trimmed);
  const hits = plausibilityHits(trimmed, sources);
  const order = chooseKindOrder(shape, hits);

  // Centers in the data layer can carry centerType "institute"; the kind
  // resolver doesn't distinguish them. Merge "institute" rows into the
  // "center" bucket here so cap fill sees a single source.
  const rowsByKind: Partial<Record<EntityKind, unknown[]>> = {
    person: peopleSorted,
    topic: topicsPromoted,
    subtopic: subtopicsPromoted,
    department: departmentsPromoted,
    division: divisionsPromoted,
    center: centersPromoted,
    // #824 — the full candidate rows (with supercategory/familyId/count) so the
    // switch below can build the suggestion. Empty when the flag is off.
    method: methodsPromoted,
    // #878 — the full concept candidates (descriptorUi/name/confidence/
    // matchedForm) so the switch below can build the suggestion. Empty when off.
    concept: conceptsPromoted,
  };

  const filled = capFill<unknown>(order, rowsByKind);

  const out: EntitySuggestion[] = [];
  for (const { kind, rows } of filled) {
    switch (kind) {
      case "person":
        for (const p of rows as PersonRow[]) {
          const s = personToSuggestion(p);
          if (s) out.push(s);
        }
        break;
      case "topic":
        for (const t of rows as TopicRow[]) out.push(topicToSuggestion(t));
        break;
      case "subtopic":
        for (const s of rows as SubtopicRow[]) out.push(subtopicToSuggestion(s));
        break;
      case "department":
        for (const d of rows as DeptRow[]) out.push(deptToSuggestion(d));
        break;
      case "division":
        for (const d of rows as DivisionRow[]) {
          const s = divisionToSuggestion(d);
          if (s) out.push(s);
        }
        break;
      case "center":
      case "institute":
        for (const c of rows as CenterRow[]) out.push(centerToSuggestion(c));
        break;
      case "method":
        // #824 — only reachable when the flag-gated source produced rows.
        for (const m of rows as MethodRow[]) out.push(familyToSuggestion(m));
        break;
      case "concept":
        // #878 — only reachable when the flag-gated source produced rows.
        for (const c of rows as ConceptRow[]) out.push(conceptToSuggestion(c));
        break;
    }
  }

  // #878 — dedup a concept row against a same-named curated topic/subtopic: the
  // curated taxonomy is the preferred destination, so when a resolved descriptor
  // shares a title with a topic/subtopic already in the list, drop the concept
  // row. Short-circuits when there are no concept candidates (flag off or no
  // match) so the flag-off path is unchanged. Runs after cap-fill — at most one
  // concept row per query, so a dropped row does not reclaim budget.
  if (concepts.length === 0) return out;
  const curatedTitles = new Set(
    out
      .filter((s) => s.kind === "topic" || s.kind === "subtopic")
      .map((s) => s.title.toLowerCase()),
  );
  return out.filter(
    (s) => s.kind !== "concept" || !curatedTitles.has(s.title.toLowerCase()),
  );
}
