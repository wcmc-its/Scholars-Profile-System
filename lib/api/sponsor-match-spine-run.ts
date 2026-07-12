/**
 * Sponsor-match searchPeople SPINE — impure per-term composition
 * (pivot handoff `docs/2026-07-11-sponsor-match-searchpeople-pivot-handoff.md`
 * §4/§6). The pure helpers stay in `sponsor-match-spine.ts` (extraction, RRF)
 * and `sponsor-match-axes.ts` (dampedIdf, clustering); THIS module owns the
 * side-effecting glue the bake-off runs behind `SPONSOR_MATCH_SPINE`:
 *
 *   paste ─▶ extractTerms(vocab) ─▶ per-term matchQueryToTaxonomy (MeSH set)
 *         ─▶ mergeTermClusters (dedup redundant phrasing)
 *         ─▶ per-cluster searchPeople (topical-only: faculty/grant prominence OFF)
 *         ─▶ weight = centrality × dampedIdf(coverage) ─▶ rrfFuse(rank) ─▶ top-N
 *
 * Contrast with the bespoke `rankResearchersForDescription`: that path is ONE
 * BM25 round-trip over the whole paste × Variant-B; this path decomposes the
 * paste into concepts and fuses per-concept people rankings on RANK (the
 * `searchPeople` BM25 scores are query-scaled and NOT cross-comparable). The two
 * engines run side-by-side on the same deploy so the offline eval can score
 * ORDER; nothing here is wired live until the sub-flag flips.
 *
 * VOCAB (v1): the curated taxonomy term labels — `Topic.label` + `Subtopic.label`.
 * These are the surface forms `matchQueryToTaxonomy` is built to resolve (they ARE
 * the taxonomy), so extraction and MeSH resolution stay consistent with zero extra
 * infrastructure and no method-pages flag dependency. CEILING: dozens of parent
 * topics + hundreds of subtopics; a sponsor phrase that isn't a taxonomy label
 * (paraphrase, brand name, un-catalogued method) is missed. Paraphrase recall +
 * rubric centrality are the Bedrock front-end upgrade (§7-Q1); `extractTerms`'
 * dictionary match is a drop-in seam for it.
 *
 * CENTRALITY (v1): uniform 1.0 for every term. The LLM extractor owns real
 * per-term centrality later; until then the fusion weight is idf-only.
 */
import { db } from "@/lib/db";
import { extractTerms, rrfFuse, type TermRanking } from "@/lib/api/sponsor-match-spine";
import {
  dampedIdf,
  mergeTermClusters,
  type ClusterTerm,
} from "@/lib/api/sponsor-match-axes";
import { searchPeople, type PeopleHit } from "@/lib/api/search";
import { meshMatchTier } from "@/lib/search";
import { matchQueryToTaxonomy, type MeshResolution } from "@/lib/api/search-taxonomy";
import {
  normalizeDescription,
  type SponsorRankedScholar,
} from "@/lib/api/sponsor-match";

/** Mirrors `sponsor-match.ts` DEFAULT_LIMIT — the client facets narrow browser-side. */
const SPINE_DEFAULT_LIMIT = 100;

/** Uniform per-term centrality until the LLM extractor supplies real values (§5a). */
const UNIFORM_CENTRALITY = 1;

/** dampedIdf ceiling — a 1-in-corpus concept can't dominate the fusion. Matches the
 *  scale the axes tests exercise. */
const IDF_CAP = 10;

/** Fallback idf FACTOR when a cluster's coverage signal is absent OR known-zero.
 *  Absent = no `mesh_descriptor` row / NULL (coverage not yet computed). Known-zero =
 *  the coverage ETL writes `COALESCE(n_pubs, 0) / total` for EVERY descriptor, so a
 *  root descriptor with no directly-tagged local pubs carries 0 — common for broad
 *  descriptors (MEDLINE indexes the most-specific term; the fraction counts only
 *  direct root-UI tags, not the descendant subtree the retrieval spans). Neither
 *  state is evidence the concept is rare, so treat the idf as neutral (1): the
 *  cluster neither up- nor down-weights relative to known concepts — NEVER the `cap`
 *  branch `dampedIdf` takes for a non-positive coverage number (unknown-or-zero ≠
 *  maximally rare; the cap would hand a zero-evidence concept the MAXIMUM fusion
 *  weight and let its lexical-only hits dominate the RRF). */
const NEUTRAL_IDF = 1;

/** Jaccard merge threshold for `mergeTermClusters`. Subsumption always merges; this
 *  gates partial overlap (same concept phrased differently). Moderate so near-identical
 *  descendant sets collapse but distinct concepts stay separate. */
const CLUSTER_TAU = 0.5;

/** Hard cap on extracted terms. `mergeTermClusters` documents a small-list (≤ ~12
 *  terms) assumption, and every term costs one taxonomy resolution + (per cluster)
 *  up to MAX_PAGES sequential `searchPeople` round-trips — a taxonomy-dense 3,000-char
 *  paste could otherwise extract 100+ labels and stall the worker for minutes.
 *  Truncation keeps the FIRST vocab-order terms (deterministic; see
 *  `loadTaxonomyVocab`) — acceptable for the dark bake-off tool; the LLM extractor
 *  owns real term selection later (§7-Q1). */
