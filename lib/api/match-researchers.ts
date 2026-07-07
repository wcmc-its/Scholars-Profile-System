/**
 * GrantRecs Phase 2 — reverse matcher ("Find researchers for this opportunity").
 * Given an opportunity's topic_vector, fan the existing per-topic scholar
 * aggregation (getTopScholarsForTopic-style) across the opportunity's top topics
 * and combine, weighting each topic by its score. Symmetric with the forward
 * matcher: `topicFit` and `stageAppeal` stay DISTINCT axes; `defaultScore` is a
 * blend over them. Default lens leaves stage out ("who could apply"); the admin
 * can switch the stage lens on ("who would this suit") — spec §7.4.
 *
 * The pure `rankResearchers` core carries the unit coverage; the async
 * `rankResearchersForOpportunity` wrapper is integration-gated (MySQL).
 */
import { topicAffinity } from "@/lib/api/match-opportunities";
import {
  careerStageBucket,
  DEGREE_EARLY_MAX_YEARS,
  yearsSinceTerminalDegree,
  type CareerStage,
} from "@/lib/career-stage";
import { db } from "@/lib/db";
import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";
import { isFundingActive } from "@/lib/funding-active";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";
import { scorePublication, type RankablePublication } from "@/lib/ranking";
import { OPPORTUNITY_TOPIC_GATE, type OpportunityTopicScore } from "@/lib/search";
import { relevanceScoresForQuery } from "@/lib/api/search";

const RECITERAI_YEAR_FLOOR = 2020; // D-15; mirrors lib/api/topics.ts.

// Subtopic-grain reverse matcher (grant→researcher), flag-gated + ships dark. ON only
// when GRANT_MATCHER_SUBTOPIC_GRAIN === "on" AND the opportunity carries a compiled
// match_dsl; otherwise the proven topicVector path runs byte-identical.
const grantMatcherSubtopicGrain = () => process.env.GRANT_MATCHER_SUBTOPIC_GRAIN === "on";
// Relevance-boost strength: variantB × (1 + REL_BOOST · normRelevance). REL_BOOST=2 is
// the validated knob (match_v4/v7); 0 ⇒ pure node-pool (no boost). ponytail: one env knob.
const grantMatcherRelBoost = () => {
  const n = Number(process.env.GRANT_MATCHER_REL_BOOST);
  return Number.isFinite(n) && n >= 0 ? n : 2;
};
// One synthetic topic id for the subtopic pool's single TopicResult (weight 1, so
// topicFit = Σ boosted Variant-B). The unchanged downstream renders it as the evidence.
const SUBTOPIC_SYNTHETIC_TOPIC_ID = "__grant_subtopic__";

type MatchDsl = { require: string[]; penalize: string[] };

/** Parse the stored match_dsl JSON → {require, penalize} subtopic slugs; null when
 *  absent/empty so the matcher fails closed to the topicVector path. */
function parseMatchDsl(raw: unknown): MatchDsl | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const require = Array.isArray(o.require) ? o.require.filter((s): s is string => typeof s === "string") : [];
  if (require.length === 0) return null;
  const penalize = Array.isArray(o.penalize) ? o.penalize.filter((s): s is string => typeof s === "string") : [];
  return { require, penalize };
}

// Dense relevance (match_rel) is preferred over the live BM25 boost when present. This opt-out
// knob reverts to BM25 without a reproject (set "off"), the rollback lever for the ranking change.
const grantMatcherDenseRel = () => process.env.GRANT_MATCHER_DENSE_REL !== "off";

// Abstention floor: when > 0, a match is flagged weak ("no strong WCM match") if the mean of the
// top-8 ranked scholars' top-3 pub relevances falls below it. 0 = off (ships dark). Strict add —
// only ever sets a flag, never reorders/drops. 0.10 is the offline-validated PRIOR (match_v9b vs the
// 32-grant baseline); the served OpenSearch pool differs, so re-validate on staging before prod.
// Subtopic-grain path only (that's where the per-pub relevance signal exists).
const grantMatcherAbstainFloor = () => {
  const n = Number(process.env.GRANT_MATCHER_ABSTAIN_FLOOR);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Parse the stored match_rel JSON → `{pmid: cosine∈[0,1]}` as a Map (same shape as the BM25
 *  `relevanceScoresForQuery`, a drop-in rel source); null when absent/empty so the matcher falls
 *  back to the BM25 query boost. Values are already pool-max-normalized + floored by the producer. */
function parseMatchRel(raw: unknown): Map<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = new Map<string, number>();
  for (const [pmid, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) m.set(pmid, n);
  }
  return m.size > 0 ? m : null;
}

