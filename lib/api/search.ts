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
  publicationType?: string;
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
  facets: {
    publicationTypes: SearchFacetBucket[];
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
  if (filters.publicationType) {
    filter.push({ term: { publicationType: filters.publicationType } });
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
    aggs: {
      publicationTypes: {
        terms: { field: "publicationType", size: 15 },
      },
    },
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
    };
  };
  type Bucket = { key: string; doc_count: number };
  const r = resp.body as unknown as {
    hits: { hits: Hit[]; total: { value: number } };
    aggregations?: {
      publicationTypes?: { buckets: Bucket[] };
    };
  };

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
      publicationTypes: (r.aggregations?.publicationTypes?.buckets ?? []).map((b) => ({
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
    return {
      text: o.text,
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
  | "center";

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
      Promise.resolve(
        [] as Array<{ slug: string; name: string; scholarCount: number }>,
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
      href: `/topics/${s.parentTopicId}?subtopic=${encodeURIComponent(s.id)}`,
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
    out.push({
      kind: "center",
      title: c.name,
      subtitle: c.scholarCount
        ? `Center · ${c.scholarCount.toLocaleString()} scholars`
        : "Center",
      href: `/centers/${c.slug}`,
    });
  }

  return out;
}
