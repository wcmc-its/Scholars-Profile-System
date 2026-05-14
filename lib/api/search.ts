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
import { fetchWcmAuthorsForPmids } from "@/lib/api/topics";
import { getMentoringPmidBuckets, type MentoringProgramKey } from "@/lib/api/mentoring-pmids";
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
  PEOPLE_ABSTRACTS_BOOST,
  PEOPLE_FIELD_BOOSTS,
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS,
  PEOPLE_INDEX,
  PEOPLE_RESTRUCTURED_MSM,
  PUBLICATION_FIELD_BOOSTS,
  PUBLICATIONS_INDEX,
  PUBLICATIONS_RESTRUCTURED_MSM,
  searchClient,
} from "@/lib/search";
import type { MeshResolution } from "@/lib/api/search-taxonomy";

const PAGE_SIZE = 20;

export type PeopleSort = "relevance" | "lastname" | "recentPub";
export type PublicationsSort = "relevance" | "year" | "citations";

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
  highlight?: string[];
};

export type PublicationHit = {
  pmid: string;
  title: string;
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
    slug: string;
    identityImageEndpoint: string;
    isFirst: boolean;
    isLast: boolean;
  }>;
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
 */
export type PeopleQueryShape =
  | "legacy_multi_match"
  | "restructured_msm"
  | "concept_filtered"
  | "concept_fallback";

export type PeopleSearchResult = {
  hits: PeopleHit[];
  total: number;
  page: number;
  pageSize: number;
  /** Which query shape served this request — telemetry-only (issue #259). */
  queryShape: PeopleQueryShape;
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
  | "concept_fallback";

export type PublicationsSearchResult = {
  hits: PublicationHit[];
  total: number;
  page: number;
  pageSize: number;
  /** Which query shape served this request — telemetry-only (issue #259). */
  queryShape: PublicationsQueryShape;
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
  };
};