/** One scholar's Variant-B score within a single topic. */
export type ScholarTopicScore = {
  cwid: string;
  slug: string;
  preferredName?: string;
  variantBScore: number;
  /** Distinct first/last-author papers this scholar has in this topic (year ≥ floor). */
  pubCount?: number;
  /** Earliest contributing paper year for this scholar+topic (null if unknown). */
  minYear?: number | null;
};

/** Per-topic ranked scholars + the topic's weight in the opportunity vector. */
export type TopicResult = {
  topicId: string;
  topicWeight: number;
  scholars: ScholarTopicScore[];
};

/** One topic's contribution to a researcher's fit, plus the evidence behind it. */
export type TopicContribution = {
  topicId: string;
  contribution: number;
  pubCount: number;
  minYear: number | null;
};

export type RankedScholar = {
  cwid: string;
  slug: string;
  preferredName?: string;
  /** Career-stage bucket (for the stage filter + row blurb); null when undateable. */
  careerStage: CareerStage | null;
  /** Denormalized display fields (attached post-ranking; not scoring inputs). */
  title?: string | null;
  department?: string | null;
  axes: { topicFit: number; stageAppeal: number };
  topicContributions: TopicContribution[];
  defaultScore: number;
  /** Grant-history signals (attached post-ranking; absent when not loaded). */
  esiEligible?: boolean;
  /** Years since terminal degree; null when undateable. Feeds the ESI blurb clause. */
  yearsSinceDegree?: number | null;
  fundingStatus?: FundingStatus;
  /** Cross-ref: this opportunity is among the scholar's top-N forward matches. */
  inMyTopMatches?: boolean;
};

export type FundingStatus = "funded" | "unfunded";

// NIH ESI is forfeited by a prior "substantial independent" award as PI. These are
// the disqualifying NIH activity-code prefixes (R01-equivalents + major U/DP/RF).
// ponytail: prefix list off NIH's ESI guidance; tune if curators flag false drops.
const MAJOR_PI_MECHANISMS = ["R01", "R37", "R35", "RF1", "U01", "DP1", "DP2", "DP5", "R61"];
// Lead roles — the ones that confer independence (for the ESI disqualification).
const LEAD_GRANT_ROLES = new Set(["PI", "Co-PI", "MPI", "PI-Subaward"]);

// NIH ESI is keyed to the TERMINAL research/clinical degree, not the most recent
// credential — so a later MPH/cert/fellowship row must not reset the clock. Match
// research/clinical doctorates; non-doctoral rows (master's, residency, fellowship)
// are dropped before taking the latest year.
// ponytail: degree-string regex, not a parser; falls back to all rows when nothing
// matches (so master's-only / unparseable scholars still date). Tighten if curators
// flag mis-classified doctorates.
const TERMINAL_DEGREE_RE =
  /\b(ph\.?\s?d|m\.?\s?d|d\.?\s?o|d\.?\s?v\.?\s?m|d\.?\s?d\.?\s?s|d\.?\s?m\.?\s?d|sc\.?\s?d|d\.?\s?sc|dr\.?\s?p\.?\s?h|d\.?\s?n\.?\s?p|pharm\.?\s?d|ed\.?\s?d)\b/i;

export type GrantSignalInput = {
  grants: ReadonlyArray<{ endDate: Date | null; role: string | null; mechanism: string | null }>;
  educations?: ReadonlyArray<{ year: number | null; degree?: string | null }>;
};

export type GrantSignals = {
  esiEligible: boolean;
  yearsSinceDegree: number | null;
  fundingStatus: FundingStatus;
};

