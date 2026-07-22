/**
 * GRANT spine — rank funding OPPORTUNITIES against a free-text ask, the grant-target sibling of
 * `rankResearchersForDescriptionSpine` (`matcha-spine-run.ts`). Grant Matcha convergence, increment 2
 * (`docs/2026-07-22-grant-matcha-convergence-plan.md`).
 *
 * It reuses Matcha's PURE, domain-neutral halves verbatim — extract (`extractMatchaConcepts`),
 * resolve-to-MeSH (`matchQueryToTaxonomy`), cluster (`mergeTermClusters`), cap (`selectWithMethodFloor`),
 * weight (`conceptWeight`), and fuse (`rrfFuse`). Only the two PEOPLE-specific seams change: retrieval
 * fans out over the `scholars-opportunities` index (by MeSH descendant-UI + title/synopsis) instead of
 * `searchPeople`, and hydration produces a `GrantCandidate` instead of a `MatchaCandidate`. Because the
 * output carries the same `{ concepts, candidates: { fusedScore, contributions } }` contract, the
 * client re-ranks grants with the exact same slider machinery it uses for people.
 *
 * v1 SIMPLICITY vs the people spine (deliberate — add when a grant surface needs them): NO dictionary
 * fallback (Bedrock outage ⇒ empty, not degraded-recall), NO gloss rescore, NO recency, NO per-concept
 * evidence, NO officer include-chips / culled tail, NO measures.
 *
 * ponytail: the extract→resolve→cluster→cap prefix below duplicates the people spine's ~30-line
 * sequence (both call the same exported helpers). Kept as a sibling rather than refactoring the
 * prod-critical people spine under a feature PR; extract a shared `prepareMatchaClusters` when a 3rd
 * target appears or the two drift.
 */
import { OPPORTUNITIES_INDEX, searchClient } from "@/lib/search";
import { normalizeDescription } from "@/lib/api/matcha";
import { extractMatchaConcepts } from "@/lib/api/matcha-extract";
import { matchQueryToTaxonomy } from "@/lib/api/search-taxonomy";
import { mergeTermClusters, selectWithMethodFloor, type ClusterTerm } from "@/lib/api/matcha-axes";
import { rrfFuse, type TermRanking } from "@/lib/api/matcha-spine";
import {
  conceptWeight,
  DEFAULT_K,
  type CulledConcept,
  type GrantCandidate,
  type MatchaConcept,
} from "@/lib/api/matcha-contract";

// These mirror the people spine's private tuning constants (`matcha-spine-run.ts`); they are not
// exported there. ponytail: kept local rather than widening that file's API for a sibling — extract
// a shared constants module if they ever need to move together.
const MAX_TERMS = 8;
const CLUSTER_TAU = 0.5;
const METHOD_FLOOR = 3;
const METHOD_THRESHOLD = 0.35;
const KIND_ALIGNED = 1.25;
const KIND_OFF_TARGET = 0.8;
// Per-cluster retrieval depth. One size-100 query per cluster: the opportunities corpus is ~1k, so a
// single page reaches the whole relevant tail — no paging loop (unlike the ~5k people pool).
const TERM_DEPTH = 100;

/** The opportunity fields hydrated onto a `GrantCandidate`, read from the index `_source`. */
const HYDRATE_SOURCE = [
  "opportunityId",
  "title",
  "synopsis",
  "sponsor",
  "mechanism",
  "status",
  "dueDate",
  "awardCeiling",
  "numberOfAwards",
];

type OpportunityHit = {
  opportunityId: string;
  title: string | null;
  synopsis: string | null;
  sponsor: string | null;
  mechanism: string | null;
  status: string | null;
  dueDate: string | null;
  awardCeiling: number | null;
  numberOfAwards: number | null;
};

export type GrantSpineResult = {
  concepts: MatchaConcept[];
  candidates: GrantCandidate[];
  titleSummary?: string;
  /** Always [] in v1 (no include-chips UI yet); present for envelope parity with the people spine. */
  culled?: CulledConcept[];
};

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The kind this ask targets — highest-centrality cluster's kind, ties by total mass, then "concept".
 * Mirrors the people spine's private `targetKindOf` so a grant cluster gets the same aligned/off-target
 * weight a people cluster would.
 */
function targetKindOf(
  clusters: readonly { kind: "concept" | "method"; centrality: number }[],
): "concept" | "method" {
  const stat = (k: "concept" | "method") => {
    const of = clusters.filter((c) => c.kind === k);
    return {
      max: of.reduce((m, c) => Math.max(m, c.centrality), 0),
      mass: of.reduce((s, c) => s + c.centrality, 0),
    };
  };
  const concept = stat("concept");
  const method = stat("method");
  if (method.max !== concept.max) return method.max > concept.max ? "method" : "concept";
  return method.mass > concept.mass ? "method" : "concept";
}

/**
 * Retrieve up to `TERM_DEPTH` opportunityIds for one concept cluster, in OpenSearch rank order.
 * Admission is a UNION — a title/synopsis text hit OR a `meshDescriptorUi` descendant-tag hit —
 * mirroring the funding search's concept-OR-text query (`searchFunding`), so a grant tagged with the
 * cluster's descriptor is found even without a literal text hit. Returns the ranked ids AND their
 * hydration hits so the caller needs no second round-trip. Any `searchClient` throw propagates (the
 * route maps it to 502 — no partial results, matching the people spine's posture).
 */
