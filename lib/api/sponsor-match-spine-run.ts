/**
 * Sponsor-match searchPeople SPINE — impure per-term composition
 * (pivot handoff `docs/2026-07-11-sponsor-match-searchpeople-pivot-handoff.md`
 * §4/§6). The pure helpers stay in `sponsor-match-spine.ts` (extraction, RRF)
 * and `sponsor-match-axes.ts` (dampedIdf, clustering); THIS module owns the
 * side-effecting glue the bake-off runs behind `SPONSOR_MATCH_SPINE`:
 *
 *   paste ─▶ extractSponsorConcepts (Bedrock LLM: concepts + centrality; dictionary
 *            `extractTerms` fallback on outage) ─▶ per-term matchQueryToTaxonomy (MeSH)
 *         ─▶ mergeTermClusters (dedup redundant phrasing)
 *         ─▶ per-cluster searchPeople (topical-only: faculty/grant prominence OFF)
 *         ─▶ weight = centrality^γ × kindPrior ─▶ rrfFuse(rank) ─▶ top-N
 *
 * Contrast with the bespoke `rankResearchersForDescription`: that path is ONE
 * BM25 round-trip over the whole paste × Variant-B; this path decomposes the
 * paste into concepts and fuses per-concept people rankings on RANK (the
 * `searchPeople` BM25 scores are query-scaled and NOT cross-comparable). The two
 * engines run side-by-side on the same deploy so the offline eval can score
 * ORDER; nothing here is wired live until the sub-flag flips.
 *
 * EXTRACTION: the Bedrock LLM front-end `extractSponsorConcepts` (§7-Q1) is the
 * primary term source — it reads the prose and names canonical research concepts
 * `matchQueryToTaxonomy` can resolve, each with a real per-term CENTRALITY. It
 * replaced the v1 dictionary `extractTerms` after a staging bake-off measured the
 * dictionary at ~0 recall on real pastes (it only literal-matches `Topic`/`Subtopic`
 * labels, so paraphrase / brand-name / un-catalogued prose is missed). The dictionary
 * is KEPT as a fallback: when the LLM returns [] (Bedrock outage/empty), the spine
 * extracts with `extractTerms` over the taxonomy-label vocab at UNIFORM_CENTRALITY —
 * degrading to v1 recall rather than to nothing. Both empty ⇒ [] (unchanged).
 *
 * CENTRALITY: real 0-1 values from the LLM (uniform 1.0 only on the dictionary
 * fallback). It is the LIVE left factor of the fusion weight (`centrality × idf`), so
 * differentiated centrality reorders results and gives the editable-centrality UI a
 * signal to edit.
 */
import { db } from "@/lib/db";
import { extractTerms, rrfFuse, type TermRanking } from "@/lib/api/sponsor-match-spine";
import {
  extractSponsorConcepts,
  type ExtractedConcept,
} from "@/lib/api/sponsor-match-extract";
import {
  mergeTermClusters,
  type ClusterTerm,
  type ConceptKind,
  type TermCluster,
} from "@/lib/api/sponsor-match-axes";
import {
  conceptWeight,
  type SponsorCandidate,
  type SponsorConcept,
} from "@/lib/api/sponsor-match-contract";
import { searchPeople, type PeopleHit } from "@/lib/api/search";
import { meshMatchTier } from "@/lib/search";
import { matchQueryToTaxonomy, type MeshResolution } from "@/lib/api/search-taxonomy";
import { normalizeDescription } from "@/lib/api/sponsor-match";