/**
 * Pure: derive grant-history display signals for one scholar.
 * - `fundingStatus` = any award still active per the canonical `isFundingActive`
 *   (end date + 12-month NCE grace), so it agrees with the profile's "Active
 *   funding" badge. Any role counts. ponytail: literal "currently funded".
 * - `esiEligible` = within the ESI window (years since the TERMINAL research/
 *   clinical degree < DEGREE_EARLY_MAX_YEARS) AND no prior major independent award
 *   held as PI. Unknown degree year → not eligible (we can't claim it).
 */
export function deriveGrantSignals(input: GrantSignalInput, now: Date): GrantSignals {
  const grants = input.grants ?? [];
  const isActive = (g: GrantSignalInput["grants"][number]) =>
    g.endDate instanceof Date && !Number.isNaN(g.endDate.getTime()) && isFundingActive(g.endDate, now);
  const isLead = (g: GrantSignalInput["grants"][number]) => LEAD_GRANT_ROLES.has((g.role ?? "").trim());

  const fundingStatus: FundingStatus = grants.some(isActive) ? "funded" : "unfunded";

  // ESI clock: latest TERMINAL degree year; fall back to all degrees when none of
  // a scholar's education rows parse as a doctorate.
  const educations = input.educations ?? [];
  const terminal = educations.filter((e) => TERMINAL_DEGREE_RE.test(e.degree ?? ""));
  const esiEducations = terminal.length > 0 ? terminal : educations;
  const yearsSinceDegree = yearsSinceTerminalDegree(
    { roleCategory: undefined, educations: esiEducations },
    now,
  );
  const hasMajorPiAward = grants.some(
    (g) => isLead(g) && MAJOR_PI_MECHANISMS.some((m) => (g.mechanism ?? "").toUpperCase().startsWith(m)),
  );
  const esiEligible =
    yearsSinceDegree !== null && yearsSinceDegree < DEGREE_EARLY_MAX_YEARS && !hasMajorPiAward;
  return { esiEligible, yearsSinceDegree, fundingStatus };
}

export type ResearcherSort = "fit" | "stage";

export type RankResearchersOptions = {
  /** The opportunity's appeal-by-stage map (for the stageAppeal axis / lens). */
  appealByStage?: Partial<Record<CareerStage, number>>;
  /** Career stage per candidate cwid (for the stageAppeal axis / lens). */
  stageByCwid?: Map<string, CareerStage>;
  /** When true, blend stageAppeal into defaultScore ("who would this suit"). Default off. */
  stageLens?: boolean;
  /**
   * Soft ESI gate: when true, demote ESI-ineligible scholars BELOW eligible ones
   * (stable — order within each group preserved), applied before `limit` so eligible
   * scholars below the cut surface. Never DROPS anyone, so a fragile esiEligible
   * derivation (undateable scholars, R61/subaward false positives) can't silently
   * exclude — wrong direction is a demotion, not a disappearance. Default off.
   */
  esiOnly?: boolean;
  /** ESI eligibility per candidate cwid; read only by the esiOnly demote. */
  esiEligibleByCwid?: Map<string, boolean>;
  sort?: ResearcherSort;
  limit?: number;
};

/**
 * Pure: combine per-topic scholar rankings into one ranked list. `topicFit` =
 * Σ_t (topicWeight · variantBScore); `stageAppeal` = the opportunity's appeal for
 * the scholar's stage. Axes are always retained; `stageLens`/`sort` only move the
 * ordering / default blend.
 */