export async function searchPeople(opts: {
  q: string;
  page?: number;
  sort?: PeopleSort;
  filters?: PeopleFilters;
  /** Phase 3 D-10 — filter results to scholars who have publications in this topic (parent topic slug). */
  topic?: string;
}): Promise<PeopleSearchResult> {
  const { q, page = 0 } = opts;
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();

  // Issue #259 §1.1 — people-index query restructure. Now default-on after
  // prod verification of the 4,303 → low-4-figure scholar-tab cut for
  // "electronic health records" (#260 shipped flag-off; this is the
  // promised default flip). Set SEARCH_PEOPLE_QUERY_RESTRUCTURE=off as an
  // emergency rollback without redeploying.
  const useRestructure =
    (process.env.SEARCH_PEOPLE_QUERY_RESTRUCTURE ?? "on") === "on";
  const queryShape: PeopleQueryShape = useRestructure
    ? "restructured_msm"
    : "legacy_multi_match";

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
  const queryBranch: Record<string, unknown> = useRestructure
    ? {
        bool: {
          must: [
            {
              multi_match: {
                query: trimmed,
                fields: [...PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS],
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
      }
    : {
        multi_match: {
          query: trimmed,
          fields: [...PEOPLE_FIELD_BOOSTS],
          type: "best_fields",
        },
      };

  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    must.push({
      bool: {
        should: [
          // CWIDs are stored lowercase as a `keyword` field; an exact term
          // match wins over the multi_match by a wide boost so a pasted
          // CWID resolves to its scholar at the top of the result list.
          { term: { cwid: { value: trimmed.toLowerCase(), boost: 100 } } },
          queryBranch,
        ],
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
  };

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    // OpenSearch's default cap of 10000 short-circuits the total counter
    // and would make the subhead read "10,000 publications" even when
    // there are 90k. Costs more on truly broad queries but the people
    // index is small (~9k docs) so the impact is negligible.
    track_total_hits: true,
    query: { bool: { must, filter: queryFilter } },
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
      fields: {
        preferredName: {},
        areasOfInterest: {},
        overview: {},
      },
      pre_tags: ["<mark>"],
      post_tags: ["</mark>"],
    },
  };

  const resp = await searchClient().search({ index: PEOPLE_INDEX, body: body as object });

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
    };
  };

  return {
    hits: r.hits.hits.map((h) => ({
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
      highlight: h.highlight ? Object.values(h.highlight).flat() : undefined,
    })),
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    queryShape,
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
   * Issue #259 §1.6 — when set AND `SEARCH_PUB_TAB_OR_OF_EVIDENCE=on`, the
   * query is restructured as `must(MeSH-evidence OR ReciterAI-evidence) +
   * should(BM25 free-text)`. Null/undefined → no restructure, byte-identical
   * to the §1.2 shape.
   */
  meshResolution?: MeshResolution | null;
}): Promise<PublicationsSearchResult> {
  const { q, page = 0 } = opts;
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();

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

  // Issue #259 §1.6 — OR-of-evidence pub filter. Flag default-OFF; flip
  // requires the publications index to have been reindexed with the new
  // `reciterParentTopicId` field. The flag is independent of
  // SEARCH_PUB_TAB_MSM: this gate decides query *shape*, the msm gate
  // decides whether the existing flat-multi_match has an msm floor. When
  // §1.6 is active, the BM25 should-clause carries msm unconditionally
  // (it's part of the OR-of-evidence shape definition; the msm flag does
  // not influence it). To escape §1.6 entirely, flip this flag off.
  const useOrOfEvidence =
    (process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE ?? "off") === "on";
  const resolution = opts.meshResolution ?? null;

  let queryShape: PublicationsQueryShape;
  const must: Record<string, unknown>[] = [];
  const topLevelShould: Record<string, unknown>[] = [];

  if (trimmed.length === 0) {
    must.push({ match_all: {} });
    queryShape = usePubMsm ? "restructured_msm" : "legacy_multi_match";
  } else if (useOrOfEvidence && resolution) {
    // §1.6 — admission is `(Path A: MeSH evidence) OR (Path B: ReciterAI
    // evidence)`. BM25 sits in the top-level `should` and contributes to
    // scoring only — it cannot admit a doc on its own.
    //
    // Path A: match_phrase chosen per spec footnote (lines 251-254). The
    // pre-merge probe against pmid 25848412 verifies the analyzed
    // `meshTerms` stream injects position gaps between distinct MeSH terms
    // so this works; if the probe fails, swap to:
    //   { match: { meshTerms: { query: resolution.name, operator: "and", boost: 8 } } }
    const pathA = {
      match_phrase: { meshTerms: { query: resolution.name, boost: 8 } },
    };

    const evidenceShould: Record<string, unknown>[] = [pathA];
    if (resolution.curatedTopicAnchors.length > 0) {
      // Path B: ReciterAI evidence. Flat-score by design — a doc matching
      // N anchors scores the same as a doc matching 1. Admission is what
      // matters; ordering across the admitted set comes from the top-level
      // BM25 should-clause. Multi-anchor hit-count would over-weight broad
      // descriptors whose anchor count is itself a curation-density signal,
      // not a relevance signal.
      evidenceShould.push({
        terms: {
          reciterParentTopicId: resolution.curatedTopicAnchors,
          boost: 6,
        },
      });
      queryShape = "concept_filtered";
    } else {
      // Anchors empty (§1.4 hasn't seeded this descriptor yet, or it's a
      // narrow leaf descriptor with no curated coverage). Path A alone;
      // admission is MeSH-only.
      queryShape = "concept_fallback";
    }

    must.push({
      bool: { should: evidenceShould, minimum_should_match: 1 },
    });
    topLevelShould.push({
      multi_match: {
        query: trimmed,
        fields: [...PUBLICATION_FIELD_BOOSTS],
        type: "best_fields",
        operator: "or",
        minimum_should_match: PUBLICATIONS_RESTRUCTURED_MSM,
      },
    });
  } else {
    // §1.2 path — unresolved query OR flag off. Body MUST be byte-identical
    // to today's output; do not push to topLevelShould (the body spread
    // below skips the `should` key when the array is empty, preserving
    // the exact pre-§1.6 shape).
    must.push({
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
    });
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
  // Mentoring activity facet — union the precomputed pmid sets for the
  // selected program buckets. Empty union (e.g. all programs empty) becomes
  // a match_none clause so a stale-cache state returns zero rows rather
  // than all rows.
  //
  // Always load the buckets (not just when filtering) so we can compute
  // per-bucket contextual counts for the sidebar. The buckets are cached
  // 10 min in mentoring-pmids.ts so this is cheap.
  const mentoringPrograms = filters.mentoringPrograms ?? [];
  const mentoringBuckets = await getMentoringPmidBuckets();
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
  if (mentoringClause) userAxisFilters.push(mentoringClause);

  const filtersExcept = (
    axis: "year" | "publicationType" | "journal" | "wcmAuthorRole" | "wcmAuthor" | "mentoring",
  ) => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "year" && yearClause) out.push(yearClause);
    if (axis !== "publicationType" && publicationTypeClause) out.push(publicationTypeClause);
    if (axis !== "journal" && journalClause) out.push(journalClause);
    if (axis !== "wcmAuthorRole" && wcmRoleClause) out.push(wcmRoleClause);
    if (axis !== "wcmAuthor" && wcmAuthorClause) out.push(wcmAuthorClause);
    if (axis !== "mentoring" && mentoringClause) out.push(mentoringClause);
    return out;
  };

  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "year") {
    sortClause.push({ year: "desc" });
  } else if (sort === "citations") {
    sortClause.push({ citationCount: "desc" });
  }

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    // OpenSearch's default cap of 10000 short-circuits the total counter
    // and would make the subhead read "10,000 publications" even when
    // there are 90k+. Larger publications index (~90k docs) so this
    // counts a few thousand extra docs on broad queries, but it's needed
    // for an accurate count line.
    track_total_hits: true,
    query: {
      bool: {
        must,
        // §1.6 — top-level BM25 scoring clause. Only added when populated
        // (concept_filtered / concept_fallback shapes); empty array spreads
        // to nothing so the §1.2 path produces a byte-identical body.
        // Intentionally NOT propagated to the agg filter contexts below —
        // facet counts are filter-context only and shouldn't be biased by
        // BM25 ordering signal.
        ...(topLevelShould.length > 0 ? { should: topLevelShould } : {}),
      },
    },
    // post_filter applies all user-axis filters to hits AFTER the
    // aggregations run, so each per-facet agg can compute correct
    // excluding-self counts (see searchPeople for the rationale).
    ...(userAxisFilters.length > 0
      ? { post_filter: { bool: { filter: userAxisFilters } } }
      : {}),
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
    aggs: {
      publicationTypes: {
        filter: { bool: { must, filter: filtersExcept("publicationType") } },
        aggs: { keys: { terms: { field: "publicationType", size: 15 } } },
      },
      // Top journals by count. 500 covers the mid-tail of any plausibly
      // broad query (e.g. ~1,300 distinct journals for q=cancer; the top
      // 500 by count own ≥99% of the result mass), while keeping the
      // payload trivially small. The client-side search-within in
      // JournalFacet narrows this list as the user types — beyond 500
      // they should sharpen the main query rather than scroll a facet.
      journals: {
        filter: { bool: { must, filter: filtersExcept("journal") } },
        aggs: { keys: { terms: { field: "journal.keyword", size: 500 } } },
      },
      wcmRoleFirst: {
        filter: {
          bool: {
            must,
            filter: [...filtersExcept("wcmAuthorRole"), { term: { wcmAuthorPositions: "first" } }],
          },
        },
      },
      wcmRoleSenior: {
        filter: {
          bool: {
            must,
            filter: [...filtersExcept("wcmAuthorRole"), { term: { wcmAuthorPositions: "senior" } }],
          },
        },
      },
      wcmRoleMiddle: {
        filter: {
          bool: {
            must,
            filter: [...filtersExcept("wcmAuthorRole"), { term: { wcmAuthorPositions: "middle" } }],
          },
        },
      },
      // Issue #88 — Author facet. Top 500 mirrors the journal cap;
      // typeahead in the client narrows further. Cardinality sub-agg
      // surfaces the true distinct author count for the rail header
      // (`Author 1,619`) so users see the full scope of the facet.
      wcmAuthors: {
        filter: { bool: { must, filter: filtersExcept("wcmAuthor") } },
        aggs: {
          keys: { terms: { field: "wcmAuthorCwids", size: 500 } },
          total: { cardinality: { field: "wcmAuthorCwids", precision_threshold: 4000 } },
        },
      },
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
                  ? {
                      bool: {
                        must,
                        filter: [
                          ...filtersExcept("mentoring"),
                          { terms: { pmid: bucketPmids } },
                        ],
                      },
                    }
                  : { bool: { must_not: [{ match_all: {} }] } };
              return acc;
            },
            {} as Record<MentoringProgramKey, Record<string, unknown>>,
          ),
        },
      },
    },
  };

  const resp = await searchClient().search({ index: PUBLICATIONS_INDEX, body: body as object });

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
    };
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
  const scholarRows = facetCwidList.length === 0
    ? []
    : await prisma.scholar.findMany({
        where: { cwid: { in: facetCwidList }, deletedAt: null, status: "active" },
        select: { cwid: true, preferredName: true, slug: true },
      });
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

  // Enrich hits with topic-page-style chip data (avatar + isFirst/isLast)
  // by querying publication_author for the page's pmids. Bounded to PAGE_SIZE.
  const pmids = r.hits.hits.map((h) => h._source.pmid);
  const wcmAuthorsByPmid = await fetchWcmAuthorsForPmids(pmids);

  return {
    hits: r.hits.hits.map((h) => {
      const enriched = wcmAuthorsByPmid.get(h._source.pmid) ?? [];
      return {
        pmid: h._source.pmid,
        title: h._source.title,
        journal: h._source.journal,
        year: h._source.year,
        publicationType: h._source.publicationType,
        citationCount: h._source.citationCount,
        doi: h._source.doi,
        pmcid: h._source.pmcid,
        pubmedUrl: h._source.pubmedUrl,
        wcmAuthors: enriched.flatMap((a) =>
          a.cwid && a.slug && a.identityImageEndpoint
            ? [
                {
                  name: a.name,
                  cwid: a.cwid,
                  slug: a.slug,
                  identityImageEndpoint: a.identityImageEndpoint,
                  isFirst: a.isFirst,
                  isLast: a.isLast,
                },
              ]
            : [],
        ),
      };
    }),
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    queryShape,
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
  | "institute";

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
 * Mixed-entity autocomplete: returns people, topics, subtopics, departments,
 * divisions, and centers in a single ranked list.
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

  const [peopleR, topicsR, subtopicsR, departmentsR, divisionsR, centersR] =
    await Promise.allSettled([
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

  type PersonRow = Awaited<ReturnType<typeof suggestNames>>[number];
  type TopicRow = (typeof topics)[number];
  type SubtopicRow = (typeof subtopics)[number];
  type DeptRow = (typeof departments)[number];
  type DivisionRow = (typeof divisions)[number];
  type CenterRow = (typeof centers)[number];

  const personToSuggestion = (p: PersonRow): EntitySuggestion | null => {
    if (!p.slug) return null;
    const subParts = [p.primaryTitle, p.primaryDepartment].filter(
      (s): s is string => Boolean(s),
    );
    return {
      kind: "person",
      title: p.text,
      subtitle: subParts.join(" · ") || undefined,
      href: `/scholars/${p.slug}`,
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

  const sources: RankingSources = {
    person: peopleSorted,
    topic: topicsPromoted,
    subtopic: subtopicsPromoted,
    department: departmentsPromoted,
    division: divisionsPromoted,
    center: centersPromoted,
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
    }
  }
  return out;
}
