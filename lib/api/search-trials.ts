/**
 * Clinical research search tab (SEARCH_TRIALS_TAB) over `scholars-trials`.
 *
 * Text match on title / conditions / MeSH labels / summary / PI names, plus the
 * resolved MeSH concept on `meshDescriptorUi` (CT.gov MeSH, NLM-assigned). Scope
 * follows the Funding tab: `exact` = text only, `expanded` = text OR concept,
 * `concept` = concept only. User filters ride post_filter; each facet agg
 * re-applies only the OTHER axes, so counts are excluding-self.
 */
import { searchClient, TRIALS_INDEX } from "@/lib/search";
import type { MeshResolution } from "@/lib/api/search-taxonomy";
import type { Scope } from "@/lib/api/search-flags";
import type { TrialDoc } from "@/lib/search-trial-evidence";

const PAGE_SIZE = 20;

export type TrialStatusBucket = "active" | "completed";
export type TrialSort = "relevance" | "recent" | "recruiting";
export const TRIAL_AXES = [
  "status",
  "studyType",
  "phase",
  "investigator",
  "department",
  "condition",
  "interventionType",
  "sponsorClass",
] as const;
export type TrialAxis = (typeof TRIAL_AXES)[number];
/** Checkbox axes, plus the Start date year range and "Has results posted". */
export type TrialFilters = Partial<Record<TrialAxis, string[]>> & {
  startFrom?: number;
  startTo?: number;
  hasResults?: boolean;
};
/** Non-checkbox filters, each its own excluding-self key like the axes. */
type TrialFilterKey = TrialAxis | "startYear" | "hasResults";
/** Text fields a hit can match on (highlight keys), for the row's match line. */
export type TrialMatchField = "title" | "conditions" | "meshTerms" | "piNames" | "briefSummary";
export type TrialHit = Pick<
  TrialDoc,
  | "trialId"
  | "nctNumber"
  | "title"
  | "status"
  | "statusBucket"
  | "phase"
  | "studyType"
  | "sponsorClass"
  | "principalSponsor"
  | "pis"
  | "conditions"
  | "statusKey"
  | "startDate"
  | "startEstimated"
  | "endDate"
  | "endEstimated"
  | "interventions"
  | "hasResults"
> & { matchedConcept: boolean; matchedFields: TrialMatchField[] };
/** `label` is set where the key isn't display text (investigator = cwid). */
export type TrialBucket = { value: string; count: number; label?: string };
export type TrialSearchResult = {
  hits: TrialHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: Record<TrialAxis, TrialBucket[]>;
  /** Studies with results posted, under every other filter. */
  hasResultsCount: number;
};

const FIELD: Record<TrialAxis, string> = {
  status: "statusKey",
  studyType: "studyTypeKeys",
  phase: "phase",
  investigator: "piCwids",
  department: "departments",
  condition: "meshLabels",
  interventionType: "interventionTypes",
  sponsorClass: "sponsorClass",
};
const SOURCE = [
  "trialId",
  "nctNumber",
  "title",
  "status",
  "statusBucket",
  "phase",
  "studyType",
  "sponsorClass",
  "principalSponsor",
  "pis",
  "conditions",
  "statusKey",
  "startDate",
  "startEstimated",
  "endDate",
  "endEstimated",
  "interventions",
  "hasResults",
];
const MATCH_FIELDS: TrialMatchField[] = [
  "title",
  "conditions",
  "meshTerms",
  "piNames",
  "briefSummary",
];

export function resolveTrialsTab(): boolean {
  return process.env.SEARCH_TRIALS_TAB === "on";
}

export function buildTrialsQuery(
  q: string,
  meshResolution: MeshResolution | null | undefined,
  scope: Scope,
) {
  const trimmed = q.trim();
  if (!trimmed) return { match_all: {} };
  const text = {
    multi_match: {
      query: trimmed,
      fields: ["title^4", "conditions^3", "meshTerms^2", "piNames^2", "briefSummary^1"],
      type: "best_fields" as const,
      operator: "and" as const,
      _name: "text",
    },
  };
  const uis = meshResolution?.descendantUis ?? [];
  if (uis.length === 0 || scope === "exact") return text;
  const concept = { terms: { meshDescriptorUi: uis, boost: 4, _name: "concept" } };
  if (scope === "concept") return concept;
  return { bool: { should: [text, concept], minimum_should_match: 1 } };
}

const emptyFacets = () =>
  Object.fromEntries(TRIAL_AXES.map((a) => [a, []])) as unknown as Record<TrialAxis, TrialBucket[]>;