export function rankResearchers(
  topicResults: TopicResult[],
  opts: RankResearchersOptions = {},
): RankedScholar[] {
  type Acc = {
    cwid: string;
    slug: string;
    preferredName?: string;
    topicFit: number;
    contributions: TopicContribution[];
  };
  const byCwid = new Map<string, Acc>();

  for (const tr of topicResults) {
    for (const s of tr.scholars) {
      const contribution = tr.topicWeight * s.variantBScore;
      const acc =
        byCwid.get(s.cwid) ??
        { cwid: s.cwid, slug: s.slug, preferredName: s.preferredName, topicFit: 0, contributions: [] };
      acc.topicFit += contribution;
      acc.contributions.push({
        topicId: tr.topicId,
        contribution,
        pubCount: s.pubCount ?? 0,
        minYear: s.minYear ?? null,
      });
      byCwid.set(s.cwid, acc);
    }
  }

  const appeal = opts.appealByStage ?? {};
  const stageByCwid = opts.stageByCwid;
  const ranked: RankedScholar[] = [];
  for (const acc of byCwid.values()) {
    const stage = stageByCwid?.get(acc.cwid);
    const stageAppeal = stage ? (appeal[stage] ?? 0) : 0;
    const defaultScore = opts.stageLens ? acc.topicFit * stageAppeal : acc.topicFit;
    ranked.push({
      cwid: acc.cwid,
      slug: acc.slug,
      preferredName: acc.preferredName,
      careerStage: stage ?? null,
      axes: { topicFit: acc.topicFit, stageAppeal },
      topicContributions: acc.contributions,
      defaultScore,
    });
  }

  // ponytail: relies on Array.sort being stable (ES2019+) so within-group order holds.
  const esiRank = (cwid: string) => (opts.esiEligibleByCwid?.get(cwid) === true ? 0 : 1);
  ranked.sort((a, b) => {
    if (opts.esiOnly) {
      const d = esiRank(a.cwid) - esiRank(b.cwid);
      if (d !== 0) return d; // eligible (0) before ineligible (1); soft — never drops
    }
    return (opts.sort ?? "fit") === "stage"
      ? b.axes.stageAppeal - a.axes.stageAppeal
      : b.defaultScore - a.defaultScore;
  });
  return typeof opts.limit === "number" ? ranked.slice(0, opts.limit) : ranked;
}

// ── I/O wrapper (integration-gated; needs MySQL) ───────────────────────────

/** Top topics of an opportunity (score ≥ gate), as {topicId, weight}. */
export function opportunityTopTopics(topicVector: OpportunityTopicScore[], gate: number, k: number) {
  return topicVector
    .filter((t) => t && typeof t.topic_id === "string" && typeof t.score === "number" && t.score >= gate)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((t) => ({ topicId: t.topic_id, topicWeight: t.score }));
}

/**
 * Default path: fan the getTopScholarsForTopic aggregation across the opportunity's
 * top topics (first/last author, FT faculty, year≥floor, non-excluded pub types),
 * scored with the Variant-B curve. Extracted verbatim so the subtopic path can branch.
 */
async function topicVectorResults(
  opp: { topicVector: unknown },
  opts: { topK?: number },
  now: Date,
): Promise<TopicResult[]> {
  const topics = opportunityTopTopics(
    (Array.isArray(opp.topicVector) ? opp.topicVector : []) as OpportunityTopicScore[],
    OPPORTUNITY_TOPIC_GATE,
    opts.topK ?? 8,
  );
  if (topics.length === 0) return [];

  return Promise.all(
    topics.map(async ({ topicId, topicWeight }) => {
      const rows = await db.read.publicationTopic.findMany({
        where: {
          parentTopicId: topicId,
          authorPosition: { in: ["first", "last"] },
          year: { gte: RECITERAI_YEAR_FLOOR },
          scholar: { deletedAt: null, status: "active", roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] } },
          publication: { publicationType: { notIn: [...FEED_EXCLUDED_TYPES] } },
        },
        include: {
          scholar: { select: { cwid: true, slug: true, preferredName: true } },
          publication: { select: { pmid: true, publicationType: true, dateAddedToEntrez: true } },
        },
      });

      const byScholar = new Map<
        string,
        { entry: ScholarTopicScore; pmids: Set<string>; minYear: number | null }
      >();
      for (const r of rows) {
        const rankable: RankablePublication = {
          pmid: r.publication.pmid,
          publicationType: r.publication.publicationType,
          reciteraiImpact: Number(r.score),
          dateAddedToEntrez: r.publication.dateAddedToEntrez,
          authorship: {
            isFirst: r.authorPosition === "first",
            isLast: r.authorPosition === "last",
            isPenultimate: r.authorPosition === "penultimate",
          },
          isConfirmed: true,
        };
        const inc = scorePublication(rankable, "top_scholars", true, now);
        const slot =
          byScholar.get(r.scholar.cwid) ??
          {
            entry: {
              cwid: r.scholar.cwid,
              slug: r.scholar.slug,
              preferredName: r.scholar.preferredName ?? undefined,
              variantBScore: 0,
            },
            pmids: new Set<string>(),
            minYear: null as number | null,
          };
        slot.entry.variantBScore += inc;
        slot.pmids.add(r.publication.pmid);
        if (r.year != null) slot.minYear = slot.minYear == null ? r.year : Math.min(slot.minYear, r.year);
        byScholar.set(r.scholar.cwid, slot);
      }
      return {
        topicId,
        topicWeight,
        scholars: [...byScholar.values()].map((s) => ({
          ...s.entry,
          pubCount: s.pmids.size,
          minYear: s.minYear,
        })),
      };
    }),
  );
}

