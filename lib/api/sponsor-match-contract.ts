/**
 * Sponsor-match — the UI ⇄ ranker CONTRACT.
 *
 * This file IS the seam. The ranker (`sponsor-match-spine-run.ts`) produces
 * `SponsorMatchResponse`; the console (`components/edit/sponsor-match-panel.tsx`)
 * consumes it and re-ranks with the reference functions below. Both import THIS
 * module, so a drift between them is a compile error rather than a live bug.
 *
 * WHY IT EXISTS: PR #1673 shipped the editable-centrality console against a mockup
 * instead of this contract and violated its central invariant (below). Nothing caught
 * it because the contract was prose only. Prose does not fail CI; this file does.
 *
 * THE INVARIANT (the hinge):
 *
 *     Sliders re-rank LIVE over the already-fetched candidates. No new search.
 *
 * That is only possible if the response carries the DECOMPOSED score inputs per
 * candidate rather than a final scalar:
 *
 *     score(s) = Σ_c  centrality(c)·weightFactor(c) / (K + rank_{s,c}) × (1 + λ·prefBoost(s))
 *                     └── editable ──┘└─── fixed ───┘   └─ per-candidate, per-concept ─┘
 *
 * `SponsorCandidate.contributions[]` carries `rank_{s,c}` for EVERY concept the
 * candidate appeared under — weak ones included, because they are re-rank inputs, not
 * display data. Ship a final score alone and the rail degrades to "re-query on every
 * drag", which the design rejects (each drag = up to 8 concepts × paged `searchPeople`
 * — seconds, not live).
 *
 * WHAT THIS FILE DOES NOT FREEZE: the ranker's WEIGHTING. `weightFactor` is named for its
 * role in the formula, not its implementation, and the engine's current choice for it
 * (corpus IDF) is known-broken — see `docs/2026-07-12-FINDING-idf-inverts-concept-weighting.md`
 * and the field's own doc below. Fixing the weighting is an engine change; this contract,
 * the route and the panel all stay put. The decomposition is what gets frozen here, and the
 * decomposition is right.
 *
 * DERIVED, NOT WIRED: the matched-concept chips and the fit tier are deliberately NOT
 * response fields. Both are computed client-side (`matchedConcepts`, `fitTier`) so they
 * stay live under the sliders instead of going stale the moment one moves.
 *
 * PRODUCER GAP: `measures`, `evidence`, `caveat`, `preferences`, `facets` and `ask` are
 * OPTIONAL because the spine has no producer for them yet — it sets `careerStage: null`,
 * leaves `topPapers`/`matchedTopics` empty on the fast headless `searchPeople` shape, and
 * runs `skipFacetAggs: true` (the fan-out breaker). They are typed here so the UI has a
 * compile-enforced target to build against, and optional so the route never has to
 * fabricate a value to satisfy the type. Absent ≠ zero.
 */
import type { CareerStage } from "@/lib/career-stage";

/**
 * RRF damping (pivot handoff §4). The head is damped so one concept's #1 hit cannot
 * dominate the fusion.
 *
 * The server fuses with this K and the client re-ranks with this K — same constant, one
 * definition. They MUST agree or `rerankCandidates` at default weights will not reproduce
 * the order the server sent (see `sponsor-match-contract.test.ts`, which asserts exactly
 * that round-trip).
 */
export const DEFAULT_K = 60;

/**
 * Fit-tier bands, as a fraction of the TOP candidate's fused score. The ranker stays
 * presentation-free: it ships `fusedScore` and the UI buckets it, so the tiers re-derive
 * live as sliders move.
 *
 * ponytail: proposed bands, not measured ones — the contract left the thresholds open.
 * They live here as named constants so retuning is a one-line edit in one place rather
 * than a hunt through the panel. Tune against staging once officers have used it.
 */
export const TIER_STRONG = 0.66;
export const TIER_GOOD = 0.33;

export type SponsorFitTier = "strong" | "good" | "weak";

/**
 * A research concept the funder wants funded — the unit the rail edits.
 *
 * This is the MERGED CLUSTER, not the raw extracted term: "cancer", "oncology" and
 * "leukemia" in one paste collapse to a single concept (equivalence decided by the MeSH
 * descriptor sets, not the LLM) so redundant sponsor phrasing cannot triple-weight one
 * idea. `term` is the cluster's representative — and the join key `contributions[].term`
 * points back to.
 */
