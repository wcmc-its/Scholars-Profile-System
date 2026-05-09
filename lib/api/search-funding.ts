/**
 * Search-funding API — issue #80 items 4 + 5: OpenSearch port.
 *
 * Powers the third tab on the unified search results page. One hit per
 * *project* — pre-deduped at index time across the per-(scholar,
 * account_number) Grant rows. Returns the same shape as the v1 Prisma
 * implementation so callers don't change.
 *
 * Key shifts vs. v1:
 *   - Text relevance ranks against title + sponsor text + people names
 *     via a multi_match. v1 aliased "relevance" to endDate-asc.
 *   - Per-facet excluding-self aggregations. Each facet's bucket counts
 *     reflect the dataset with all OTHER axes' filters applied — ticking
 *     "Active" doesn't collapse the Funder list to only Active funders.
 *     Mirrors the searchPeople / searchPublications pattern.
 *   - Multi-select preserved on every axis (issue #80 requirement).
 *
 * Spec references:
 *   F1 — tab + sort options
 *   F2 — result row (title, people, sponsor, dates, mechanism, IDs)
 *   F3 — facets: Funder, Type, Mechanism, Status, Department, Role
 *   F6 — prime/direct sponsor + isSubaward
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  FUNDING_INDEX,
  FUNDING_FIELD_BOOSTS,
  searchClient,
} from "@/lib/search";
import { coreProjectNum } from "@/lib/award-number";

const PAGE_SIZE = 20;

/** 12 months grace beyond end_date (issue #78 Q6). */
const NCE_GRACE_MS = 365 * 24 * 60 * 60 * 1000;
const ENDING_SOON_MS = 365 * 24 * 60 * 60 * 1000;
const RECENTLY_ENDED_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type FundingSort = "relevance" | "endDate" | "startDate" | "pubCount";

export type FundingStatus = "active" | "ending_soon" | "recently_ended";

export type FundingRoleBucket = "PI" | "Multi-PI" | "Co-I";

export type FundingFilters = {
  /** Canonical sponsor short names (e.g. "NCI"). Filters on PRIME sponsor.
   *  Multi-select OR within the axis. */
  funder?: string[];
  /** Canonical sponsor short names matched against the DIRECT sponsor
   *  (subaward issuer). Multi-select OR within the axis (issue #80 item 7). */
  directFunder?: string[];
  /** programType values from InfoEd. Multi-select OR. */
  programType?: string[];
  /** NIH activity codes. Multi-select OR. */
  mechanism?: string[];
  /** Status buckets — multi-select OR. */
  status?: FundingStatus[];
  /** Lead-PI primary-department strings. Multi-select OR. */
  department?: string[];
  /** Role buckets — multi-select OR. */
  role?: FundingRoleBucket[];
  /** Issue #94 — WCM investigator CWIDs. Multi-select OR within the
   *  axis; matches the wcmAuthor filter pattern on the Publications
   *  search. */
  investigator?: string[];
};

/** Issue #94 — Investigator facet bucket, hydrated server-side with
 *  display name, slug, and avatar endpoint so the client component just
 *  renders. Mirrors WcmAuthorFacetBucket on the Publications search. */
export type WcmInvestigatorFacetBucket = {
  cwid: string;
  displayName: string;
  slug: string;
  identityImageEndpoint: string;
  count: number;
};

export type FundingPersonChip = {
  cwid: string;
  slug: string;
  preferredName: string;
  /** Per-person role on this grant: PI | Multi-PI | Co-I | Sub-PI | KP. */
  role: string;
  identityImageEndpoint: string;
};

