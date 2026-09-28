/**
 * Clinical trials search tab (SEARCH_TRIALS_TAB) over `scholars-trials`.
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
export type TrialFilters = { status?: string[]; phase?: string[]; sponsorClass?: string[] };
export type TrialHit = Pick<
  TrialDoc,
  "trialId" | "nctNumber" | "title" | "status" | "statusBucket" | "phase" | "sponsorClass" | "principalSponsor" | "pis" | "conditions"
>;
type Bucket = { value: string; count: number };
export type TrialSearchResult = {
  hits: TrialHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: { status: Bucket[]; phase: Bucket[]; sponsorClass: Bucket[] };
};

const AXES = ["status", "phase", "sponsorClass"] as const;
type Axis = (typeof AXES)[number];
const FIELD: Record<Axis, string> = { status: "statusBucket", phase: "phase", sponsorClass: "sponsorClass" };

export function resolveTrialsTab(): boolean {
  return process.env.SEARCH_TRIALS_TAB === "on";
}

export function buildTrialsQuery(q: string, meshResolution: MeshResolution | null | undefined, scope: Scope) {
  const trimmed = q.trim();
  if (!trimmed) return { match_all: {} };
  const text = {
    multi_match: {
      query: trimmed,
      fields: ["title^4", "conditions^3", "meshTerms^2", "piNames^2", "briefSummary^1"],
      type: "best_fields" as const,
      operator: "and" as const,
    },
  };
  const uis = meshResolution?.descendantUis ?? [];
  if (uis.length === 0 || scope === "exact") return text;
  const concept = { terms: { meshDescriptorUi: uis, boost: 4 } };
  if (scope === "concept") return concept;
  return { bool: { should: [text, concept], minimum_should_match: 1 } };
}

export async function searchTrials(opts: {
  q: string;
  page?: number;
  filters?: TrialFilters;
  meshResolution?: MeshResolution | null;
  scope?: Scope;
  countOnly?: boolean;
}): Promise<TrialSearchResult> {
  const page = Math.max(0, opts.page ?? 0);
  const filters = opts.filters ?? {};
  const query = buildTrialsQuery(opts.q, opts.meshResolution, opts.scope ?? "expanded");
  const clauses = Object.fromEntries(
    AXES.filter((a) => filters[a]?.length).map((a) => [a, { terms: { [FIELD[a]]: filters[a] } }]),
  ) as Partial<Record<Axis, Record<string, unknown>>>;
  const except = (axis?: Axis) =>
    AXES.filter((a) => a !== axis && clauses[a]).map((a) => clauses[a]!);

  const client = searchClient();
  if (opts.countOnly) {
    const r = await client.count({
      index: TRIALS_INDEX,
      body: { query: { bool: { must: [query], filter: except() } } },
    });
    return { hits: [], total: r.body.count, page, pageSize: PAGE_SIZE, facets: { status: [], phase: [], sponsorClass: [] } };
  }

  const r = await client.search({
    index: TRIALS_INDEX,
    body: {
      from: page * PAGE_SIZE,
      size: PAGE_SIZE,
      track_total_hits: true,
      query,
      post_filter: { bool: { filter: except() } },
      // Relevance, then active before completed ("active" < "completed").
      sort: ["_score", { statusBucket: "asc" }, { trialId: "asc" }],
      _source: ["trialId", "nctNumber", "title", "status", "statusBucket", "phase", "sponsorClass", "principalSponsor", "pis", "conditions"],
      aggs: Object.fromEntries(
        AXES.map((a) => [
          a,
          { filter: { bool: { filter: except(a) } }, aggs: { keys: { terms: { field: FIELD[a], size: 20 } } } },
        ]),
      ),
    },
  });
  const body = r.body as unknown as {
    hits: { total: { value: number }; hits: Array<{ _source: TrialHit }> };
    aggregations: Record<Axis, { keys: { buckets: Array<{ key: string; doc_count: number }> } }>;
  };
  const buckets = (a: Axis): Bucket[] =>
    body.aggregations[a].keys.buckets.map((b) => ({ value: b.key, count: b.doc_count }));
  return {
    hits: body.hits.hits.map((h) => h._source),
    total: body.hits.total.value,
    page,
    pageSize: PAGE_SIZE,
    facets: { status: buckets("status"), phase: buckets("phase"), sponsorClass: buckets("sponsorClass") },
  };
}
