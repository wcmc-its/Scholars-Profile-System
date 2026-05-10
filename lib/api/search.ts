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
import {
  PEOPLE_FIELD_BOOSTS,
  PEOPLE_INDEX,
  PUBLICATION_FIELD_BOOSTS,
  PUBLICATIONS_INDEX,
  searchClient,
} from "@/lib/search";

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

export type PeopleFilters = {
  /** Composite dept/division keys. */
  deptDiv?: string[];
  personType?: string[];
  activity?: ActivityFilter[];
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

export type PeopleSearchResult = {
  hits: PeopleHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    deptDivs: DeptDivBucket[];
    personTypes: SearchFacetBucket[];
    activity: { hasGrants: number; recentPub: number };
  };
};

export type PublicationsSearchResult = {
  hits: PublicationHit[];
  total: number;
  page: number;
  pageSize: number;
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
        facets: {
          deptDivs: [],
          personTypes: [],
          activity: { hasGrants: 0, recentPub: 0 },
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

  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    must.push({
      bool: {
        should: [
          // CWIDs are stored lowercase as a `keyword` field; an exact term
          // match wins over the multi_match by a wide boost so a pasted
          // CWID resolves to its scholar at the top of the result list.
          { term: { cwid: { value: trimmed.toLowerCase(), boost: 100 } } },
          {
            multi_match: {
              query: trimmed,
              fields: [...PEOPLE_FIELD_BOOSTS],
              type: "best_fields",
            },
          },
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

  // Helper: user-axis filters with one axis omitted, for that axis's
  // excluding-self aggregation. Always-on filters are inherited from the
  // main query context, so they don't appear here.
  const filtersExcept = (axis: "deptDiv" | "personType" | "activity") => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "deptDiv" && deptDivClause) out.push(deptDivClause);
    if (axis !== "personType" && personTypeClause) out.push(personTypeClause);
    if (axis !== "activity") for (const c of activityClauses) out.push(c);
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
    },
  };
}

export async function searchPublications(opts: {
  q: string;
  page?: number;
  sort?: PublicationsSort;
  filters?: PublicationsFilters;
}): Promise<PublicationsSearchResult> {
  const { q, page = 0 } = opts;
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();

  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    must.push({
      multi_match: {
        query: trimmed,
        fields: [...PUBLICATION_FIELD_BOOSTS],
        type: "best_fields",
      },
    });
  } else {
    must.push({ match_all: {} });
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

  const filtersExcept = (
    axis: "year" | "publicationType" | "journal" | "wcmAuthorRole" | "wcmAuthor",
  ) => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "year" && yearClause) out.push(yearClause);
    if (axis !== "publicationType" && publicationTypeClause) out.push(publicationTypeClause);
    if (axis !== "journal" && journalClause) out.push(journalClause);
    if (axis !== "wcmAuthorRole" && wcmRoleClause) out.push(wcmRoleClause);
    if (axis !== "wcmAuthor" && wcmAuthorClause) out.push(wcmAuthorClause);
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
    query: { bool: { must } },
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
    },
  };
}

/**
 * Autocomplete suggestions (spec line 184: fires on 2 chars).
 * Returns up to `size` distinct suggestions from the people index.
 */
export async function suggestNames(prefix: string, size = 5): Promise<
  Array<{ text: string; slug: string; cwid: string; primaryTitle: string | null; primaryDepartment: string | null }>
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
};

/**
 * Mixed-entity autocomplete: returns people, topics, subtopics, departments,
 * divisions, and centers in a single ranked list. Per-source caps keep the
 * dropdown predictable; total ≤ `perKind * 6`.
 */