/**
 * NO DEFAULT TRUNCATION — the candidate universe shipped to the client is the FULL fused
 * pool, not a top-N of it. This is load-bearing for the re-rank contract, and it is subtle.
 *
 * The client re-ranks over exactly the candidates it was sent. If the server truncated to the
 * top-N *at default weights*, then sliding a concept UP could not surface that concept's own
 * best people — they were cut before the response was written. Concretely: a paste yields a
 * dominant concept A (weight 7.2) and a secondary concept B (weight 1.6). A's people fill the
 * entire default top-100 — A's rank-100 scores 7.2/(60+100) = .045, which still beats B's
 * rank-1 at 1.6/(60+1) = .026 — so B's single best researcher is not in the payload at all.
 * The officer then drags A to zero precisely to isolate B, and the rail shows leftover
 * A-people who happen to rank weakly under B, with B's actual expert missing. The one
 * interaction the sliders exist for would be the one that silently breaks.
 *
 * (#1673 did not have this bug — it re-queried the server on every drag, which is the very
 * thing the contract forbids. Dropping the re-query means the PAYLOAD must carry the pool
 * that the re-query would have re-fused.)
 *
 * Shipping the whole pool makes the client re-rank EQUIVALENT to a server re-fusion at the
 * edited weights, for ANY weights — the property the contract actually promises.
 *
 * The pool is bounded by construction: MAX_TERMS (8) × TERM_DEPTH (100) = 800 candidates
 * worst-case, and far fewer in practice once clusters merge and their people overlap. The
 * panel renders only the top slice of the current ranking, so the DOM does not grow with it.
 * `opts.limit` still truncates for callers that genuinely want a top-N — but the route does
 * NOT pass it, because a truncated pool is a broken rail.
 */

/** Per-term centrality for the DICTIONARY FALLBACK only — the LLM extractor supplies
 *  real 0-1 values on the primary path (§7-Q1). Uniform 1 makes the fallback weight
 *  idf-only, matching v1 behaviour. */
const UNIFORM_CENTRALITY = 1;

/**
 * Paste-relative kind prior — the ENTIRETY of `weightFactor`.
 *
 * The extractor knows which kind the funder is buying: the kind carrying the paste's top
 * centrality. That kind is boosted and the other damped, so a disease paste promotes its
 * diseases and a methods paste promotes its methods, from one rule with no special-casing.
 * (A BLANKET "disease outranks method" rule would break every paste where the method IS the
 * target — FINDING §9's objection, which paste-relativity answers.)
 *
 * WHAT IT ACTUALLY DOES, measured — and it is not what #1676 claimed. That comment justified
 * the prior as protecting the method-target pastes ("ml-in-medicine, single-cell-genomics —
 * measured, not hypothetical"). Re-fusing every fixture from a FIXED extraction, with only
 * the prior varying, says otherwise: on ml-in-medicine it changes nDCG by exactly 0.000, and
 * on single-cell-genomics it is mildly HARMFUL (+0.010 when removed). Its whole positive value
 * comes from DISEASE pastes carrying one stray `method` concept — immuno-onc (-0.093 without
 * it) and heme-malignancy (-0.066) — where damping that stray is what helps.
 *
 * So it earns its keep (removing it costs -0.007 mean over 15 fixtures) by suppressing the
 * off-target concept in a single-target paste, NOT by defending method pastes. It also cannot
 * do anything at all on the 7 of 15 fixtures whose concepts are all one kind: there it is a
 * uniform scalar, and a uniform scalar cannot reorder a rank fusion.
 */
const KIND_ALIGNED = 1.25;
const KIND_OFF_TARGET = 0.8;

/**
 * The kind THIS paste is targeting: the kind of the highest-centrality cluster, ties broken
 * by total centrality mass, and finally by "concept" (the extractor's own default, and the
 * safe read of an all-methods-tied paste).
 *
 * This is the paste-awareness §9 requires, and it costs nothing to obtain — the extractor
 * already scores a methods paste with its methods on top (`machine learning` 1.0) and a
 * disease paste with its disease on top (`systemic sclerosis` 1.0). We only have to read it.
 */
