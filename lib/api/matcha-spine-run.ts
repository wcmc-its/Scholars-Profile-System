/**
 * Matcha searchPeople SPINE — impure per-term composition
 * (pivot handoff `docs/2026-07-11-sponsor-match-searchpeople-pivot-handoff.md`
 * §4/§6). The pure helpers stay in `sponsor-match-spine.ts` (extraction, RRF)
 * and `sponsor-match-axes.ts` (clustering); THIS module owns the
 * side-effecting glue the bake-off runs behind `MATCHA_SPINE`:
 *
 *   paste ─▶ extractMatchaConcepts (Bedrock LLM: concepts + centrality; dictionary
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
 * EXTRACTION: the Bedrock LLM front-end `extractMatchaConcepts` (§7-Q1) is the
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
import { identityImageEndpoint } from "@/lib/headshot";
import { extractTerms, rrfFuse, type TermRanking } from "@/lib/api/matcha-spine";
import {
  extractMatchaConcepts,
  type ExtractedConcept,
} from "@/lib/api/matcha-extract";
import {
  applyIncludes,
  culledTerms,
  mergeTermClusters,
  selectWithMethodFloor,
  type ClusterTerm,
  type ConceptKind,
  type TermCluster,
} from "@/lib/api/matcha-axes";
import {
  conceptWeight,
  recencyWeight,
  matchaMeasuresFrom,
  DEFAULT_K,
  MAX_EVIDENCE_CONCEPTS,
  type CulledConcept,
  type MatchaCandidate,
  type MatchaConcept,
  type MatchaSearchEvidence,
} from "@/lib/api/matcha-contract";
import { isResearchMatchEvidence } from "@/lib/api/result-evidence";
import { searchPeople, type PeopleHit } from "@/lib/api/search";
import { meshMatchTier } from "@/lib/search";
import { matchQueryToTaxonomy, type MeshResolution } from "@/lib/api/search-taxonomy";
import { normalizeDescription } from "@/lib/api/matcha";

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

/** #1780 — reserve up to this many of the `MAX_TERMS` slots for METHOD-kind concepts scoring
 *  `>= METHOD_THRESHOLD`, displacing only the lowest-centrality concepts (see
 *  `selectWithMethodFloor`). A FLOOR inside the existing cap, so the fan-out — and server load —
 *  is unchanged. The extractor demotes methods to 0.3–0.5, so a plain top-8 cut dropped 50% of
 *  them; this guarantees the method-starved disease-primary asks still carry their top methods. */
const METHOD_FLOOR = 3;

/** Centrality a method must clear to earn a reserved slot. Above the 0.3 incidental floor
 *  `sanitizeConcepts` assigns to unusable scores (so a floored junk method never qualifies),
 *  and low enough to admit the terms the eval flagged (iPSC / organoids at 0.35). The one
 *  tunable constant here; validate against a fan-out A/B before moving it. */
const METHOD_THRESHOLD = 0.35;

/** #1780 Phase 2 — the total-term ceiling once an officer manually adds culled terms. The automatic
 *  cut still stops at `MAX_TERMS`; click-to-include adds are ADDITIVE on top, up to this hard cap,
 *  bounding worst-case fan-out even if every chip is clicked. Each add is one user action = one
 *  re-run, so this is not an automatic load increase — the "don't raise the cap" rule (which is
 *  about the automatic cut) is intact. */
const MAX_TERMS_WITH_INCLUDES = 12;

/** Centrality assigned to an included term that did NOT re-appear in the fresh extraction (rare —
 *  extraction is temp-0). A middling default: the officer asked for it, so it should rank, but it
 *  must not dominate. The normal path reuses the extraction's real per-term centrality. */
const INCLUDE_SYNTH_CENTRALITY = 0.5;

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
 * `weightFactor` (today: `kindPrior` alone). `candidates` carry `contributions[]` — every
 * (concept, rank) pair the fusion summed over. Together those are the complete, decomposed score inputs, which
 * is what lets the console re-rank live in the browser as sliders move instead of
 * re-querying the server on every drag. `concepts` is [] only when nothing was extracted.
 */