/**
 * Subtopic-grain candidate pool for the reverse matcher: instead of fanning the
 * topicVector across parent topics, draw ONE pool of first/last-author papers whose
 * `primary_subtopic_id` CONTAINS any `dsl.require` substring (the compiler emits substring
 * patterns, not exact ids — match_v7 `likeAny` semantics; an exact `in` matched ~0 rows and
 * silently fell back to topicVector), drop papers tagged with a `dsl.penalize` substring
 * (hard exclusion), score each with the SAME Variant-B
 * curve, and fold in a per-paper relevance boost from the compiled BM25 query (one
 * OpenSearch round-trip). Returns a single synthetic TopicResult so the unchanged
 * downstream (rankResearchers / stage / signals / crossRef) takes over verbatim.
 */
async function subtopicPoolResults(
  dsl: MatchDsl,
  matchQuery: unknown,
  matchRel: unknown,
  now: Date,
): Promise<{ topicResults: TopicResult[]; relByCwid: Map<string, number[]> }> {
  const rows = await db.read.publicationTopic.findMany({
    where: {
      // SUBSTRING match: the compiler emits `require` as substring patterns (e.g. "biochem",
      // "gpcr_signal"), not exact subtopic ids. An exact `{ in: require }` matched ~0 rows on the
      // real long-form `primary_subtopic_id` vocab → silent topicVector fallback. ponytail: the
      // `%substring%` LIKEs can't use the primary_subtopic_id index; the author/year/role filters
      // narrow first, and the route is admin-only — revisit with a prefix scheme if latency bites.
      OR: dsl.require.map((p) => ({ primarySubtopicId: { contains: p } })),
      authorPosition: { in: ["first", "last"] },
      year: { gte: RECITERAI_YEAR_FLOOR },
      scholar: { deletedAt: null, status: "active", roleCategory: { in: [...TOP_SCHOLARS_ELIGIBLE_ROLES] } },
      publication: { publicationType: { notIn: [...FEED_EXCLUDED_TYPES] } },
    },
    include: {
      scholar: { select: { cwid: true, slug: true, preferredName: true } },
      publication: { select: { pmid: true, publicationType: true, dateAddedToEntrez: true } },
    },
  });

  // penalize = hard exclusion: drop any paper a `penalize` substring matches (same substring
  // semantics as `require` above; an exact Set.has would silently under-exclude the same way).
  const penalize = dsl.penalize;
  const kept =
    penalize.length === 0
      ? rows
      : rows.filter((r) => {
          const sids = r.subtopicIds;
          return !(
            Array.isArray(sids) &&
            sids.some((s) => typeof s === "string" && penalize.some((p) => s.includes(p)))
          );
        });

  // Relevance boost (no-ops when neither source has the pmid): normalized [0,1] per pmid. Prefer
  // the precomputed DENSE map (match_rel, Titan cosine) when present; else live BM25 (match_query).
  const dense = grantMatcherDenseRel() ? parseMatchRel(matchRel) : null;
  const rel = dense ?? (await relevanceScoresForQuery(matchQuery, 1000));
  const relBoost = grantMatcherRelBoost();

  const byScholar = new Map<
    string,
    { entry: ScholarTopicScore; pmids: Set<string>; minYear: number | null; rels: number[] }
  >();
  for (const r of kept) {
    // ponytail: rankable build mirrors topicVectorResults; ~8 lines, not worth a shared helper.
    const rankable: RankablePublication = {
      pmid: r.publication.pmid,
      publicationType: r.publication.publicationType,
      reciteraiImpact: Number(r.score),
      dateAddedToEntrez: r.publication.dateAddedToEntrez,
      authorship: {
        isFirst: r.authorPosition === "first",
        isLast: r.authorPosition === "last",
        isPenultimate: r.authorPosition === "penultimate",
      },
      isConfirmed: true,
    };
    const inc = scorePublication(rankable, "top_scholars", true, now);
    const nr = rel.get(r.publication.pmid) ?? 0; // pubs absent from the rel set keep pure Variant-B
    const boosted = inc * (1 + relBoost * nr);
    const slot =
      byScholar.get(r.scholar.cwid) ??
      {
        entry: {
          cwid: r.scholar.cwid,
          slug: r.scholar.slug,
          preferredName: r.scholar.preferredName ?? undefined,
          variantBScore: 0,
        },
        pmids: new Set<string>(),
        minYear: null as number | null,
        rels: [] as number[],
      };
    slot.entry.variantBScore += boosted;
    slot.pmids.add(r.publication.pmid);
    slot.rels.push(nr); // per-pub normalized relevance — kept for the abstention floor (else discarded)
    if (r.year != null) slot.minYear = slot.minYear == null ? r.year : Math.min(slot.minYear, r.year);
    byScholar.set(r.scholar.cwid, slot);
  }
  const relByCwid = new Map<string, number[]>([...byScholar].map(([cwid, s]) => [cwid, s.rels]));
  return {
    topicResults: [
      {
        topicId: SUBTOPIC_SYNTHETIC_TOPIC_ID,
        topicWeight: 1,
        scholars: [...byScholar.values()].map((s) => ({ ...s.entry, pubCount: s.pmids.size, minYear: s.minYear })),
      },
    ],
    relByCwid,
  };
}