const MAX_TERMS = 12;

/** Per-term retrieval depth. `searchPeople` pages at its own module-private page
 *  size (20 today, not overridable) and reports it as `pageSize` on every result —
 *  the paging loop keys its short-page stop to THAT, never to a copied constant
 *  that could silently drift. ~100 candidates = up to 5 sequential pages today;
 *  MAX_PAGES is only a defensive absolute cap on per-cluster round-trips (it covers
 *  full depth for any page size ≥ 10). */
const TERM_DEPTH = 100;
const MAX_PAGES = 10;

/** Load the v1 vocab: every curated taxonomy label (topics + subtopics). Two bounded
 *  reads; the union is the dictionary `extractTerms` scans the paste against.
 *  Ordered (label asc) so the vocab — and everything downstream of it: extraction
 *  order, cluster member order, the cluster's joined query string, the
 *  representative resolution, RRF tie-breaks — is DETERMINISTIC across runs/envs
 *  instead of riding unspecified DB row order (the bake-off compares runs). */
async function loadTaxonomyVocab(): Promise<string[]> {
  const [topics, subs] = await Promise.all([
    db.read.topic.findMany({ select: { label: true }, orderBy: { label: "asc" } }),
    db.read.subtopic.findMany({ select: { label: true }, orderBy: { label: "asc" } }),
  ]);
  return [...topics.map((t) => t.label), ...subs.map((s) => s.label)];
}

/** One term's MeSH resolution, kept alongside the term so the cluster can carry the
 *  representative descriptor identity (name/tier) and the coverage lookup key. */
type ResolvedTerm = { term: string; resolution: MeshResolution | null };

/** Retrieve up to `TERM_DEPTH` scholar cwids for one cluster, in `searchPeople` rank
 *  order, paging as needed. Topical-only: the expertise-independent employment priors
 *  (faculty + active-grant prominence) are OFF so ranking reflects fit alone. A
 *  representative resolution supplies the MeSH attribution signals; `meshDescendantUis`
 *  is the cluster's UNION so the boost spans all merged synonyms. Also returns the
 *  page hits so the caller can source display fields without a second round-trip.
 *  Any `searchPeople` throw propagates (the route maps it to 502 — no partial results). */
async function retrieveCluster(
  clusterQuery: string,
  descendantUis: string[],
  rep: MeshResolution | null,
): Promise<{ ranked: string[]; hits: PeopleHit[] }> {
  const ranked: string[] = [];
  const hits: PeopleHit[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await searchPeople({
      q: clusterQuery,
      page,
      shape: "topic",
      relevanceMode: "v3",
      // Attribution boost spans the merged synonyms; the signals below graduate its
      // weight and are only read on the topic shape (absent ⇒ boost dropped).
      meshDescendantUis: descendantUis.length > 0 ? descendantUis : undefined,
      meshMatchTier: rep
        ? meshMatchTier(rep.confidence, rep.curatedTopicAnchors.length)
        : undefined,
      meshAmbiguous: rep?.ambiguous,
      meshMatchedFormLength: rep?.matchedForm.length,
      meshDescriptorName: rep?.name,
      // Topical fit only — no employment priors (§4; the `grantProminence` doc names
      // this exact caller as the intended `false`).
      facultyProminence: false,
      grantProminence: false,
      // Full active-scholar pool (directory baseline), fast headless shape (no
      // match-explain / representative-pub aggregations).
      filters: { includeIncomplete: undefined },
    });
    for (const h of result.hits) {
      ranked.push(h.cwid);
      hits.push(h);
    }
    if (
      ranked.length >= TERM_DEPTH ||
      result.hits.length < result.pageSize || // authoritative page size, short page = last
      ranked.length >= result.total
    ) {
      break;
    }
  }
  return { ranked: ranked.slice(0, TERM_DEPTH), hits };
}

/**
 * SPINE engine: rank researchers against a pasted sponsor description by
 * composing per-concept `searchPeople` rankings (see module doc). Short-circuits
 * to `[]` on an empty paste, no extracted terms, or all-empty retrieval — the
 * same posture as the bespoke engine. Any per-cluster `searchPeople` failure
 * throws out of here (the route's catch → 502); there are no silent partial results.
 */