export type SpineRankResult = {
  concepts: MatchaConcept[];
  candidates: MatchaCandidate[];
  /** The extractor's short search title (essence + org, written in the SAME extraction call).
   *  Rides through to the route, which prefers it over the derived concept-list title. Absent
   *  on the dictionary-fallback path (no LLM ⇒ no title) and on the empty short-circuits. */
  titleSummary?: string;
  /** #1780 Phase 2 — the extractor's concepts the cut did NOT search, for the click-to-include
   *  chips. [] on the dictionary-fallback path (no LLM tail) and the empty short-circuits. */
  culled?: CulledConcept[];
};

/**
 * Key for the per-(concept, cwid) evidence map (#1689).
 *
 * ONE definition, called by both the writer and the reader. A concept term is free text from an
 * LLM and can contain anything at all, so the key is a JSON tuple rather than a
 * delimiter-joined string — the same idiom `reasonAggKey` uses, and for the same reason: no
 * separator can collide with the content. Building the key inline at two sites is how the
 * halves drift apart and every lookup silently misses — which presents not as a bug but as
 * "the engine produced no evidence", i.e. as the very symptom this change exists to fix.
 */
function evidenceKey(term: string, cwid: string): string {
  return JSON.stringify([term, cwid]);
}

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
  // D1 — when true, ask searchPeople to project each hit's `mostRecentYear` (from the precomputed
  // `mostRecentPubDate`). Off ⇒ the field is not requested, so the hit shape is byte-identical.
  includeRecency: boolean,
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
      // The third prior, and the one the two above made WORSE by omission. The outer
      // prominence function_score sums its terms before multiplying, so dropping the flat
      // faculty and grant terms shrinks the denominator and RAISES the pubcount term's
      // share of the multiplier. This caller declared topical fit only and was, until now,
      // amplifying a productivity prior it had no lever for. Gates the inner ×1.2/×1.1
      // step functions too — corpus size is priced twice and half a lever measures nothing.
      pubcountProminence: false,
      // #1689 — ASK FOR THE EVIDENCE. This is the whole fix, and it is three options on a
      // call this loop already makes.
      //
      // The console's "why this match" block was empty in prod because the SPINE never
      // produced `evidence`, and two comments in this repo (this file's, and the contract's)
      // blamed `skipFacetAggs`. THAT WAS WRONG, and it is worth being explicit about, because
      // acting on it would have made things worse: `skipFacetAggs` is read at exactly one
      // place (`...(opts.skipFacetAggs ? {} : { aggs })`) and gates only the nine People-index
      // FACET aggs. It appears nowhere in `reasonAggEligible`. The real gate is `matchExplain`,
      // which defaults to FALSE — the spine simply never asked. "Fixing" the stated cause by
      // dropping `skipFacetAggs` would have re-added the size-200 `deptDivKey` agg to every
      // fan-out call, re-tripped the breaker, and STILL produced no evidence.
      //
      // `reasonFromDoc` + `meshDescriptorUi` together select the CHEAP path: the tagged count
      // is an O(1) read of the people-doc's own `meshSubtreeCounts[ui]`, so a resolved concept
      // issues NO publications-index query at all. `rep` was already in hand for the
      // attribution boost — the descriptor UI was sitting right there, unread.
      matchExplain: true,
      reasonFromDoc: true,
      meshDescriptorUi: rep?.descriptorUi,
      // Full active-scholar pool (directory baseline).
      filters: { includeIncomplete: undefined },
      // Fan-out breaker: this loop reads only hits/total/pageSize (facets are
      // discarded), so skip the nine People-index facet aggregations. Sending them on
      // every one of the per-concept × per-page sequential calls piled up the
      // per-request heap (incl. a size-200 `deptDivKey` terms agg) that tripped the
      // OpenSearch parent circuit breaker on the broadest sponsor pastes. Recall-neutral
      // — aggs never touch hits, scoring, or ordering.
      skipFacetAggs: true,
      // D1 — project the precomputed most-recent-pub year for the recency weight. Gated so the
      // off path keeps today's `_source` shape and hit payload.
      includeMostRecentPub: includeRecency,
      // Matcha's A–Z sort key. UNCONDITIONAL, unlike the year above: sorting by last name is a
      // presentation affordance that must not inherit the recency flag's fate. Free — the field is
      // already stored for the directory's own A–Z sort, this only projects it.
      includeLastName: true,
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
  opts: { limit?: number; include?: readonly string[] } = {},
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
  const extraction = await extractMatchaConcepts(text);
  const titleSummary = extraction.titleSummary; // survives the dictionary fallback below (undefined there)
  // #1780 — cap to MAX_TERMS, but reserve slots for qualifying methods the plain centrality cut
  // would drop (they score 0.3–0.5 by the rubric). A floor inside the cap ⇒ fan-out unchanged.
  let extracted: ExtractedConcept[] = selectWithMethodFloor(extraction.concepts, {
    max: MAX_TERMS,
    methodFloor: METHOD_FLOOR,
    methodThreshold: METHOD_THRESHOLD,
  });
  // #1780 Phase 2 — force officer-picked culled terms back in, additively, capped at
  // MAX_TERMS_WITH_INCLUDES. LLM path only: the dictionary fallback below has no culled tail, so
  // there is nothing for an officer to have added. Sanitized upstream at the route trust boundary.
  const include = opts.include ?? [];
  if (extracted.length > 0 && include.length > 0) {
    extracted = applyIncludes(extracted, extraction.concepts, include, {
      hardMax: MAX_TERMS_WITH_INCLUDES,
      synth: (term) => ({ term, kind: "concept" as const, centrality: INCLUDE_SYNTH_CENTRALITY }),
    });
  }
  if (extracted.length === 0) {
    const vocab = await loadTaxonomyVocab();
    extracted = extractTerms(text, vocab)
      .slice(0, MAX_TERMS)
      .map((term) => ({ term, kind: "concept" as const, centrality: UNIFORM_CENTRALITY }));
  }
  if (extracted.length === 0) return empty;

  // #1780 Phase 2 — the culled tail for the client's include chips: the full extraction minus the
  // FINAL selection, so a just-added term drops off the chips. [] on the dictionary fallback
  // (`extraction.concepts` is [] there ⇒ nothing to offer).
  const culled: CulledConcept[] = culledTerms(extraction.concepts, extracted).map((c) => ({
    term: c.term,
    kind: c.kind,
    centrality: c.centrality,
  }));

  // The funder's qualifying context per term (the LLM extractor's `gloss`; empty on the dictionary
  // fallback). DISPLAY ONLY — it rides the wire for the rail's provenance line and reaches no query.
  // It USED TO be searched as the free-text query instead of the bare canonical token, on the premise
  // that it ranks the sponsor's sense rather than everything the token can literally hit. #1814 A/B'd
  // that and it lost on every metric: a long prose gloss NARROWS a BM25 query rather than broadening
  // it. See the measurement at the `clusterQuery` assignment below.
  const glossByTerm = new Map(
    extracted.flatMap((c) => (c.gloss ? [[c.term, c.gloss] as const] : [])),
  );

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
  const concepts: MatchaConcept[] = [];
  const hitByCwid = new Map<string, PeopleHit>();
  // #1689 — per (concept, cwid). See `evidenceKey`.
  const evidenceByTermCwid = new Map<string, MatchaSearchEvidence>();
  // Which kind this paste is buying — read once, applied per cluster below.
  const targetKind = targetKindOf(clusters);
  // MATCHA_RECENCY — D1. Surface each scholar's most-recent publication year and fold it
  // into the fused score (recency as a scored dimension), which re-tiers via the share-to-top (D2).
  // A ranking change ⇒ eval-gated. STATIC literal for flag-parity.
  //
  // THE GATE IS NON-INFERIORITY, NOT SUPERIORITY, and that is not a lowered bar — it is the only
  // question the instrument can answer. `sponsor-fixtures.json` grades TOPICAL fit and citation
  // impact (`_grades`: "work centers on the topic"; `_method`: "+ citation impact") and has no
  // opinion about recency. Citation impact accumulates with age, so the gold is mildly
  // recency-ANTAGONISTIC: a highly-cited expert who last published years ago is a grade 3, D1
  // demotes them, and the eval scores that as a loss. Expected sign of Δ ≤ 0 BY CONSTRUCTION.
  // An earlier version of this comment demanded the A/B "clear the ~0.0074 nDCG noise floor" —
  // i.e. asked the gold to show recency winning, which it can never do, paired or deployed.
  // Run: scripts/search-eval/sponsor-capture.sh → sponsor-rerank-ab.ts → sponsor-ni-test.ts
  // (one capture, re-ranked twice offline; no deploy, no flag flip — and a flag flip would be
  // unsound anyway, since the flag is not in the route's cache key).
  //
  // ⚠ THE REAL RISK IS NOT nDCG. `mostRecentPubDate` counts CONFIRMED authorships only
  // (search-index-docs.ts ~992), so a scholar with an uncurated backlog reads as stale and gets
  // demoted for a CURATION gap rather than for dormancy — and curation is thinnest for
  // affiliated faculty, making the bias systematic rather than random. This is not hypothetical:
  // the 2026-07-16 A/B's single largest loss (als, −0.177 nDCG, which alone decided the gate)
  // was one grade-3 scholar sitting on 59 unaccepted publications. Before flipping prod,
  // quantify that exposure by role_category — the eval cannot see it.
  const recencyOn = process.env.MATCHA_RECENCY === "on";
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
    // The representative member's gloss — the sponsor's words for this concept, shown on the rail.
    const clusterGloss = glossByTerm.get(term);
    const concept: MatchaConcept = {
      term,
      kind: cluster.kind,
      members: cluster.members,
      centrality: cluster.centrality,
      weightFactor,
      // Display-only, and OMITTED when we do not know it. A zero coverage means "no
      // locally-tagged pubs for this descriptor" — which is 40% of descriptors and is not
      // evidence of rarity — so it must not reach the UI as a rarity claim. Absent ≠ zero.
      ...(maxCoverage > 0 ? { corpusCoverage: maxCoverage } : {}),
      // The funder's qualifying context, when the extractor gave one. Absent otherwise (never "").
      ...(clusterGloss ? { gloss: clusterGloss } : {}),
    };
    concepts.push(concept);

    // The free-text query: the cluster's bare member tokens. The sponsor's GLOSS is deliberately
    // NOT in here — it is display-only (see `clusterGloss` above, which still rides the wire for
    // the rail's "sponsor's words" line).
    //
    // MEASURED AND REJECTED (2026-07-19, `docs/2026-07-19-matcha-gloss-query-concept-vs-keyword-handoff.md`).
    // Searching the gloss was tried behind `MATCHA_GLOSS_QUERY` on the premise that it ADDS recall
    // for the sponsor's sense. A three-arm in-VPC A/B over the 15 sponsor fixtures says the premise
    // was backwards — a long prose gloss NARROWS the BM25 query:
    //
    //   bare tokens (this)   nDCG@20 0.613   coverage 260/270   5,834 candidates
    //   token + gloss        nDCG@20 0.535   coverage 242/270   4,770 candidates
    //   gloss alone          nDCG@20 0.434   coverage 237/270   5,019 candidates
    //
    // Of 238 judged-relevant scholars the best gloss variant LOST 15 that this bare-token query
    // retrieves and gained 1 — a real recall regression, not an artifact of the gold. So the flag,
    // both gloss compositions, and the eval-gate are gone; retrieval keeps the measured winner.
    const clusterQuery = cluster.members.join(" ");

    // Representative resolution = the first member's (drives name/tier only).
    const rep = repByTerm.get(term) ?? null;
    const { ranked, hits } = await retrieveCluster(
      clusterQuery,
      cluster.descendantUis,
      rep,
      recencyOn,
    );
    for (const h of hits) if (!hitByCwid.has(h.cwid)) hitByCwid.set(h.cwid, h);
    // #1689 — evidence is CONCEPT-SCOPED, so it is stored per (concept, cwid) and read back
    // below, once the fusion knows every concept the candidate actually ranked under.
    // `hitByCwid` above is first-wins, which is fine for display fields (a name is a name in
    // any cluster) but WRONG for evidence: it would tell an officer that a candidate matched
    // on whichever concept happened to be retrieved first, and say nothing about the others.
    for (const h of hits) {
      // #1689 follow-up — READ BOTH SHAPES, and prefer `evidenceLines`.
      //
      // `searchPeople` emits ONE of two fields, and which one is a FLAG DECISION, not a
      // property of the data: with `SEARCH_EVIDENCE_REASON_COUNTS` on it emits the tiered
      // `evidenceLines[]` (primary lead first, then "Also matched" rows) and NEVER `evidence`;
      // with it off it emits the single `evidence`. Both flags are ON in staging and prod, so
      // reading only `evidence` — which is what the first cut of this did — found nothing in
      // every deployed environment while passing every test, because the tests mock
      // `searchPeople` and hand it whichever shape the test author had in mind. A green suite
      // said yes; an in-VPC probe against real staging OpenSearch said 0 of 160 hits.
      //
      // `evidenceLines[0]` is the PRIMARY lead — the strongest reason, by the search's own
      // precedence ladder. That is the one the People card renders large, and the one the
      // officer should see here.
      //
      // STILL only [0], deliberately, now that #1696 keeps every CONCEPT rather than only the
      // best one. The card gains breadth ACROSS concepts; widening depth WITHIN one at the same
      // time would multiply the two (up to MAX_EVIDENCE_CONCEPTS × every tiered line) and bury
      // the thing this change exists to surface. `evidenceLines[1..]` are the search's "Also
      // matched" rows for the SAME concept query — a weaker restatement of a reason the officer
      // already has. A second concept's primary lead is a genuinely new reason; that is the axis
      // worth spending the card's vertical space on.
      const hitEvidence = h.evidenceLines?.[0] ?? h.evidence;
      // TWO guards, and the first one alone is a LIE IN BOTH DEPLOYED ENVIRONMENTS.
      //
      // `!hitEvidence` only fires with SEARCH_RESULT_EVIDENCE off, when `searchPeople` emits
      // NEITHER field. That flag is ON in staging and prod, and with it on the emitter cannot
      // produce an evidence-less hit: `selectEvidenceLines` ends with
      // `if (lines.length === 0) lines.push(selectEvidence(input))`, and `selectEvidence`
      // terminates in `return { kind: "none" }`. So every (concept, cwid) pair in the fan-out
      // comes back carrying SOMETHING — including the pairs that matched on nothing.
      //
      // `isResearchMatchEvidence` is the guard that actually fires. An UNRESOLVED cluster (no MeSH
      // descriptor ⇒ no tagged count ⇒ no first-class reason) falls down the ladder to the
      // identity tail — `areas` / `concepts` / `none` — which answers "who is this person",
      // not "why did they match this concept". Shipping that as a block captioned with the
      // sponsor's concept renders the scholar's SELF-REPORTED research areas as evidence FOR a
      // concept nothing connected them to. Most scholars have `areasOfInterest`, so that was
      // the COMMON case, not the corner one: a fabricated relevance claim, up to
      // MAX_EVIDENCE_CONCEPTS times per card, on the surface an officer picks names off.
      //
      // Absent ≠ none: a concept with no MATCH evidence contributes no entry at all, and the
      // candidate's `searchEvidence` stays absent if none of them did. We render nothing rather
      // than guess.
      if (!hitEvidence || !isResearchMatchEvidence(hitEvidence)) continue;
      evidenceByTermCwid.set(evidenceKey(term, h.cwid), {
        // The join key back to `contributions[].term` / `concepts[].term` — the cluster's
        // representative, the same string that keys the ranking and the wire concept.
        term,
        evidence: hitEvidence,
        pubCount: h.pubCount,
        // What the lazy key-paper fetch needs to find this candidate's papers FOR THIS
        // CONCEPT — the same three inputs the public People card passes. Per-concept, which is
        // what lets each of a card's blocks reveal papers about ITS OWN concept.
        keyPaper: {
          // The same free-text query the retrieval used — `clusterQuery`, i.e. the cluster's bare
          // member tokens — so the paper a disclosure reveals is chosen on what actually ranked it.
          // (Not gloss-biased: the gloss stopped reaching any query in #1814.)
          descriptorUis: cluster.descendantUis,
          contentQuery: clusterQuery,
          conceptLabel: rep?.name,
        },
      });
    }
    // `conceptWeight`, not an inline `centrality * weightFactor` — the contract owns the ONE
    // definition of the fusion weight and the client's slider re-rank calls the same function.
    // Re-stating the formula here is exactly the drift #1674 removed; a γ added in one place
    // and missed in the other would silently desync the sliders from the server's order.
    rankings.push({ term, weight: conceptWeight(concept), ranked });
  }

  // D1 — per-scholar recency multiplier for the fusion. Built from the hits already in hand (each
  // carries `mostRecentYear` under the flag), so it costs no extra I/O. Applied INSIDE rrfFuse so
  // the server's order AND its top-N cut (the slice below) are recency-aware, and so the client's
  // `fusedScore()` — which applies the identical factor — reproduces this order at default weights.
  // `undefined` when the flag is off ⇒ rrfFuse multiplies every scholar by 1 (unchanged fusion).
  const currentYear = new Date().getUTCFullYear();
  const recencyWeightByCwid = recencyOn
    ? new Map<string, number>(
        [...hitByCwid]
          .filter(([, h]) => h.mostRecentYear != null)
          .map(([cwid, h]): [string, number] => [
            cwid,
            recencyWeight(h.mostRecentYear, currentYear),
          ]),
      )
    : undefined;
  const allFused = rrfFuse(rankings, DEFAULT_K, recencyWeightByCwid);
  const fused = opts.limit != null ? allFused.slice(0, opts.limit) : allFused;
  if (fused.length === 0) return { concepts, candidates: [], titleSummary, culled };

  // technologyCount — CTL officers care whether the researcher already holds CTL IP.
  // Same inline groupBy the bespoke engine and `rankResearchersForOpportunity` use
  // (no shared helper on master — three intentional copies).
  const cwids = fused.map((f) => f.cwid);
  // #1654 — the measures read. `searchPeople`'s fast headless shape carries no career
  // stage and no clinician flag, so hydrate both from Scholar for the (bounded) fused
  // candidate list, alongside the technology count this already fetched.
  const [grouped, measureRows] = await Promise.all([
    db.read.scholarTechnology.groupBy({
      by: ["cwid"],
      where: { cwid: { in: cwids } },
      _count: { _all: true },
    }),
    db.read.scholar.findMany({
      where: { cwid: { in: cwids } },
      select: {
        cwid: true,
        roleCategory: true,
        primaryTitle: true,
        hasClinicalProfile: true,
        appointments: { select: { startDate: true } },
        educations: { select: { year: true, degree: true } },
      },
    }),
  ]);
  const techByCwid = new Map(grouped.map((g) => [g.cwid, g._count._all]));
  const now = new Date();
  const measuresByCwid = new Map(measureRows.map((s) => [s.cwid, matchaMeasuresFrom(s, now)]));

  // Map to the wire `MatchaCandidate`. Display fields (name/slug/title/department) ride
  // in from the `searchPeople` hits — no extra profile read. `fusedScore` is the RRF sum
  // at DEFAULT weights; the UI buckets it into a tier relative to the top hit and never
  // renders the raw number. `contributions` is the hinge — it comes straight out of
  // `rrfFuse`, which already had every (concept, rank) pair and used to discard them.
  // #1689 — `searchEvidence` is the SAME `ResultEvidence` object the public People card
  // renders, taken straight off the hit. Not a sponsor-specific lookalike: the panel feeds it
  // to the search's own `<EvidenceLine>`, so the two surfaces cannot drift into telling an
  // officer two different stories about why one scholar matched.
  //
  // `measures` stays absent for a cwid with no Scholar row rather than defaulting to a bucket;
  // `searchEvidence` likewise stays ABSENT when no cluster produced evidence for the candidate
  // (a cluster with no resolved MeSH descriptor cannot yield a tagged count). Absent ≠ none.
  // The wire concepts, by their join key — so the cap below can weigh a contribution the same
  // way every consumer of the payload weighs it.
  const conceptByTerm = new Map(concepts.map((c) => [c.term, c]));

  const candidates: MatchaCandidate[] = fused.map((f) => {
    const hit = hitByCwid.get(f.cwid);

    // #1696 — evidence for EVERY concept the candidate ranked under, not just their best one.
    //
    // IT COSTS NOTHING, AND THAT IS THE POINT. Every entry read here was already retrieved by
    // the per-concept fan-out above and was then thrown away: the old code looked up the single
    // best-ranked concept and dropped the others on the floor. This is a Map read per
    // contribution, and no OpenSearch traffic whatsoever. That distinction is load-bearing on
    // this route: the fan-out (MAX_TERMS × MAX_PAGES sequential `searchPeople` calls) is
    // EXACTLY the budget the OpenSearch parent circuit breaker polices, and it is why
    // `skipFacetAggs` and the 12→8 MAX_TERMS cut exist. A richer card that spent more of that
    // budget would be a bad trade; this one spends none of it.
    //
    // ORDERED AND CAPPED BY STRENGTH — `conceptWeight(concept) / (DEFAULT_K + rank)`, the exact
    // term the fusion sums for this (candidate, concept) pair, and the exact quantity
    // `matchedConcepts` ranks the card's chips by. NOT by raw rank, which is what the first cut
    // of this did and which inverts the cap in the common case:
    //
    //   γ=3 means centrality DOMINATES rank, and the anti-correlation runs the wrong way. A
    //   sponsor's PRIMARY concept is its broadest, most competitive query, so a specialist
    //   ranks WORSE on it than on some narrow peripheral mechanism. With the real constants
    //   (K=30, aligned 1.25, off-target 0.8):
    //
    //     target    (centrality 1.0, aligned)     weight 1.25 → 1.25/(30+25) = 0.0227
    //     mechanism (centrality 0.5, off-target)  weight 0.10 → 0.10/(30+1)  = 0.0032
    //
    //   A rank cap keeps the mechanism at rank 1 and DROPS the target at rank 25 — slicing off
    //   the concept the card leads with as its first chip. The blocks would then contradict the
    //   chips beside them, which is precisely the failure the derived-not-wired chips exist to
    //   prevent.
    //
    // DEFAULT_K and default weights, because the server can only cap at the weights it knows.
    // See `MatchaCandidate.searchEvidence` for the residual this leaves, which is real and is
    // documented rather than papered over.
    //
    // ABSENT ≠ NONE, per concept and per candidate. A concept whose evidence is not MATCH
    // evidence (the identity tail — see the `isResearchMatchEvidence` guard above) contributes NO entry,
    // and neither does one that produced no evidence at all — never a placeholder, never a
    // zeroed count. If none of them did, the field stays absent entirely rather than becoming
    // `[]`. Dropping those BEFORE the slice is load-bearing, not incidental: a cap applied first
    // would spend its three slots on concepts that ship nothing and leave the card blank while
    // real evidence sat unused in the map. (It also repairs a narrower loss in the old best-only
    // read, where a candidate whose best-ranked concept was an unresolved cluster shipped NO
    // evidence at all, even though the concepts below it had some.)
    const searchEvidence = f.contributions
      .flatMap((c) => {
        const concept = conceptByTerm.get(c.term);
        const ev = evidenceByTermCwid.get(evidenceKey(c.term, f.cwid));
        if (!concept || !ev) return [];
        return [{ ev, strength: conceptWeight(concept) / (DEFAULT_K + c.rank) }];
      })
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_EVIDENCE_CONCEPTS)
      .map(({ ev }) => ev);

    return {
      cwid: f.cwid,
      name: hit?.preferredName ?? f.cwid,
      profileSlug: hit?.slug ?? f.cwid,
      title: hit?.primaryTitle ?? null,
      department: hit?.primaryDepartment ?? null,
      fusedScore: f.score,
      contributions: f.contributions,
      technologyCount: techByCwid.get(f.cwid) ?? 0,
      identityImageEndpoint: identityImageEndpoint(f.cwid),
      measures: measuresByCwid.get(f.cwid),
      // D1 — the per-scholar most-recent year (recency input + D8's "latest YYYY"). Emitted only
      // under the flag and only when known, so the off / no-year response stays byte-identical.
      ...(recencyOn && hit?.mostRecentYear != null ? { mostRecentYear: hit.mostRecentYear } : {}),
      // Matcha's A–Z sort key. Emitted unconditionally (no flag gates it) and NOT collapsed to the
      // display name when unknown: a null tells the sort this scholar has no surname key, which is
      // a different fact from a scholar sorting under the first token of `name`.
      lastNameSort: hit?.lastNameSort ?? null,
      ...(searchEvidence.length > 0 ? { searchEvidence } : {}),
    };
  });
  return { concepts, candidates, titleSummary, culled };
}