async function retrieveClusterGrants(
  clusterQuery: string,
  descendantUis: string[],
): Promise<{ ranked: string[]; hits: OpportunityHit[] }> {
  const should: Record<string, unknown>[] = [
    { multi_match: { query: clusterQuery, fields: ["title^2", "synopsis"], type: "best_fields" } },
  ];
  // MeSH-descendant admission, boosted like the funding search's concept clause. Absent when the
  // cluster did not resolve to a descriptor (text-only, byte-identical to a no-MeSH people cluster).
  if (descendantUis.length > 0) {
    should.push({ terms: { meshDescriptorUi: descendantUis, boost: 4 } });
  }
  const resp = await searchClient().search({
    index: OPPORTUNITIES_INDEX,
    body: {
      size: TERM_DEPTH,
      track_total_hits: false,
      _source: HYDRATE_SOURCE,
      query: { bool: { should, minimum_should_match: 1 } },
    } as object,
  });
  const hits =
    (resp.body as unknown as { hits?: { hits?: Array<{ _source?: Record<string, unknown> }> } })
      .hits?.hits ?? [];
  const ranked: string[] = [];
  const out: OpportunityHit[] = [];
  for (const h of hits) {
    const s = h._source ?? {};
    const id = strOrNull(s.opportunityId);
    if (!id) continue;
    ranked.push(id);
    out.push({
      opportunityId: id,
      title: strOrNull(s.title),
      synopsis: strOrNull(s.synopsis),
      sponsor: strOrNull(s.sponsor),
      mechanism: strOrNull(s.mechanism),
      status: strOrNull(s.status),
      dueDate: strOrNull(s.dueDate),
      awardCeiling: numOrNull(s.awardCeiling),
      numberOfAwards: numOrNull(s.numberOfAwards),
    });
  }
  return { ranked, hits: out };
}

export async function rankGrantsForDescriptionSpine(
  description: string,
  opts: { limit?: number } = {},
): Promise<GrantSpineResult> {
  const empty: GrantSpineResult = { concepts: [], candidates: [], culled: [] };
  const text = normalizeDescription(description);
  if (text.length === 0) return empty;

  // Extraction seam — reused verbatim. v1: no dictionary fallback, so an empty extraction (Bedrock
  // outage OR a genuinely conceptless ask) short-circuits to no grants rather than degrading recall.
  const extraction = await extractMatchaConcepts(text);
  const titleSummary = extraction.titleSummary;
  if (extraction.concepts.length === 0) return { ...empty, titleSummary };

  // Resolve → cluster → cap to MAX_TERMS distinct axes (method floor reserved). Identical to the
  // people spine's #1838 order (cluster before capping) — the shared helpers do the work.
  const clusterTerms: ClusterTerm[] = await Promise.all(
    extraction.concepts.map(async (c) => ({
      term: c.term,
      centrality: c.centrality,
      kind: c.kind,
      descendantUis: (await matchQueryToTaxonomy(c.term)).meshResolution?.descendantUis ?? [],
    })),
  );
  const allClusters = mergeTermClusters(clusterTerms, CLUSTER_TAU).map((c) => ({
    ...c,
    term: c.members[0],
  }));
  if (allClusters.length === 0) return { ...empty, titleSummary };
  const clusters = selectWithMethodFloor(allClusters, {
    max: MAX_TERMS,
    methodFloor: METHOD_FLOOR,
    methodThreshold: METHOD_THRESHOLD,
  });

  const targetKind = targetKindOf(clusters);
  const rankings: TermRanking[] = [];
  const concepts: MatchaConcept[] = [];
  const hitById = new Map<string, OpportunityHit>();
  for (const cluster of clusters) {
    const term = cluster.members[0];
    // The fixed half of the fusion weight (the slider owns the other half). Same rule as the people
    // spine: a cluster whose kind matches the ask's target kind is weighted up.
    const weightFactor = cluster.kind === targetKind ? KIND_ALIGNED : KIND_OFF_TARGET;
    const concept: MatchaConcept = {
      term,
      kind: cluster.kind,
      members: cluster.members,
      centrality: cluster.centrality,
      weightFactor,
    };
    concepts.push(concept);

    const { ranked, hits } = await retrieveClusterGrants(
      cluster.members.join(" "),
      cluster.descendantUis,
    );
    for (const h of hits) if (!hitById.has(h.opportunityId)) hitById.set(h.opportunityId, h);
    // `conceptWeight`, not an inline product — the contract owns the ONE weight definition the client
    // slider re-rank also calls, so the two never desync.
    rankings.push({ term, weight: conceptWeight(concept), ranked });
  }

  // rrfFuse is contract-agnostic: it treats `ranked` ids as opaque strings and names them `cwid` in
  // its output. Here that id IS the opportunityId. No recency map (v1).
  const allFused = rrfFuse(rankings, DEFAULT_K);
  const fused = opts.limit != null ? allFused.slice(0, opts.limit) : allFused;
  if (fused.length === 0) return { concepts, candidates: [], titleSummary, culled: [] };

  const candidates: GrantCandidate[] = fused.map((f) => {
    const hit = hitById.get(f.cwid); // f.cwid is the opaque fused id — the opportunityId here.
    return {
      opportunityId: f.cwid,
      title: hit?.title ?? null,
      sponsor: hit?.sponsor ?? null,
      mechanism: hit?.mechanism ?? null,
      status: hit?.status ?? null,
      dueDate: hit?.dueDate ?? null,
      awardCeiling: hit?.awardCeiling ?? null,
      numberOfAwards: hit?.numberOfAwards ?? null,
      synopsis: hit?.synopsis ?? null,
      fusedScore: f.score,
      contributions: f.contributions,
    };
  });
  return { concepts, candidates, titleSummary, culled: [] };
}