export type FundingHit = {
  /** Project key — Account_Number from InfoEd. Dedupe key. */
  projectId: string;
  title: string;
  /** Canonical short when matched, raw fallback otherwise. */
  primeSponsor: string;
  primeSponsorRaw: string | null;
  /** Direct sponsor for subawards; null when WCM holds prime directly. */
  directSponsor: string | null;
  isSubaward: boolean;
  programType: string;
  mechanism: string | null;
  nihIc: string | null;
  awardNumber: string | null;
  /** YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  isActive: boolean;
  status: FundingStatus | "ended";
  isMultiPi: boolean;
  /** WCM scholars on the grant — lead PI first, Multi-PIs next, Co-Is last. */
  people: FundingPersonChip[];
  totalPeople: number;
  /** Department of record — typically lead PI's primary appointment. */
  department: string | null;
  /** Issue #86 — count of distinct PMIDs attributed to this project across
   *  its scholar rows. Drives the pubCount sort and is rendered on the
   *  result row. */
  pubCount: number;
  /** Issue #86 — RePORTER abstract for inline expansion on the result row. */
  abstract: string | null;
  /** Issue #92 — origin of `abstract`: 'reporter' | 'nsf' | 'pcori' | 'cdmrp' | 'gates'. */
  abstractSource: string | null;
  /** Issue #86 — RePORTER application ID; outbound deep-link target. */
  applId: number | null;
  /** Issue #86 — pub list for the inline expand affordance. Capped at
   *  PUB_LIST_CAP entries during indexing. */
  publications: Array<{
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    citationCount: number;
    isLowerConfidence: boolean;
  }>;
  /** Issue #86 — RePORTER core_project_num parsed from the awardNumber.
   *  Used by the expanded view to build the PubMed grant-search outbound
   *  link. Null for non-NIH grants. */
  coreProjectNum: string | null;
};

export type SearchFacetBucket = { value: string; count: number };

export type FundingSearchResult = {
  hits: FundingHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    funders: Array<{ value: string; label: string; count: number }>;
    directFunders: Array<{ value: string; label: string; count: number }>;
    programTypes: SearchFacetBucket[];
    mechanisms: SearchFacetBucket[];
    status: { active: number; endingSoon: number; recentlyEnded: number };
    departments: SearchFacetBucket[];
    roles: { pi: number; multiPi: number; coI: number };
    /** Issue #94 — top WCM investigators in the current result set,
     *  hydrated server-side. */
    investigators: WcmInvestigatorFacetBucket[];
    /** Total distinct WCM investigators across the current result set
     *  (header count). May exceed `investigators.length` when the agg
     *  cap is hit; mirrors `wcmAuthorsTotal` on the Publications search. */
    investigatorsTotal: number;
  };
};

/** Re-export the historical isFundingActive helper so existing callers
 *  (notably `lib/api/profile.ts`) keep their import shape. */
export function isFundingActive(endDate: Date, now: Date): boolean {
  return endDate.getTime() + NCE_GRACE_MS > now.getTime();
}

function statusForGrant(endDate: Date, now: Date): FundingStatus | "ended" {
  const t = endDate.getTime();
  const n = now.getTime();
  if (t + NCE_GRACE_MS <= n) {
    if (n - t <= RECENTLY_ENDED_WINDOW_MS) return "recently_ended";
    return "ended";
  }
  if (t - n <= ENDING_SOON_MS) return "ending_soon";
  return "active";
}

/** Build the date-range filter that corresponds to one or more status
 *  buckets. The OR-within-axis semantics translate to a `bool.should`
 *  with `minimum_should_match: 1` over per-bucket date ranges. */
function statusToFilterClause(
  statuses: FundingStatus[],
  now: Date,
): Record<string, unknown> | null {
  if (statuses.length === 0) return null;
  const should: Record<string, unknown>[] = [];
  if (statuses.includes("active")) {
    should.push({
      range: { endDate: { gt: new Date(now.getTime() - NCE_GRACE_MS).toISOString() } },
    });
  }
  if (statuses.includes("ending_soon")) {
    should.push({
      range: {
        endDate: {
          gte: now.toISOString(),
          lte: new Date(now.getTime() + ENDING_SOON_MS).toISOString(),
        },
      },
    });
  }
  if (statuses.includes("recently_ended")) {
    should.push({
      range: {
        endDate: {
          gte: new Date(now.getTime() - RECENTLY_ENDED_WINDOW_MS).toISOString(),
          lt: new Date(now.getTime() - NCE_GRACE_MS).toISOString(),
        },
      },
    });
  }
  if (should.length === 0) return null;
  return { bool: { should, minimum_should_match: 1 } };
}