/**
 * Pure: the abstention signal — mean over the top-`k` ranked scholars of each one's top-3 pub
 * relevances. Mirrors match_v9b's `meanTopRel`. Exported for unit coverage (the DB-gated
 * `rankResearchersForOpportunity` wrapper can't be unit-tested directly).
 */
export function meanTopRelevance(
  cwidsInRankOrder: string[],
  relByCwid: Map<string, number[]>,
  k = 8,
): number {
  const rels = cwidsInRankOrder
    .slice(0, k)
    .flatMap((c) => (relByCwid.get(c) ?? []).slice().sort((a, b) => b - a).slice(0, 3));
  return rels.length > 0 ? rels.reduce((a, b) => a + b, 0) / rels.length : 0;
}

export type OpportunityMatchResult = {
  scholars: RankedScholar[];
  /** True when the top matches are too weak to trust — mean top-8 relevance below the abstention
   *  floor (`GRANT_MATCHER_ABSTAIN_FLOOR`). Always false when the floor is off or the opportunity
   *  took the topicVector fallback (no per-pub relevance signal there). */
  abstain: boolean;
  /** The signal the abstain decision reads; 0 when not computed (floor off / non-subtopic path). */
  meanTopRel: number;
};

/**
 * Full reverse match: load the opportunity, fan getTopScholarsForTopic-style
 * aggregation across its topics, combine. Integration-gated (MySQL); the pure
 * `rankResearchers` core above carries the unit coverage.
 */