export async function rankResearchersForDescriptionSpine(
  description: string,
  opts: { limit?: number } = {},
): Promise<SponsorRankedScholar[]> {
  const text = normalizeDescription(description);
  if (text.length === 0) return [];

  const vocab = await loadTaxonomyVocab();
  const terms = extractTerms(text, vocab).slice(0, MAX_TERMS);
  if (terms.length === 0) return [];

  // Resolve each extracted term to its MeSH descendant-UI set + representative
  // descriptor (one taxonomy round-trip per term; the list is short by construction).
  const resolved: ResolvedTerm[] = await Promise.all(
    terms.map(async (term) => ({
      term,
      resolution: (await matchQueryToTaxonomy(term)).meshResolution,
    })),
  );

  // Cluster redundant phrasing by MeSH-set equivalence (uniform centrality in v1).
  const clusterTerms: ClusterTerm[] = resolved.map((r) => ({
    term: r.term,
    descendantUis: r.resolution?.descendantUis ?? [],
    centrality: UNIFORM_CENTRALITY,
  }));
  const clusters = mergeTermClusters(clusterTerms, CLUSTER_TAU);
  if (clusters.length === 0) return [];

  // Coverage lookup: the fusion idf uses `mesh_descriptor.local_pub_coverage`
  // (a fraction, not a count). One bounded read over the resolved root descriptor UIs.
  const rootUiByTerm = new Map<string, string>();
  const repByTerm = new Map<string, MeshResolution>();
  for (const r of resolved) {
    if (r.resolution) {
      rootUiByTerm.set(r.term, r.resolution.descriptorUi);
      repByTerm.set(r.term, r.resolution);
    }
  }
  const rootUis = [...new Set([...rootUiByTerm.values()])];
  const coverageByUi = new Map<string, number>();
  if (rootUis.length > 0) {
    const rows = await db.read.meshDescriptor.findMany({
      where: { descriptorUi: { in: rootUis } },
      select: { descriptorUi: true, localPubCoverage: true },
    });
    for (const row of rows) {
      if (typeof row.localPubCoverage === "number")
        coverageByUi.set(row.descriptorUi, row.localPubCoverage);
    }
  }

  // Per cluster: retrieve people (topical-only) and compute the fusion weight.
  const rankings: TermRanking[] = [];
  const hitByCwid = new Map<string, PeopleHit>();
  for (const cluster of clusters) {
    // MAX member coverage ≈ the broadest merged synonym = a lower bound on the
    // cluster's true union corpus coverage (the exact union-coverage is an ETL
    // upgrade). No coverage row OR known-zero coverage ⇒ neutral idf (see
    // NEUTRAL_IDF — a non-positive number must not take dampedIdf's cap branch).
    const coverages = cluster.members
      .map((m) => rootUiByTerm.get(m))
      .filter((ui): ui is string => ui != null)
      .map((ui) => coverageByUi.get(ui))
      .filter((c): c is number => typeof c === "number");
    const maxCoverage = coverages.length > 0 ? Math.max(...coverages) : 0;
    const idf = maxCoverage > 0 ? dampedIdf(maxCoverage, IDF_CAP) : NEUTRAL_IDF;
    const weight = cluster.centrality * idf;

    // Representative resolution = the first member's (drives name/tier only).
    const rep = repByTerm.get(cluster.members[0]) ?? null;
    const { ranked, hits } = await retrieveCluster(
      cluster.members.join(" "),
      cluster.descendantUis,
      rep,
    );
    for (const h of hits) if (!hitByCwid.has(h.cwid)) hitByCwid.set(h.cwid, h);
    rankings.push({ weight, ranked });
  }

  const fused = rrfFuse(rankings).slice(0, opts.limit ?? SPINE_DEFAULT_LIMIT);
  if (fused.length === 0) return [];

  // technologyCount — CTL officers care whether the researcher already holds CTL IP.
  // Same inline groupBy the bespoke engine and `rankResearchersForOpportunity` use
  // (no shared helper on master — three intentional copies).
  const cwids = fused.map((f) => f.cwid);
  const grouped = await db.read.scholarTechnology.groupBy({
    by: ["cwid"],
    where: { cwid: { in: cwids } },
    _count: { _all: true },
  });
  const techByCwid = new Map(grouped.map((g) => [g.cwid, g._count._all]));

  // Map to SponsorRankedScholar. Display fields (name/slug/title/department) ride in
  // from the `searchPeople` hits — no extra profile read. The fused RRF score orders
  // the rows (defaultScore/topicFit; never rendered, ordering only).
  // ponytail: v1 leaves topPapers/matchedTopics EMPTY — the fast headless
  // `searchPeople` shape carries no per-topic pub count or evidence pubs without the
  // match-explain aggregation, and fabricating counts is forbidden. The bake-off
  // scores ORDER; the evidence upgrade lands with the LLM front-end.
  return fused.map((f) => {
    const hit = hitByCwid.get(f.cwid);
    return {
      cwid: f.cwid,
      slug: hit?.slug ?? f.cwid,
      preferredName: hit?.preferredName ?? undefined,
      careerStage: null,
      title: hit?.primaryTitle ?? null,
      department: hit?.primaryDepartment ?? null,
      axes: { topicFit: f.score, stageAppeal: 0 },
      topicContributions: [],
      defaultScore: f.score,
      technologyCount: techByCwid.get(f.cwid) ?? 0,
      topPapers: [],
      matchedTopics: [],
    };
  });
}