export type SponsorConcept = {
  /** Representative term. The join key for `SponsorCandidate.contributions[].term`. */
  term: string;
  /** Splits the rail's Concept and Method panels. */
  kind: "concept" | "method";
  /** Every term that merged into this cluster (incl. `term`). The rail's chips. */
  members: string[];
  /** Funder-centrality in (0,1]. EDITABLE — this is what a slider moves. */
  centrality: number;
  /**
   * The FIXED half of the fusion weight: `weight = centrality × weightFactor`. Not editable.
   *
   * Named for its ROLE in the formula, not for its current implementation, and that is
   * deliberate. The RANKER owns what this number means; the contract only promises it is
   * the non-editable multiplicand, so the client can recompute the score after a slider
   * move. Today the spine sets it to `dampedIdf(corpus coverage)` — and that choice is
   * KNOWN-BROKEN: corpus rarity anti-correlates with topical centrality in a hierarchical
   * domain, so a disease's own mechanisms outweigh the disease (Myofibroblasts 8.44 >
   * Fibrosis 8.00 > Scleroderma 7.24), and a mechanism generalist outranks the disease
   * specialist. See `docs/2026-07-12-FINDING-idf-inverts-concept-weighting.md`.
   *
   * Landing this file does NOT bless that formula. Every fix the finding proposes — a
   * kind-based disease prior, a discriminating centrality rubric, per-kind weight
   * normalisation, the coverage=0 cliff — changes only how the ENGINE computes this number,
   * with no change to this type, the route, or the panel. (The K fix is the one exception,
   * and `DEFAULT_K` above is the single shared constant it edits.) That is the point of
   * naming it `weightFactor` rather than `rarity`.
   */
  weightFactor: number;
  /**
   * DISPLAY ONLY — never a ranking input, and never read by `fusedScore`. The fraction of
   * the local corpus carrying this concept, which is what the rail's rarity badge means.
   *
   * Split out from `weightFactor` on purpose: the badge is a claim about the LITERATURE
   * ("few Weill Cornell papers cover this"), while `weightFactor` is a claim about the
   * RANKING. They coincide today only because the engine happens to derive one from the
   * other, and the finding above is the case for pulling them apart. Conflating them is
   * what made the old ·rare badge misleading — it read as "this concept is distinctive"
   * while actually meaning "this MeSH term is uncommon in PubMed".
   *
   * ABSENT when unknown — no `mesh_descriptor` row, or a coverage of exactly 0 (which is
   * 40% of descriptors; see the finding's §6 cliff). Absent is NOT zero, and the UI must
   * render no badge rather than claim "common".
   */
  corpusCoverage?: number;
};

/** Per-candidate, per-concept retrieval rank (1-based) — `rank_{s,c}` in the formula.
 *  The re-rank inputs. A candidate carries one of these for EVERY concept it appeared
 *  under, however weakly. */
export type SponsorContribution = {
  /** Joins to `SponsorConcept.term`. */
  term: string;
  /** 1-based rank in that concept's `searchPeople` ranking. Lower is better. */
  rank: number;
};

/** Non-topical candidate attributes the preference nudges and status tags read.
 *  Optional throughout — the spine has no producer yet (see PRODUCER GAP). */
export type SponsorMeasures = {
  careerStage?: CareerStage | null;
  isClinician?: boolean;
};

/** Why this candidate ranked. Optional — the SPINE's fast headless `searchPeople` shape
 *  carries no per-topic pub counts or evidence pubs (it runs `skipFacetAggs`), and
 *  fabricating counts is forbidden, so it omits this entirely. The bespoke engine, which
 *  makes one scored BM25 round-trip, DOES populate it. */
export type SponsorEvidence = {
  topics?: { label: string; pubCount: number }[];
  methods?: { label: string; pubCount: number }[];
  papers?: {
    pmid: string;
    title: string;
    year: number | null;
    journal: string | null;
    /** BM25 relevance in [0,1], when the engine scored the paper. Bespoke only. */
    relevance?: number;
  }[];
};