export async function searchTrials(opts: {
  q: string;
  page?: number;
  sort?: TrialSort;
  filters?: TrialFilters;
  meshResolution?: MeshResolution | null;
  scope?: Scope;
  countOnly?: boolean;
}): Promise<TrialSearchResult> {
  const page = Math.max(0, opts.page ?? 0);
  const filters = opts.filters ?? {};
  const query = buildTrialsQuery(opts.q, opts.meshResolution, opts.scope ?? "expanded");
  const clauses: Partial<Record<TrialFilterKey, Record<string, unknown>>> = Object.fromEntries(
    TRIAL_AXES.filter((a) => filters[a]?.length).map((a) => [
      a,
      { terms: { [FIELD[a]]: filters[a] } },
    ]),
  );
  if (filters.startFrom !== undefined || filters.startTo !== undefined) {
    clauses.startYear = { range: { startYear: { gte: filters.startFrom, lte: filters.startTo } } };
  }
  if (filters.hasResults) clauses.hasResults = { term: { hasResults: true } };
  const except = (key?: TrialFilterKey) =>
    (Object.keys(clauses) as TrialFilterKey[]).filter((k) => k !== key).map((k) => clauses[k]!);

  const client = searchClient();
  if (opts.countOnly) {
    const r = await client.count({
      index: TRIALS_INDEX,
      body: { query: { bool: { must: [query], filter: except() } } },
    });
    return {
      hits: [],
      total: r.body.count,
      page,
      pageSize: PAGE_SIZE,
      facets: emptyFacets(),
      hasResultsCount: 0,
    };
  }

  // Relevance breaks ties active-first ("active" < "completed").
  const active = { statusBucket: "asc" as const };
  const tie = { trialId: "asc" as const };
  const sort =
    opts.sort === "recent"
      ? [{ startDate: { order: "desc" as const, missing: "_last" as const } }, "_score", tie]
      : opts.sort === "recruiting"
        ? [{ statusRank: "asc" as const }, "_score", tie]
        : ["_score", active, tie];
  const r = await client.search({
    index: TRIALS_INDEX,
    body: {
      from: page * PAGE_SIZE,
      size: PAGE_SIZE,
      track_total_hits: true,
      query,
      post_filter: { bool: { filter: except() } },
      sort,
      _source: SOURCE,
      // Only which fields matched is read (the row's match line), not fragments.
      highlight: {
        fields: Object.fromEntries(
          MATCH_FIELDS.map((f) => [f, { number_of_fragments: 1, fragment_size: 1 }]),
        ),
      },
      aggs: {
        hasResults: {
          filter: { bool: { filter: [...except("hasResults"), { term: { hasResults: true } }] } },
        },
        ...Object.fromEntries(
          TRIAL_AXES.map((a) => [
            a,
            {
              filter: { bool: { filter: except(a) } },
              aggs: {
                keys: {
                  terms: {
                    field: FIELD[a],
                    size: a === "investigator" || a === "condition" || a === "department" ? 50 : 20,
                  },
                  // PI names aren't indexed as keywords; one doc's `pis` carries the label.
                  ...(a === "investigator"
                    ? { aggs: { doc: { top_hits: { size: 1, _source: ["pis"] } } } }
                    : {}),
                },
              },
            },
          ]),
        ),
      },
    },
  });
  type RawBucket = {
    key: string;
    doc_count: number;
    doc?: { hits: { hits: Array<{ _source: Pick<TrialDoc, "pis"> }> } };
  };
  const body = r.body as unknown as {
    hits: {
      total: { value: number };
      hits: Array<{
        _source: TrialHit;
        matched_queries?: string[];
        highlight?: Record<string, string[]>;
      }>;
    };
    aggregations: Record<TrialAxis, { keys: { buckets: RawBucket[] } }> & {
      hasResults: { doc_count: number };
    };
  };
  const facets = emptyFacets();
  for (const a of TRIAL_AXES) {
    facets[a] = body.aggregations[a].keys.buckets.map((b) => ({
      value: b.key,
      count: b.doc_count,
      ...(a === "investigator"
        ? { label: b.doc?.hits.hits[0]?._source.pis.find((p) => p.cwid === b.key)?.name ?? b.key }
        : {}),
    }));
  }
  return {
    hits: body.hits.hits.map((h) => ({
      ...h._source,
      matchedConcept: (h.matched_queries ?? []).includes("concept"),
      matchedFields: MATCH_FIELDS.filter((f) => h.highlight?.[f]),
    })),
    total: body.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    facets,
    hasResultsCount: body.aggregations.hasResults.doc_count,
  };
}
