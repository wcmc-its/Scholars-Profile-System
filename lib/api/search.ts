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

  // Default-result filter: when the user is browsing (empty or very short
  // query), hide sparse profiles unless explicitly opted in.
  const applySparseFilter =
    !filters.includeIncomplete && trimmed.length < 3;
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

  // The filter array used by the main hits query (includes everything).
  const filter: Record<string, unknown>[] = [];
  if (deptDivClause) filter.push(deptDivClause);
  if (personTypeClause) filter.push(personTypeClause);
  for (const c of activityClauses) filter.push(c);
  if (sparseClause) filter.push(sparseClause);
  if (topicClause) filter.push(topicClause);

  // Helper: build the "all filters except this one" clause set for a given
  // facet's excluding-self aggregation.
  const filtersExcept = (axis: "deptDiv" | "personType" | "activity") => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "deptDiv" && deptDivClause) out.push(deptDivClause);
    if (axis !== "personType" && personTypeClause) out.push(personTypeClause);
    if (axis !== "activity") for (const c of activityClauses) out.push(c);
    if (sparseClause) out.push(sparseClause);
    if (topicClause) out.push(topicClause);
    return out;
  };

  const sortClause: Record<string, "asc" | "desc">[] = [];
  if (sort === "lastname") {
    sortClause.push({ "preferredName.keyword": "asc" });
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
      aggs: {
        keys: {
          terms: { field: "deptDivKey", size: 50 },
          aggs: { label: { terms: { field: "deptDivLabel", size: 1 } } },
        },
      },
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
    query: { bool: { must, filter } },
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
  type DeptDivBucketRaw = Bucket & { label?: { buckets: Array<{ key: string }> } };
  const r = resp.body as unknown as {
    hits: { hits: Hit[]; total: { value: number } };
    aggregations?: {
      deptDivs?: { keys: { buckets: DeptDivBucketRaw[] } };
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
        label: b.label?.buckets?.[0]?.key ?? b.key,
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