export async function rankResearchersForOpportunity(
  opportunityId: string,
  opts: {
    stageLens?: boolean;
    /** Soft ESI gate — demote ESI-ineligible scholars below eligible ones. Off by default. */
    esiOnly?: boolean;
    sort?: ResearcherSort;
    limit?: number;
    topK?: number;
    now?: Date;
    /** Attach `inMyTopMatches` (the cheap forward cross-ref). Off by default. */
    crossRef?: boolean;
  } = {},
): Promise<OpportunityMatchResult> {
  const now = opts.now ?? new Date();
  const opp = await db.read.opportunity.findUnique({
    where: { opportunityId },
    select: { topicVector: true, appealByStage: true, matchDsl: true, matchQuery: true, matchRel: true },
  });
  if (!opp) return { scholars: [], abstain: false, meanTopRel: 0 };

  // Subtopic-grain path (flag-gated, ships dark): when the flag is on and the
  // opportunity carries a compiled match_dsl, draw ONE subtopic pool with a relevance
  // boost. Falls back to the topicVector fan when the pool is empty (drifted/stale
  // require slugs) so a bad DSL degrades instead of 500ing.
  const dsl = grantMatcherSubtopicGrain() ? parseMatchDsl(opp.matchDsl) : null;
  let topicResults: TopicResult[];
  // Per-scholar relevance from the subtopic pool — present only when that path actually served
  // (not the topicVector fallback); it's the signal the abstention floor reads.
  let relByCwid: Map<string, number[]> | null = null;
  if (dsl) {
    const pooled = await subtopicPoolResults(dsl, opp.matchQuery, opp.matchRel, now);
    if (pooled.topicResults[0].scholars.length > 0) {
      topicResults = pooled.topicResults;
      relByCwid = pooled.relByCwid;
    } else {
      topicResults = await topicVectorResults(opp, opts, now);
    }
  } else {
    topicResults = await topicVectorResults(opp, opts, now);
  }
  if (topicResults.every((tr) => tr.scholars.length === 0)) return { scholars: [], abstain: false, meanTopRel: 0 };

  // Career stage + display metadata per candidate. One query: stage feeds the
  // stageAppeal axis; primaryTitle/primaryDepartment are denormalized on the
  // scholar row (ED primary appointment) and attached post-ranking for the row.
  const cwids = [...new Set(topicResults.flatMap((tr) => tr.scholars.map((s) => s.cwid)))];
  const stageByCwid = new Map<string, CareerStage>();
  const profileByCwid = new Map<string, { title: string | null; department: string | null }>();
  const signalsByCwid = new Map<string, GrantSignals>();
  if (cwids.length > 0) {
    const scholars = await db.read.scholar.findMany({
      where: { cwid: { in: cwids } },
      select: {
        cwid: true,
        roleCategory: true,
        primaryTitle: true,
        primaryDepartment: true,
        appointments: { select: { startDate: true } },
        educations: { select: { year: true, degree: true } },
        grants: { select: { endDate: true, role: true, mechanism: true } },
      },
    });
    for (const s of scholars) {
      stageByCwid.set(
        s.cwid,
        careerStageBucket(
          { roleCategory: s.roleCategory, title: s.primaryTitle, appointments: s.appointments, educations: s.educations },
          now,
        ),
      );
      profileByCwid.set(s.cwid, { title: s.primaryTitle, department: s.primaryDepartment });
      signalsByCwid.set(s.cwid, deriveGrantSignals({ grants: s.grants, educations: s.educations }, now));
    }
  }

  const ranked = rankResearchers(topicResults, {
    appealByStage: (opp.appealByStage ?? {}) as Partial<Record<CareerStage, number>>,
    stageByCwid,
    stageLens: opts.stageLens,
    esiOnly: opts.esiOnly,
    esiEligibleByCwid: new Map([...signalsByCwid].map(([c, s]) => [c, s.esiEligible])),
    sort: opts.sort,
    limit: opts.limit,
  });
  for (const r of ranked) {
    const p = profileByCwid.get(r.cwid);
    r.title = p?.title ?? null;
    r.department = p?.department ?? null;
    const sig = signalsByCwid.get(r.cwid);
    if (sig) {
      r.esiEligible = sig.esiEligible;
      r.yearsSinceDegree = sig.yearsSinceDegree;
      r.fundingStatus = sig.fundingStatus;
    }
  }

  if (opts.crossRef && ranked.length > 0) {
    const inTop = await opportunitiesInTopMatches(
      opportunityId,
      ranked.map((r) => r.cwid),
      CROSSREF_TOP_N,
      now,
    );
    for (const r of ranked) r.inMyTopMatches = inTop.has(r.cwid);
  }

  // Abstention floor (subtopic path only): mirror match_v9b's meanTopRel = mean over the top-8
  // ranked scholars of their top-3 pub relevances. Below the floor the shortlist is tangential —
  // flag it so the UI can warn "no strong WCM match" instead of presenting weak matches as strong.
  const floor = grantMatcherAbstainFloor();
  let abstain = false;
  let meanTopRel = 0;
  if (floor > 0 && relByCwid) {
    meanTopRel = meanTopRelevance(ranked.map((r) => r.cwid), relByCwid);
    abstain = meanTopRel < floor;
  }
  return { scholars: ranked, abstain, meanTopRel };
}