export type SponsorCandidate = {
  cwid: string;
  name: string;
  /** Public profile slug — the card's link target. */
  profileSlug: string;
  title: string | null;
  department: string | null;
  /** Fused RRF score at the ranker's DEFAULT weights. The UI buckets it into a tier
   *  relative to the top hit and NEVER renders the raw number. Recomputed client-side by
   *  `rerankCandidates` as sliders move. */
  fusedScore: number;
  /** THE HINGE — see the module doc. Every concept this candidate appeared under. */
  contributions: SponsorContribution[];
  /** Licensable CTL technologies this researcher already holds. 0 when none. */
  technologyCount: number;
  measures?: SponsorMeasures;
  evidence?: SponsorEvidence;
  /** Near-miss reason. Present ⇒ the card takes the demoted treatment + amber caveat. */
  caveat?: string;
};

/** A non-topical nudge extracted from the paste ("we prefer physician-scientists").
 *  No producer yet. `measure` names which `SponsorMeasures` field the nudge reads — the
 *  UI owns the match predicate, so the ranker never has to encode presentation logic. */
export type SponsorPreference = {
  label: string;
  /** The "from paste: …" provenance line. */
  evidence: string;
  /** Slider start, in [0,1]. Feeds `prefBoost` in the formula. */
  importance: number;
  measure: keyof SponsorMeasures;
};

/** A client-side filter facet, counted over the FULL candidate set (pre-filter). Filtering
 *  preserves each row's re-ranked position and never re-queries. No producer yet — the
 *  spine runs `skipFacetAggs: true`. */
export type SponsorFacet = {
  group: string;
  label: string;
  count: number;
};

export type SponsorMatchResponse = {
  ok: true;
  concepts: SponsorConcept[];
  candidates: SponsorCandidate[];
  /** The funder's ask, for the results header. No producer yet. */
  ask?: { title: string; quote: string };
  preferences?: SponsorPreference[];
  facets?: SponsorFacet[];
};

/** Options for the reference scorers. `prefBoost` is injected because the UI owns the
 *  preference match predicate (the ranker ships `measures`, not verdicts). Absent ⇒ the
 *  preference term of the formula is inert, which is today's state. */
export type RerankOptions = {
  k?: number;
  /** Returns the candidate's preference boost in [0,1]. */
  prefBoost?: (candidate: SponsorCandidate) => number;
  /** Preference strength λ. Only read when `prefBoost` is supplied. */
  lambda?: number;
};

/** Fusion weight for one concept: `centrality × weightFactor`. Centrality is the slider;
 *  weightFactor is the ranker's fixed multiplicand. Zeroing a slider zeroes the concept's
 *  contribution without dropping it.
 *
 *  Note what is NOT here: `corpusCoverage`. It is display-only, and keeping it out of the
 *  one function that defines the weight is what makes that guarantee checkable rather than
 *  a comment. */
export function conceptWeight(concept: SponsorConcept): number {
  return concept.centrality * concept.weightFactor;
}

/** Term → fusion weight, for a whole concept set. */
export function conceptWeights(concepts: readonly SponsorConcept[]): Map<string, number> {
  return new Map(concepts.map((c) => [c.term, conceptWeight(c)]));
}

/**
 * The reference score (pivot handoff §4):
 *
 *     score(s) = Σ_c  weight(c) / (K + rank_{s,c})   × (1 + λ·prefBoost(s))
 *
 * PURE — this is what makes the live re-rank possible: given the response, a slider move
 * is arithmetic over data already in the browser, not a round-trip. A contribution whose
 * concept is absent from `weightByTerm` contributes 0 (it was dropped from the rail), and
 * a concept a candidate never appeared under contributes 0 by having no contribution row.
 */
export function fusedScore(
  candidate: SponsorCandidate,
  weightByTerm: ReadonlyMap<string, number>,
  opts: RerankOptions = {},
): number {
  const k = opts.k ?? DEFAULT_K;
  let score = 0;
  for (const { term, rank } of candidate.contributions) {
    score += (weightByTerm.get(term) ?? 0) / (k + rank);
  }
  if (!opts.prefBoost) return score;
  return score * (1 + (opts.lambda ?? 1) * opts.prefBoost(candidate));
}