export async function searchFunding(opts: {
  q: string;
  page?: number;
  sort?: FundingSort;
  filters?: FundingFilters;
}): Promise<FundingSearchResult> {
  const { q } = opts;
  const page = Math.max(0, opts.page ?? 0);
  const sort = opts.sort ?? "relevance";
  const filters = opts.filters ?? {};
  const trimmed = q.trim();
  const now = new Date();

  // Main query — text-only. User-axis filters live in post_filter so
  // each per-facet aggregation can re-apply only the OTHER axes and
  // produce correct excluding-self counts.
  const must: Record<string, unknown>[] = [];
  if (trimmed.length > 0) {
    must.push({
      multi_match: {
        query: trimmed,
        fields: [...FUNDING_FIELD_BOOSTS],
        type: "best_fields",
      },
    });
  } else {
    must.push({ match_all: {} });
  }

  // Named filter clauses — built once, re-used for post_filter and for
  // each per-facet excluding-self aggregation.
  const funderClause =
    filters.funder && filters.funder.length > 0
      ? { terms: { primeSponsor: filters.funder } }
      : null;
  const directFunderClause =
    filters.directFunder && filters.directFunder.length > 0
      ? { terms: { directSponsor: filters.directFunder } }
      : null;
  const programTypeClause =
    filters.programType && filters.programType.length > 0
      ? { terms: { programType: filters.programType } }
      : null;
  const mechanismClause =
    filters.mechanism && filters.mechanism.length > 0
      ? { terms: { mechanism: filters.mechanism } }
      : null;
  const statusClause = filters.status && filters.status.length > 0
    ? statusToFilterClause(filters.status, now)
    : null;
  const departmentClause =
    filters.department && filters.department.length > 0
      ? { terms: { department: filters.department } }
      : null;
  const roleClause =
    filters.role && filters.role.length > 0
      ? { terms: { roles: filters.role } }
      : null;
  const investigatorClause =
    filters.investigator && filters.investigator.length > 0
      ? { terms: { wcmInvestigatorCwids: filters.investigator } }
      : null;

  const userAxisFilters: Record<string, unknown>[] = [];
  if (funderClause) userAxisFilters.push(funderClause);
  if (directFunderClause) userAxisFilters.push(directFunderClause);
  if (programTypeClause) userAxisFilters.push(programTypeClause);
  if (mechanismClause) userAxisFilters.push(mechanismClause);
  if (statusClause) userAxisFilters.push(statusClause);
  if (departmentClause) userAxisFilters.push(departmentClause);
  if (roleClause) userAxisFilters.push(roleClause);
  if (investigatorClause) userAxisFilters.push(investigatorClause);

  type Axis =
    | "funder"
    | "directFunder"
    | "programType"
    | "mechanism"
    | "status"
    | "department"
    | "role"
    | "investigator";

  const filtersExcept = (axis: Axis): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    if (axis !== "funder" && funderClause) out.push(funderClause);
    if (axis !== "directFunder" && directFunderClause) out.push(directFunderClause);
    if (axis !== "programType" && programTypeClause) out.push(programTypeClause);
    if (axis !== "mechanism" && mechanismClause) out.push(mechanismClause);
    if (axis !== "status" && statusClause) out.push(statusClause);
    if (axis !== "department" && departmentClause) out.push(departmentClause);
    if (axis !== "role" && roleClause) out.push(roleClause);
    if (axis !== "investigator" && investigatorClause) out.push(investigatorClause);
    return out;
  };

  // Sort. relevance falls through to default _score; endDate uses a
  // script sort so active grants surface first (the 12-month NCE grace
  // means the active threshold is `endDate + 365d > now`); startDate
  // sorts newest-first.
  const sortClause: Record<string, unknown>[] = [];
  if (sort === "endDate") {
    sortClause.push({
      _script: {
        type: "number",
        script: {
          source:
            "doc['endDate'].size() == 0 ? 1 : (doc['endDate'].value.toInstant().toEpochMilli() + params.grace > params.now ? 0 : 1)",
          params: {
            now: now.getTime(),
            grace: NCE_GRACE_MS,
          },
        },
        order: "asc",
      },
    });
    sortClause.push({ endDate: "asc" });
  } else if (sort === "startDate") {
    sortClause.push({ startDate: "desc" });
  } else if (sort === "pubCount") {
    // Most-publications first. Ties broken by endDate desc so an active
    // grant with the same count surfaces above a completed one.
    sortClause.push({ pubCount: "desc" });
    sortClause.push({ endDate: "desc" });
  }

  // Status agg — three separate filter aggs since each "bucket" is a
  // date range, not a discrete keyword. Each excludes the status axis
  // from its filter chain so ticking "Active" doesn't zero out the
  // "Ending in 12 months" count.
  const statusBaseFilters = filtersExcept("status");
  const activeRange: Record<string, unknown> = {
    range: { endDate: { gt: new Date(now.getTime() - NCE_GRACE_MS).toISOString() } },
  };
  const endingSoonRange: Record<string, unknown> = {
    range: {
      endDate: {
        gte: now.toISOString(),
        lte: new Date(now.getTime() + ENDING_SOON_MS).toISOString(),
      },
    },
  };
  const recentlyEndedRange: Record<string, unknown> = {
    range: {
      endDate: {
        gte: new Date(now.getTime() - RECENTLY_ENDED_WINDOW_MS).toISOString(),
        lt: new Date(now.getTime() - NCE_GRACE_MS).toISOString(),
      },
    },
  };

  const aggs: Record<string, unknown> = {
    funders: {
      filter: { bool: { must, filter: filtersExcept("funder") } },
      aggs: { keys: { terms: { field: "primeSponsor", size: 50 } } },
    },
    directFunders: {
      filter: { bool: { must, filter: filtersExcept("directFunder") } },
      aggs: { keys: { terms: { field: "directSponsor", size: 50 } } },
    },
    programTypes: {
      filter: { bool: { must, filter: filtersExcept("programType") } },
      aggs: { keys: { terms: { field: "programType", size: 20 } } },
    },
    mechanisms: {
      filter: { bool: { must, filter: filtersExcept("mechanism") } },
      aggs: { keys: { terms: { field: "mechanism", size: 30 } } },
    },
    departments: {
      filter: { bool: { must, filter: filtersExcept("department") } },
      aggs: { keys: { terms: { field: "department", size: 30 } } },
    },
    roleBuckets: {
      filter: { bool: { must, filter: filtersExcept("role") } },
      aggs: { keys: { terms: { field: "roles", size: 5 } } },
    },
    // Issue #94 — Investigator facet. Top 500 mirrors the Author facet
    // on the Publications search; client-side typeahead narrows further.
    // Cardinality sub-agg surfaces the true distinct count for the rail
    // header so the user sees the full scope of the facet.
    investigators: {
      filter: { bool: { must, filter: filtersExcept("investigator") } },
      aggs: {
        keys: { terms: { field: "wcmInvestigatorCwids", size: 500 } },
        total: {
          cardinality: { field: "wcmInvestigatorCwids", precision_threshold: 4000 },
        },
      },
    },
    statusActive: {
      filter: { bool: { must, filter: [...statusBaseFilters, activeRange] } },
    },
    statusEndingSoon: {
      filter: { bool: { must, filter: [...statusBaseFilters, endingSoonRange] } },
    },
    statusRecentlyEnded: {
      filter: { bool: { must, filter: [...statusBaseFilters, recentlyEndedRange] } },
    },
  };

  const body = {
    from: page * PAGE_SIZE,
    size: PAGE_SIZE,
    track_total_hits: true,
    query: { bool: { must } },
    ...(userAxisFilters.length > 0
      ? { post_filter: { bool: { filter: userAxisFilters } } }
      : {}),
    ...(sortClause.length > 0 ? { sort: sortClause } : {}),
    aggs,
  };

  const resp = await searchClient().search({
    index: FUNDING_INDEX,
    body: body as object,
  });

  type StoredPerson = {
    cwid: string;
    slug: string;
    preferredName: string;
    role: string;
  };
  type Hit = {
    _source: {
      projectId: string;
      title: string;
      primeSponsor: string;
      primeSponsorRaw: string | null;
      directSponsor: string | null;
      isSubaward: boolean;
      programType: string;
      mechanism: string | null;
      nihIc: string | null;
      awardNumber: string | null;
      startDate: string;
      endDate: string;
      isMultiPi: boolean;
      department: string | null;
      totalPeople: number;
      people: StoredPerson[];
      pubCount: number;
      abstract: string | null;
      abstractSource: string | null;
      applId: number | null;
      publications: Array<{
        pmid: string;
        title: string;
        journal: string | null;
        year: number | null;
        citationCount: number;
        isLowerConfidence: boolean;
      }>;
    };
  };
  type Bucket = { key: string; doc_count: number };
  const r = resp.body as unknown as {
    hits: { hits: Hit[]; total: { value: number } };
    aggregations?: {
      funders?: { keys: { buckets: Bucket[] } };
      directFunders?: { keys: { buckets: Bucket[] } };
      programTypes?: { keys: { buckets: Bucket[] } };
      mechanisms?: { keys: { buckets: Bucket[] } };
      departments?: { keys: { buckets: Bucket[] } };
      roleBuckets?: { keys: { buckets: Bucket[] } };
      statusActive?: { doc_count: number };
      statusEndingSoon?: { doc_count: number };
      statusRecentlyEnded?: { doc_count: number };
      investigators?: {
        keys: { buckets: Bucket[] };
        total: { value: number };
      };
    };
  };

  const hits: FundingHit[] = r.hits.hits.map((h) => {
    const src = h._source;
    const endDate = new Date(src.endDate);
    return {
      projectId: src.projectId,
      title: src.title,
      primeSponsor: src.primeSponsor,
      primeSponsorRaw: src.primeSponsorRaw,
      directSponsor: src.directSponsor,
      isSubaward: src.isSubaward,
      programType: src.programType,
      mechanism: src.mechanism,
      nihIc: src.nihIc,
      awardNumber: src.awardNumber,
      startDate: src.startDate.slice(0, 10),
      endDate: src.endDate.slice(0, 10),
      isActive: isFundingActive(endDate, now),
      status: statusForGrant(endDate, now),
      isMultiPi: src.isMultiPi,
      department: src.department,
      totalPeople: src.totalPeople,
      pubCount: src.pubCount ?? 0,
      abstract: src.abstract ?? null,
      abstractSource: src.abstractSource ?? null,
      applId: src.applId ?? null,
      publications: src.publications ?? [],
      coreProjectNum: coreProjectNum(src.awardNumber),
      people: (src.people ?? []).map((p) => ({
        cwid: p.cwid,
        slug: p.slug,
        preferredName: p.preferredName,
        role: p.role,
        identityImageEndpoint: identityImageEndpoint(p.cwid),
      })),
    };
  });

  // Role bucket map — convert keyword agg to the named structure.
  const roleBucketMap = new Map<string, number>(
    (r.aggregations?.roleBuckets?.keys.buckets ?? []).map((b) => [b.key, b.doc_count]),
  );

  // Issue #94 — hydrate Investigator facet buckets with display name +
  // slug + avatar in a single Prisma round trip. Active selections may
  // not appear in the top-500 result set, so include them in the lookup
  // so the rail can pin them with a real label rather than the bare CWID.
  const investigatorBuckets = r.aggregations?.investigators?.keys.buckets ?? [];
  const facetCwids = new Set(investigatorBuckets.map((b) => b.key));
  if (filters.investigator) for (const c of filters.investigator) facetCwids.add(c);
  const facetCwidList = Array.from(facetCwids);
  const scholarRows = facetCwidList.length === 0
    ? []
    : await prisma.scholar.findMany({
        where: { cwid: { in: facetCwidList }, deletedAt: null, status: "active" },
        select: { cwid: true, preferredName: true, slug: true },
      });
  const scholarByCwid = new Map(scholarRows.map((s) => [s.cwid, s]));
  const investigators: WcmInvestigatorFacetBucket[] = investigatorBuckets.flatMap((b) => {
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
  // Surface active selections even with zero count so the rail can pin
  // them in the selected section after other filters knock their count
  // to zero (or below the top-500 cutoff).
  if (filters.investigator) {
    const present = new Set(investigators.map((b) => b.cwid));
    for (const cwid of filters.investigator) {
      if (present.has(cwid)) continue;
      const s = scholarByCwid.get(cwid);
      if (!s) continue;
      investigators.push({
        cwid: s.cwid,
        displayName: s.preferredName,
        slug: s.slug,
        identityImageEndpoint: identityImageEndpoint(s.cwid),
        count: 0,
      });
    }
  }

  return {
    hits,
    total: r.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    facets: {
      funders: (r.aggregations?.funders?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        label: b.key,
        count: b.doc_count,
      })),
      directFunders: (r.aggregations?.directFunders?.keys.buckets ?? []).map(
        (b) => ({ value: b.key, label: b.key, count: b.doc_count }),
      ),
      programTypes: (r.aggregations?.programTypes?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      mechanisms: (r.aggregations?.mechanisms?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      status: {
        active: r.aggregations?.statusActive?.doc_count ?? 0,
        endingSoon: r.aggregations?.statusEndingSoon?.doc_count ?? 0,
        recentlyEnded: r.aggregations?.statusRecentlyEnded?.doc_count ?? 0,
      },
      departments: (r.aggregations?.departments?.keys.buckets ?? []).map((b) => ({
        value: b.key,
        count: b.doc_count,
      })),
      roles: {
        pi: roleBucketMap.get("PI") ?? 0,
        multiPi: roleBucketMap.get("Multi-PI") ?? 0,
        coI: roleBucketMap.get("Co-I") ?? 0,
      },
      investigators,
      investigatorsTotal: r.aggregations?.investigators?.total.value ?? 0,
    },
  };
}
