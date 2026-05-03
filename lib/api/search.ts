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
 * Default-result filtering (spec line 196): incomplete profiles drop out of
 * default browse-style queries. The query layer applies an `isComplete: true`
 * filter when the user hasn't typed a name-anchored query (heuristic: query
 * length < 3 OR no quotes).
 */
import { identityImageEndpoint } from "@/lib/headshot";
import { prisma } from "@/lib/db";
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

export type PeopleFilters = {
  department?: string;
  hasActiveGrants?: boolean;
  personType?: string;
  /** When true, INCLUDE sparse profiles in results. Default: false (filter out). */
  includeIncomplete?: boolean;
};

export type PublicationsFilters = {
  yearMin?: number;
  yearMax?: number;
};

export type PeopleHit = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  publicationCount: number;
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
  pubmedUrl: string | null;
  wcmAuthors: Array<{ cwid: string; slug: string; preferredName: string; position: number }>;
  externalAuthors: string;
};

export type SearchFacetBucket = { value: string; count: number };

export type PeopleSearchResult = {
  hits: PeopleHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    departments: SearchFacetBucket[];
    personTypes: SearchFacetBucket[];
  };
};

export type PublicationsSearchResult = {
  hits: PublicationHit[];
  total: number;
  page: number;
  pageSize: number;
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
        facets: { departments: [], personTypes: [] },
      };
    }
    topicCwidFilter = topicCwids;
  }

  // Default-result filter: when the user is browsing (empty or very short
  // query), hide sparse profiles unless explicitly opted in.
  const applySparseFilter =
    !filters.includeIncomplete && trimmed.length < 3;

  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    must.push({
      multi_match: {
        query: trimmed,
        fields: [...PEOPLE_FIELD_BOOSTS],
        type: "best_fields",
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  const filter: Record<string, unknown>[] = [];
  if (filters.department) {
    filter.push({ term: { "primaryDepartment.keyword": filters.department } });
  }
  if (filters.personType) {
    filter.push({ term: { personType: filters.personType } });
  }
  if (typeof filters.hasActiveGrants === "boolean") {
    filter.push({ term: { hasActiveGrants: filters.hasActiveGrants } });
  }
  if (applySparseFilter) {
    filter.push({ term: { isComplete: true } });
  }
  // D-10 topic scope: restrict to the pre-resolved cwid set.
  if (topicCwidFilter && topicCwidFilter.length > 0) {
    filter.push({ terms: { cwid: topicCwidFilter } });
  }

  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "lastname") {
    sortClause.push({ "preferredName.keyword": "asc" });
  } else if (sort === "recentPub") {
    sortClause.push({ mostRecentPubDate: "desc" });
  }
  // 'relevance' uses default _score sort.

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    query: { bool: { must, filter } },
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
    aggs: {
      departments: {
        terms: { field: "primaryDepartment.keyword", size: 25 },
      },
      personTypes: {
        terms: { field: "personType", size: 10 },
      },
    },
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

  const resp = await searchClient().search({ index: PEOPLE_INDEX, body });

  type Hit = {
    _source: {
      cwid: string;
      slug: string;
      preferredName: string;
      primaryTitle: string | null;
      primaryDepartment: string | null;
      publicationCount: number;
      hasActiveGrants: boolean;
    };
    highlight?: Record<string, string[]>;
  };
  type Bucket = { key: string; doc_count: number };
  const r = resp.body as unknown as {
    hits: { hits: Hit[]; total: { value: number } };
    aggregations?: {
      departments?: { buckets: Bucket[] };
      personTypes?: { buckets: Bucket[] };
    };
  };

  return {
    hits: r.hits.hits.map((h) => ({
      cwid: h._source.cwid,
      slug: h._source.slug,
      preferredName: h._source.preferredName,
      primaryTitle: h._source.primaryTitle,
      primaryDepartment: h._source.primaryDepartment,
      publicationCount: h._source.publicationCount,
      hasActiveGrants: h._source.hasActiveGrants,
      identityImageEndpoint: identityImageEndpoint(h._source.cwid),
      highlight: h.highlight ? Object.values(h.highlight).flat() : undefined,
    })),
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    facets: {
      departments: (r.aggregations?.departments?.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      personTypes: (r.aggregations?.personTypes?.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
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

  const filter: Record<string, unknown>[] = [];
  if (filters.yearMin !== undefined || filters.yearMax !== undefined) {
    const range: Record<string, number> = {};
    if (filters.yearMin !== undefined) range.gte = filters.yearMin;
    if (filters.yearMax !== undefined) range.lte = filters.yearMax;
    filter.push({ range: { year: range } });
  }

  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "year") {
    sortClause.push({ year: "desc" });
  } else if (sort === "citations") {
    sortClause.push({ citationCount: "desc" });
  }

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    query: { bool: { must, filter } },
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
  };

  const resp = await searchClient().search({ index: PUBLICATIONS_INDEX, body });

  type Hit = {
    _source: {
      pmid: string;
      title: string;
      journal: string | null;
      year: number | null;
      publicationType: string | null;
      citationCount: number;
      doi: string | null;
      pubmedUrl: string | null;
      authorNames: string;
      wcmAuthors: Array<{ cwid: string; slug: string; preferredName: string; position: number }>;
    };
  };
  const r = resp.body as unknown as { hits: { hits: Hit[]; total: { value: number } } };

  return {
    hits: r.hits.hits.map((h) => ({
      pmid: h._source.pmid,
      title: h._source.title,
      journal: h._source.journal,
      year: h._source.year,
      publicationType: h._source.publicationType,
      citationCount: h._source.citationCount,
      doi: h._source.doi,
      pubmedUrl: h._source.pubmedUrl,
      wcmAuthors: h._source.wcmAuthors ?? [],
      externalAuthors: h._source.authorNames,
    })),
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
  };
}

/**
 * Autocomplete suggestions (spec line 184: fires on 2 chars).
 * Returns up to `size` distinct suggestions from the people index.
 */
export async function suggestNames(prefix: string, size = 5): Promise<
  Array<{ text: string; slug: string }>
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
      // Also fetch scholar slug for click-through
      _source: false,
    },
  });

  type SuggestOption = { text: string; _index: string; _id: string };
  type SuggestEntry = { options: SuggestOption[] };
  const suggestPayload = (resp.body as unknown as { suggest?: { scholar?: SuggestEntry[] } })
    .suggest?.scholar?.[0]?.options ?? [];

  // The completion suggester returns the document _id (CWID) and text.
  // We need the slug for the link target — fetch in a single mget.
  if (suggestPayload.length === 0) return [];
  const cwids = suggestPayload.map((o) => o._id);
  const mget = await searchClient().mget({
    index: PEOPLE_INDEX,
    body: { ids: cwids },
  });
  type MGetDoc = { _id: string; _source?: { slug?: string } };
  const slugByCwid = new Map<string, string>();
  for (const d of (mget.body as unknown as { docs: MGetDoc[] }).docs) {
    if (d._source?.slug) slugByCwid.set(d._id, d._source.slug);
  }

  return suggestPayload.map((o) => ({
    text: o.text,
    slug: slugByCwid.get(o._id) ?? "",
  }));
}