export async function suggestEntities(
  prefix: string,
  perKind = 3,
): Promise<EntitySuggestion[]> {
  const trimmed = prefix.trim();
  if (trimmed.length < 2) return [];

  const [people, topics, subtopics, departments, divisions, centers] =
    await Promise.all([
      suggestNames(trimmed, perKind).catch(() => []),
      prisma.topic
        .findMany({
          where: { label: { contains: trimmed } },
          orderBy: { label: "asc" },
          take: perKind,
          select: { id: true, label: true },
        })
        .catch(() => [] as Array<{ id: string; label: string }>),
      prisma.subtopic
        .findMany({
          // Search-on-label is intentional. `label` is the synthesis/retrieval-
          // canonical field per D-19; users typing research-domain words match
          // it more reliably than the UI-stylized `display_name`. Switching to
          // displayName for matching would shrink hit counts AND introduce
          // D-19-forbidden retrieval over UI fields. Render uses display_name;
          // matching uses label.
          where: { label: { contains: trimmed } },
          orderBy: { label: "asc" },
          take: perKind,
          select: {
            id: true,
            label: true,
            displayName: true,
            shortDescription: true,
            parentTopicId: true,
            parentTopic: { select: { label: true } },
          },
        })
        .catch(
          () =>
            [] as Array<{
              id: string;
              label: string;
              displayName: string | null;
              shortDescription: string | null;
              parentTopicId: string;
              parentTopic: { label: string } | null;
            }>,
        ),
      prisma.department
        .findMany({
          where: { name: { contains: trimmed } },
          orderBy: { name: "asc" },
          take: perKind,
          select: { slug: true, name: true, scholarCount: true },
        })
        .catch(
          () =>
            [] as Array<{ slug: string; name: string; scholarCount: number }>,
        ),
      prisma.division
        .findMany({
          where: { name: { contains: trimmed } },
          orderBy: { name: "asc" },
          take: perKind,
          select: {
            slug: true,
            name: true,
            scholarCount: true,
            department: { select: { slug: true, name: true } },
          },
        })
        .catch(
          () =>
            [] as Array<{
              slug: string;
              name: string;
              scholarCount: number;
              department: { slug: string; name: string } | null;
            }>,
        ),
      prisma.center
        .findMany({
          where: { name: { contains: trimmed } },
          orderBy: { name: "asc" },
          take: perKind,
          select: {
            slug: true,
            name: true,
            scholarCount: true,
            centerType: true,
          },
        })
        .catch(
          () =>
            [] as Array<{
              slug: string;
              name: string;
              scholarCount: number;
              centerType: string;
            }>,
        ),
    ]);

  const out: EntitySuggestion[] = [];

  for (const p of people) {
    if (!p.slug) continue;
    const subParts = [p.primaryTitle, p.primaryDepartment].filter(
      (s): s is string => Boolean(s),
    );
    out.push({
      kind: "person",
      title: p.text,
      subtitle: subParts.join(" · ") || undefined,
      href: `/scholars/${p.slug}`,
      cwid: p.cwid,
    });
  }

  for (const t of topics) {
    out.push({
      kind: "topic",
      title: t.label,
      subtitle: "Research topic",
      href: `/topics/${t.id}`,
    });
  }

  for (const s of subtopics) {
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
    out.push({
      kind: "subtopic",
      title,
      subtitle,
      href: `/topics/${s.parentTopicId}?subtopic=${encodeURIComponent(s.id)}#publications`,
    });
  }

  for (const d of departments) {
    out.push({
      kind: "department",
      title: d.name,
      subtitle: d.scholarCount
        ? `Department · ${d.scholarCount.toLocaleString()} scholars`
        : "Department",
      href: `/departments/${d.slug}`,
    });
  }

  for (const d of divisions) {
    if (!d.department) continue;
    out.push({
      kind: "division",
      title: d.name,
      subtitle: `Division of ${d.department.name}`,
      href: `/departments/${d.department.slug}/divisions/${d.slug}`,
    });
  }

  for (const c of centers) {
    const isInstitute = c.centerType === "institute";
    const kindLabel = isInstitute ? "Institute" : "Center";
    out.push({
      kind: isInstitute ? "institute" : "center",
      title: c.name,
      subtitle: c.scholarCount
        ? `${kindLabel} · ${c.scholarCount.toLocaleString()} members`
        : kindLabel,
      href: `/centers/${c.slug}`,
    });
  }

  return out;
}