const CROSSREF_TOP_N = 10;

/** The forward matcher's hard candidate gate: open/forecasted/continuous, not past due. */
const OPEN_OPPORTUNITY_STATUSES = ["open", "forecasted", "continuous"];

/** Build a topic_id→weight map from an opportunity's stored topic_vector JSON. */
function vectorFromTopicScores(v: OpportunityTopicScore[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of v) {
    if (t && typeof t.topic_id === "string" && typeof t.score === "number") m.set(t.topic_id, t.score);
  }
  return m;
}

/**
 * Cheap forward cross-ref: which of `cwids` have `opportunityId` among their top-N
 * "Grants for me" matches, by TOPIC AFFINITY ALONE — no OpenSearch retrieval, no
 * stage/mesh axes. A MySQL-only proxy for "also surfaced under their own Grants for
 * me", validated against the full forward matcher on a sample
 * (scripts/funding-crossref-compare.ts).
 *
 * The candidate corpus is gated to the SAME status/deadline the real forward
 * matcher requires (open/forecasted/continuous, not past due), so a closed or
 * past-due viewed opportunity — reachable via the unfiltered browse list — can
 * never be claimed as "in their Grants for me".
 * ponytail: topic-only top-N over the open corpus. topicAffinity dominates the
 * forward blend (weight 1.0; stage multiplies it), so this tracks the full rank
 * closely. Residual: per-scholar stage/US eligibility flags aren't applied — a
 * smaller divergence source than status/deadline; upgrade to the full matcher only
 * if the comparison shows it diverging.
 */
export async function opportunitiesInTopMatches(
  opportunityId: string,
  cwids: string[],
  topN = CROSSREF_TOP_N,
  now: Date = new Date(),
): Promise<Set<string>> {
  const result = new Set<string>();
  if (cwids.length === 0) return result;

  // Open opportunity vectors once (tiny table) — same hard gate the forward matcher
  // applies, so an ineligible viewed opp drops out of every scholar's candidate set.
  // L2-normalization cancels in the per-scholar ranking, so raw weights are fine.
  const opps = await db.read.opportunity.findMany({
    where: {
      status: { in: OPEN_OPPORTUNITY_STATUSES },
      OR: [{ dueDate: null }, { dueDate: { gte: now } }, { status: "continuous" }],
    },
    select: { opportunityId: true, topicVector: true },
  });
  const oppVectors = opps.map((o) => ({
    id: o.opportunityId,
    vec: vectorFromTopicScores((Array.isArray(o.topicVector) ? o.topicVector : []) as OpportunityTopicScore[]),
  }));

  // One grouped query → each scholar's topic-weight vector (same source/floor as
  // scholarTopicVector). topicAffinity is scale-invariant, so we skip normalizing.
  const rows = await db.read.publicationTopic.groupBy({
    by: ["cwid", "parentTopicId"],
    where: {
      cwid: { in: cwids },
      year: { gte: RECITERAI_YEAR_FLOOR },
      scholar: { deletedAt: null, status: "active" },
    },
    _sum: { score: true },
  });
  const byScholar = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.cwid) continue;
    const w = Number(r._sum.score ?? 0);
    if (w <= 0) continue;
    const m = byScholar.get(r.cwid) ?? new Map<string, number>();
    m.set(r.parentTopicId, w);
    byScholar.set(r.cwid, m);
  }

  for (const [cwid, vec] of byScholar) {
    const ranked = oppVectors
      .map((o) => ({ id: o.id, aff: topicAffinity(vec, o.vec) }))
      .filter((x) => x.aff > 0)
      .sort((a, b) => b.aff - a.aff)
      .slice(0, topN);
    if (ranked.some((x) => x.id === opportunityId)) result.add(cwid);
  }
  return result;
}