function targetKindOf(clusters: readonly TermCluster[]): ConceptKind {
  const stat = (k: ConceptKind) => {
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

/** Jaccard merge threshold for `mergeTermClusters`. Subsumption always merges; this
 *  gates partial overlap (same concept phrased differently). Moderate so near-identical
 *  descendant sets collapse but distinct concepts stay separate. */
const CLUSTER_TAU = 0.5;

/** Hard cap on extracted terms — also the fan-out breaker's concept multiplicand.
 *  Worst-case sequential `searchPeople` round-trips = MAX_TERMS × pages-per-cluster,
 *  and the broadest multi-concept pastes (max concepts × max pages) are exactly the
 *  ones that tripped the OpenSearch parent circuit breaker; `mergeTermClusters` already
 *  documents a small-list (≤ ~12) assumption. Lowered 12→8 to trim that worst-case
 *  burst ~33% (paired with `skipFacetAggs`, which removes the per-request agg heap that
 *  was the actual breaker driver). Every term still costs one taxonomy resolution +
 *  (per cluster) up to MAX_PAGES round-trips, so a taxonomy-dense 3,000-char paste can't
 *  stall the worker.
 *  ponytail: the cut is recall-cheap here BY DESIGN — truncation keeps the FIRST
 *  concepts (LLM: most-central-first per the extraction prompt; dictionary fallback: vocab order,
 *  deterministic — see `loadTaxonomyVocab`), so only the least-central 9th-12th concepts
 *  of a >8-concept paste are dropped. Single/few-concept pastes (e.g. the scleroderma
 *  0→100 win) carry < 8 concepts and are UNTOUCHED — this only trims the broad pastes
 *  that fail. TERM_DEPTH is deliberately left at 100 so per-concept pool depth (and that
 *  0→100 recall) is preserved. Acceptable for the dark bake-off tool. */
const MAX_TERMS = 8;

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

/** One extracted concept resolved to MeSH: the term, its centrality (carried through
 *  to the ClusterTerm as the fusion multiplicand), its kind, and the resolution
 *  (representative descriptor identity + coverage lookup key). */
type ResolvedTerm = {
  term: string;
  centrality: number;
  kind: "concept" | "method";
  resolution: MeshResolution | null;
};

/**
 * The spine's result — the UI ⇄ ranker contract's payload (`sponsor-match-contract.ts`).
 *
 * `concepts` are the MERGED CLUSTERS actually fused (not the raw extracted terms), each
 * carrying BOTH halves of its fusion weight: the editable `centrality` and the fixed
 * `weightFactor` (today: dampedIdf). `candidates` carry `contributions[]` — every (concept, rank) pair
 * the fusion summed over. Together those are the complete, decomposed score inputs, which
 * is what lets the console re-rank live in the browser as sliders move instead of
 * re-querying the server on every drag. `concepts` is [] only when nothing was extracted.
 */
export type SpineRankResult = {
  concepts: SponsorConcept[];
  candidates: SponsorCandidate[];
};

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
      // Fan-out breaker: this loop reads only hits/total/pageSize (facets are
      // discarded), so skip the nine People-index facet aggregations. Sending them on
      // every one of the per-concept × per-page sequential calls piled up the
      // per-request heap (incl. a size-200 `deptDivKey` terms agg) that tripped the
      // OpenSearch parent circuit breaker on the broadest sponsor pastes. Recall-neutral
      // — aggs never touch hits, scoring, or ordering.
      skipFacetAggs: true,
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
 * composing per-concept `searchPeople` rankings (see module doc). Returns the UI
 * contract's `{ concepts, candidates }` — the DECOMPOSED score inputs, not just a
 * ranked list: every concept's `centrality` × `weightFactor`, and every candidate's per-
 * concept `rank`. That is what the console re-ranks over in the browser.
 *
 * Short-circuits to empty candidates on an empty paste, no extracted terms, or
 * all-empty retrieval — the same posture as the bespoke engine. Any per-cluster
 * `searchPeople` failure throws out of here (the route's catch → 502); there are no
 * silent partial results.
 *
 * There is deliberately NO concept-override parameter. The console re-ranks CLIENT-side
 * (`rerankCandidates`), so a slider edit costs zero round-trips; #1673's server-side
 * override — which re-retrieved and re-fused on every drag — was the contract violation
 * this rework removes, and with it a client-controlled trust boundary.
 */
export async function rankResearchersForDescriptionSpine(
  description: string,
  opts: { limit?: number } = {},
): Promise<SpineRankResult> {
  const empty: SpineRankResult = { concepts: [], candidates: [] };
  const text = normalizeDescription(description);
  if (text.length === 0) return empty;

  // Extraction seam (§7-Q1): the Bedrock LLM names the funder's concepts + real
  // per-term centrality + kind. On [] (Bedrock outage/empty) fall back to the v1
  // dictionary extractor at uniform centrality — degrade to v1 recall, not to nothing.
  // The dictionary cannot tell a method from a disease, so it tags everything
  // "concept" (the rail then shows one panel). Both empty ⇒ the same [] short-circuit
  // as before. MAX_TERMS caps either source.
  let extracted: ExtractedConcept[] = (await extractSponsorConcepts(text)).slice(0, MAX_TERMS);
  if (extracted.length === 0) {
    const vocab = await loadTaxonomyVocab();
    extracted = extractTerms(text, vocab)
      .slice(0, MAX_TERMS)
      .map((term) => ({ term, kind: "concept" as const, centrality: UNIFORM_CENTRALITY }));
  }
  if (extracted.length === 0) return empty;

  // Resolve each concept to its MeSH descendant-UI set + representative descriptor
  // (one taxonomy round-trip per concept; the list is short by construction). The
  // centrality rides through so the ClusterTerm carries a real fusion multiplicand.
  const resolved: ResolvedTerm[] = await Promise.all(
    extracted.map(async (c) => ({
      term: c.term,
      centrality: c.centrality,
      kind: c.kind,
      resolution: (await matchQueryToTaxonomy(c.term)).meshResolution,
    })),
  );

  // Cluster redundant phrasing by MeSH-set equivalence; each ClusterTerm carries its
  // concept's centrality (mergeTermClusters takes the MAX across merged members) and
  // its kind (the cluster takes its FIRST member's — the representative).
  const clusterTerms: ClusterTerm[] = resolved.map((r) => ({
    term: r.term,
    descendantUis: r.resolution?.descendantUis ?? [],
    centrality: r.centrality,
    kind: r.kind,
  }));
  const clusters = mergeTermClusters(clusterTerms, CLUSTER_TAU);
  if (clusters.length === 0) return empty;

  // Coverage lookup: `mesh_descriptor.local_pub_coverage` (a fraction, not a count). One
  // bounded read over the resolved root descriptor UIs. DISPLAY-ONLY now — it feeds the rail's
  // rarity badge via `corpusCoverage` and no longer touches the fusion weight at all.
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

  // Per cluster: retrieve people (topical-only), compute the fusion weight, and record
  // the cluster AS THE WIRE CONCEPT. The two factors of the weight are surfaced
  // separately — `centrality` (what a slider moves) and `weightFactor` (fixed) — because
  // the client must be able to recompute `weight = centrality × weightFactor` itself.
  // Shipping only their product would make the sliders unusable.
  const rankings: TermRanking[] = [];
  const concepts: SponsorConcept[] = [];
  const hitByCwid = new Map<string, PeopleHit>();
  // Which kind this paste is buying — read once, applied per cluster below.
  const targetKind = targetKindOf(clusters);
  for (const cluster of clusters) {
    // MAX member coverage ≈ the broadest merged synonym = a lower bound on the cluster's true
    // union corpus coverage (the exact union-coverage is an ETL upgrade). Display-only: 0 here
    // means "no coverage row OR known-zero", and the badge is omitted rather than claiming
    // rarity — absent is not zero (it is 40% of descriptors).
    const coverages = cluster.members
      .map((m) => rootUiByTerm.get(m))
      .filter((ui): ui is string => ui != null)
      .map((ui) => coverageByUi.get(ui))
      .filter((c): c is number => typeof c === "number");
    const maxCoverage = coverages.length > 0 ? Math.max(...coverages) : 0;

    // The FIXED half of the fusion weight (the slider owns the other half). This is the line
    // the FINDING is about. It carried the raw corpus IDF; #1676 demoted that to a bounded
    // rarity band; the sweep then found the band was earning nothing (0.6612 without it vs
    // 0.6610 with it), so corpus rarity is now OUT of the weight entirely. Topicality is
    // carried by centrality^γ via the contract's shared `conceptWeight`, and rarity survives
    // only as the display-only `corpusCoverage` below — a claim about the literature, which is
    // all it was ever entitled to be.
    //
    // Note what is deliberately NOT in here: centrality. `weightFactor` must stay independent
    // of it, because the client re-derives the weight on every slider drag; folding centrality
    // in would bake the ORIGINAL value into the "fixed" half and make a dragged slider disagree
    // with the server.
    const weightFactor = cluster.kind === targetKind ? KIND_ALIGNED : KIND_OFF_TARGET;

    // The cluster's representative term: its first member. It is the concept's identity
    // on the wire and the join key `contributions[].term` points back to — so the SAME
    // string must key the ranking, the concept, and every contribution.
    const term = cluster.members[0];
    const concept: SponsorConcept = {
      term,
      kind: cluster.kind,
      members: cluster.members,
      centrality: cluster.centrality,
      weightFactor,
      // Display-only, and OMITTED when we do not know it. A zero coverage means "no
      // locally-tagged pubs for this descriptor" — which is 40% of descriptors and is not
      // evidence of rarity — so it must not reach the UI as a rarity claim. Absent ≠ zero.
      ...(maxCoverage > 0 ? { corpusCoverage: maxCoverage } : {}),
    };
    concepts.push(concept);

    // Representative resolution = the first member's (drives name/tier only).
    const rep = repByTerm.get(term) ?? null;
    const { ranked, hits } = await retrieveCluster(
      cluster.members.join(" "),
      cluster.descendantUis,
      rep,
    );
    for (const h of hits) if (!hitByCwid.has(h.cwid)) hitByCwid.set(h.cwid, h);
    // `conceptWeight`, not an inline `centrality * weightFactor` — the contract owns the ONE
    // definition of the fusion weight and the client's slider re-rank calls the same function.
    // Re-stating the formula here is exactly the drift #1674 removed; a γ added in one place
    // and missed in the other would silently desync the sliders from the server's order.
    rankings.push({ term, weight: conceptWeight(concept), ranked });
  }

  const allFused = rrfFuse(rankings);
  const fused = opts.limit != null ? allFused.slice(0, opts.limit) : allFused;
  if (fused.length === 0) return { concepts, candidates: [] };

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

  // Map to the wire `SponsorCandidate`. Display fields (name/slug/title/department) ride
  // in from the `searchPeople` hits — no extra profile read. `fusedScore` is the RRF sum
  // at DEFAULT weights; the UI buckets it into a tier relative to the top hit and never
  // renders the raw number. `contributions` is the hinge — it comes straight out of
  // `rrfFuse`, which already had every (concept, rank) pair and used to discard them.
  // ponytail: `measures` and `evidence` are OMITTED, not zeroed. The fast headless
  // `searchPeople` shape carries no career stage, no per-topic pub count and no evidence
  // pubs (it runs `skipFacetAggs`), and fabricating counts is forbidden — so the contract
  // makes both optional and absent means "not computed", never "none". The evidence
  // upgrade needs the match-explain aggregation, which is a separate change.
  const candidates: SponsorCandidate[] = fused.map((f) => {
    const hit = hitByCwid.get(f.cwid);
    return {
      cwid: f.cwid,
      name: hit?.preferredName ?? f.cwid,
      profileSlug: hit?.slug ?? f.cwid,
      title: hit?.primaryTitle ?? null,
      department: hit?.primaryDepartment ?? null,
      fusedScore: f.score,
      contributions: f.contributions,
      technologyCount: techByCwid.get(f.cwid) ?? 0,
    };
  });
  return { concepts, candidates };
}