/**
 * Re-rank the ALREADY-FETCHED candidates under an edited concept set. No network.
 *
 * At the ranker's default weights this reproduces the order the server sent — the
 * property the contract test pins, and the reason the server and client must share
 * `DEFAULT_K`. Ties break on the incoming order, which (since the server ships candidates
 * in fused order) preserves the ranker's own stable first-seen tie-break.
 *
 * An EMPTY concept set is a no-op, not a wipe. An engine with no concept decomposition
 * (the bespoke ranker) ships `concepts: []` and `contributions: []`, carrying its real
 * score in `fusedScore`. Re-ranking that by the formula would sum an empty contributions
 * list to 0 for every candidate and OVERWRITE the server's score with it — leaving the
 * order intact (every candidate ties, and ties keep the incoming order) while silently
 * flattening every derived `fitTier` to "weak", top hit included. There is nothing to
 * re-rank by, so we return what we were given.
 */
export function rerankCandidates(
  candidates: readonly SponsorCandidate[],
  concepts: readonly SponsorConcept[],
  opts: RerankOptions = {},
): SponsorCandidate[] {
  if (concepts.length === 0) return [...candidates];
  const weights = conceptWeights(concepts);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: fusedScore(candidate, weights, opts),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ candidate, score }) => ({ ...candidate, fusedScore: score }));
}

/**
 * The concepts a candidate actually matched, strongest first — the card's chips. DERIVED
 * (not wired) so the chips re-order live as sliders move: a concept slid to near-zero
 * drops down the chip list without a re-query.
 *
 * Strength is the concept's own contribution to this candidate's score — the same
 * `weight/(K + rank)` term the fusion sums — so a chip's prominence means exactly what it
 * means in the ranking. Concepts with zero weight are omitted (they contribute nothing).
 */
export function matchedConcepts(
  candidate: SponsorCandidate,
  concepts: readonly SponsorConcept[],
  opts: RerankOptions = {},
): { concept: SponsorConcept; strength: number }[] {
  const k = opts.k ?? DEFAULT_K;
  const byTerm = new Map(concepts.map((c) => [c.term, c]));
  return candidate.contributions
    .flatMap(({ term, rank }) => {
      const concept = byTerm.get(term);
      if (!concept) return [];
      const strength = conceptWeight(concept) / (k + rank);
      return strength > 0 ? [{ concept, strength }] : [];
    })
    .sort((a, b) => b.strength - a.strength);
}

/**
 * Bucket a candidate's fused score into a fit tier, RELATIVE to the top candidate's — the
 * raw fused number is never rendered (it is a query-scaled RRF sum and means nothing to a
 * reader on its own). A non-positive top score means nothing matched: everything is weak.
 */
export function fitTier(score: number, topScore: number): SponsorFitTier {
  if (topScore <= 0) return "weak";
  const share = score / topScore;
  if (share >= TIER_STRONG) return "strong";
  if (share >= TIER_GOOD) return "good";
  return "weak";
}

/** A concept is "rare" when its corpus coverage is at most this fraction of the most-covered
 *  concept in the SAME ask — i.e. roughly an order of magnitude scarcer than its peers. */
export const RARE_COVERAGE_RATIO = 0.1;

/**
 * The terms to badge as rare, judged RELATIVE to the other concepts in the same ask.
 *
 * Relative, because an absolute cutoff would badge everything: every MeSH concept is rare at
 * corpus scale. The seven concepts of the scleroderma ask span 4.9e-5 to 1.5e-3 — all "rare"
 * on any absolute threshold, so an absolute badge carries no information. What an officer can
 * actually act on is which concepts in THIS ask are the scarce ones locally, and that is a
 * within-ask comparison.
 *
 * A concept with no `corpusCoverage` is never badged (unknown ≠ common — see the field doc),
 * and it is excluded from the comparison rather than counted as zero. Fewer than two known
 * coverages means there is nothing to be relative TO, so nothing is badged.
 *
 * This reads `corpusCoverage` and nothing else. It has no access to `weightFactor`, which is
 * the structural guarantee that the badge cannot drift back into being a claim about ranking.
 */
export function rareTerms(concepts: readonly SponsorConcept[]): Set<string> {
  const known = concepts.filter(
    (c): c is SponsorConcept & { corpusCoverage: number } =>
      typeof c.corpusCoverage === "number" && c.corpusCoverage > 0,
  );
  if (known.length < 2) return new Set();
  const maxCoverage = Math.max(...known.map((c) => c.corpusCoverage));
  return new Set(
    known
      .filter((c) => c.corpusCoverage <= maxCoverage * RARE_COVERAGE_RATIO)
      .map((c) => c.term),
  );
}
