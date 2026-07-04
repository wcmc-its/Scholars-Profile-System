/**
 * GrantRecs Phase 2 — forward matcher ("Grants for me"): rank funding
 * opportunities for a scholar. The ranking core emits DISTINCT per-axis
 * sub-scores (topic / stage / mesh / deadline); `defaultScore` is one blend OVER
 * them, never a replacement — so a caller can sort per axis or re-weight at query
 * time without re-running the match (spec §7.3). Pure scoring is split from the
 * DB/OpenSearch I/O so the math is unit-testable without infrastructure.
 *
 * Two-stage: Stage 1 retrieves a candidate set from the `scholars-opportunities`
 * index (hard eligibility/deadline filters + coarse topic `should`), Stage 2
 * re-ranks in the app layer over the distinct axes.
 */
import { careerStageBucket, type CareerStage } from "@/lib/career-stage";
import { db } from "@/lib/db";
import { asPrestige, type Prestige } from "@/lib/funding/prestige";
import { OPPORTUNITIES_INDEX, searchClient, type OpportunityTopicScore } from "@/lib/search";

const RECITERAI_YEAR_FLOOR = 2020; // D-15; mirrors lib/api/topics.ts (module-local there).

// ── Axes & weights ─────────────────────────────────────────────────────────

export type MatchAxes = {
  topicAffinity: number;
  stageAppeal: number;
  meshOverlap: number;
  deadlineProximity: number;
  prestige: number;
};

export type MatchWeights = { topic: number; stage: number; mesh: number; deadline: number; prestige: number };

/** Default blend (decision A) — a starting point, tuned in calibration (spec §10). */
export const DEFAULT_WEIGHTS: MatchWeights = {
  topic: 1.0,
  stage: 0.5,
  mesh: 0.25,
  deadline: 0.1,
  prestige: 0, // launch = badge+sort only; raise post Track-A eval
};

/** Effective prestige weight from env (PRESTIGE_AXIS_WEIGHT). Defaults to 0; never negative. */
export function prestigeAxisWeight(): number {
  const n = Number(process.env.PRESTIGE_AXIS_WEIGHT);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Cosine similarity of two topic_id→weight vectors. 0 when either is empty/disjoint. */
export function topicAffinity(vs: Map<string, number>, vo: Map<string, number>): number {
  let dot = 0;
  let ns = 0;
  let no = 0;
  for (const w of vs.values()) ns += w * w;
  for (const [t, w] of vo) {
    no += w * w;
    const sw = vs.get(t);
    if (sw) dot += sw * w;
  }
  if (ns === 0 || no === 0) return 0;
  return dot / (Math.sqrt(ns) * Math.sqrt(no));
}

/** Jaccard overlap of two MeSH-UI sets. 0 when either is empty. */
export function meshOverlap(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Deadline proximity ∈ 0..1: past → 0; imminent (≤30d) → 1; decays toward 0.1 by
 * ~395 days out; continuous/rolling (null) → a steady 0.5 baseline.
 */
export function deadlineProximity(dueDate: Date | null, now: Date): number {
  if (dueDate === null) return 0.5;
  const days = (dueDate.getTime() - now.getTime()) / MS_PER_DAY;
  if (days < 0) return 0;
  if (days <= 30) return 1;
  return Math.max(0.1, 1 - (days - 30) / 365);
}

/** The default composite — stage MULTIPLIES topic so high-appeal-but-off-topic can't float up. */
export function combineScore(axes: MatchAxes, weights: MatchWeights = DEFAULT_WEIGHTS): number {
  return (
    weights.topic * axes.topicAffinity +
    weights.stage * axes.stageAppeal * axes.topicAffinity +
    weights.mesh * axes.meshOverlap +
    weights.deadline * axes.deadlineProximity +
    weights.prestige * axes.prestige * axes.topicAffinity
  );
}

// ── Ranking core (pure) ────────────────────────────────────────────────────

export type OpportunityCandidate = {
  opportunityId: string;
  title: string;
  sponsor: string;
  dueDate: Date | null;
  status: string;
  topicVector: OpportunityTopicScore[];
  appealByStage: Partial<Record<CareerStage, number>>;
  meshDescriptorUi: string[];
  /** At-a-glance card facts (Phase 3). Optional on the candidate so pure-unit
   *  fixtures need not supply them; null-safe on the ranked result below. */
  mechanism?: string | null;
  awardCeiling?: number | null;
  prestige?: Prestige | null;
};

export type RankedOpportunity = {
  opportunityId: string;
  title: string;
  sponsor: string;
  dueDate: Date | null;
  status: string;
  axes: MatchAxes;
  defaultScore: number;
  /** Phase 3 — surfaced inline on the "Grants for me" card header for
   *  actionability (the funding mechanism + award ceiling). `null` when absent. */
  mechanism: string | null;
  awardCeiling: number | null;
  prestige: Prestige | null;
};

export type RankSort = "fit" | "deadline" | "stage" | "prestige";

export type RankOptions = {
  now?: Date;
  sort?: RankSort;
  weights?: MatchWeights;
  /** Drop candidates whose topicAffinity is ≤ this (relevance floor). */
  topicFloor?: number;
  limit?: number;
};

function toVectorMap(v: OpportunityTopicScore[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of v) {
    if (t && typeof t.topic_id === "string" && typeof t.score === "number") m.set(t.topic_id, t.score);
  }
  return m;
}

const SORT_KEY: Record<RankSort, (a: MatchAxes) => number> = {
  fit: () => NaN, // handled by defaultScore
  deadline: (a) => a.deadlineProximity,
  stage: (a) => a.stageAppeal,
  prestige: (a) => a.prestige,
};

/**
 * Pure: score + rank candidate opportunities for one scholar. Each result keeps
 * its DISTINCT axes; `sort` and `weights` only change ordering / the default
 * blend — never the axes themselves.
 */
export function rankCandidates(
  scholarVector: Map<string, number>,
  scholarStage: CareerStage,
  scholarMeshUi: string[],
  candidates: OpportunityCandidate[],
  opts: RankOptions = {},
): RankedOpportunity[] {
  const now = opts.now ?? new Date();
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const floor = opts.topicFloor ?? 0;
  const sort = opts.sort ?? "fit";

  const scored: RankedOpportunity[] = [];
  for (const c of candidates) {
    const axes: MatchAxes = {
      topicAffinity: topicAffinity(scholarVector, toVectorMap(c.topicVector)),
      stageAppeal: c.appealByStage[scholarStage] ?? 0,
      meshOverlap: meshOverlap(scholarMeshUi, c.meshDescriptorUi),
      deadlineProximity: deadlineProximity(c.dueDate, now),
      prestige: c.prestige?.score ?? 0,
    };
    if (axes.topicAffinity <= floor) continue;
    scored.push({
      opportunityId: c.opportunityId,
      title: c.title,
      sponsor: c.sponsor,
      dueDate: c.dueDate,
      status: c.status,
      axes,
      defaultScore: combineScore(axes, weights),
      mechanism: c.mechanism ?? null,
      awardCeiling: c.awardCeiling ?? null,
      prestige: c.prestige ?? null,
    });
  }

  scored.sort((a, b) =>
    sort === "fit" ? b.defaultScore - a.defaultScore : SORT_KEY[sort](b.axes) - SORT_KEY[sort](a.axes),
  );
  return typeof opts.limit === "number" ? scored.slice(0, opts.limit) : scored;
}

// ── I/O wrappers (integration-gated; need MySQL + OpenSearch) ───────────────

// Scholar topic-vector weighting (accuracy levers §2.1/§2.4,
// docs/funding-matcher-accuracy.md). First/last author = the scholar's OWN research
// footprint (full weight); a middle-author cameo is a weaker signal of their
// direction, so it is down-weighted rather than dropped — the reverse matcher
// hard-gates to first/last, but weighting keeps a mostly-middle (big-lab,
// early-career) author mappable. Recency decay (half-life below) replaces the hard
// year cliff so a scholar's CURRENT focus drives matches, not equal-weighted history.
// ponytail: fixed weights + half-life; learn them from the QA-tab feedback set
// (§2.7) once labels exist. Next lever = IDF down-weighting of ubiquitous topics
// (§2.1), deferred — it needs a cached corpus document-frequency map, not a
// per-request full-table scan.
const TOPIC_RECENCY_HALF_LIFE_YEARS = 5;
const AUTHOR_POSITION_WEIGHT: Record<string, number> = { first: 1, last: 1, penultimate: 0.5 };
const MIDDLE_AUTHOR_WEIGHT = 0.25;

/** Per-(topic, year, author-position) contribution to the scholar topic vector:
 *  the base reciterAI impact score scaled by recency decay + authorship. Pure. */
export function scholarTopicRowWeight(
  baseScore: number,
  pubYear: number,
  authorPosition: string | null,
  nowYear: number,
): number {
  if (!(baseScore > 0)) return 0;
  const recency = Math.pow(0.5, Math.max(0, nowYear - pubYear) / TOPIC_RECENCY_HALF_LIFE_YEARS);
  const author = AUTHOR_POSITION_WEIGHT[authorPosition ?? ""] ?? MIDDLE_AUTHOR_WEIGHT;
  return baseScore * recency * author;
}

/** Aggregate a scholar's L2-normalized topic vector on demand from publication_topic,
 *  weighting each contribution by recency + authorship (see `scholarTopicRowWeight`). */
export async function scholarTopicVector(
  cwid: string,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  // Group by topic × year × author position so each bucket carries the year +
  // position needed to weight it before the per-topic sum.
  const rows = await db.read.publicationTopic.groupBy({
    by: ["parentTopicId", "year", "authorPosition"],
    where: { cwid, year: { gte: RECITERAI_YEAR_FLOOR }, scholar: { deletedAt: null, status: "active" } },
    _sum: { score: true },
  });
  const nowYear = now.getFullYear();
  const raw = new Map<string, number>();
  for (const r of rows) {
    const w = scholarTopicRowWeight(Number(r._sum.score ?? 0), r.year ?? nowYear, r.authorPosition, nowYear);
    if (w > 0) raw.set(r.parentTopicId, (raw.get(r.parentTopicId) ?? 0) + w);
  }
  let norm = 0;
  for (const v of raw.values()) norm += v * v;
  if (norm === 0) return raw;
  const inv = 1 / Math.sqrt(norm);
  for (const [k, v] of raw) raw.set(k, v * inv);
  return raw;
}

/** roleCategory + appointment/education dates → the scholar's 5-bucket career stage. */
export async function scholarCareerStage(cwid: string, now: Date = new Date()): Promise<CareerStage> {
  const s = await db.read.scholar.findUnique({
    where: { cwid },
    select: {
      roleCategory: true,
      appointments: { select: { startDate: true } },
      educations: { select: { year: true } },
    },
  });
  if (!s) return "mid";
  return careerStageBucket(
    { roleCategory: s.roleCategory, appointments: s.appointments, educations: s.educations },
    now,
  );
}

/** Map a career stage to the hard eligibility flag a candidate must carry. */
function requiredEligibilityFlag(stage: CareerStage): string {
  return stage === "grad" || stage === "postdoc" ? "postdoc_eligible" : "faculty_eligible";
}

export type MatchOptions = RankOptions & { candidatePoolSize?: number };

/**
 * Full forward match for a scholar: aggregate vector + stage, retrieve candidates
 * from OpenSearch under hard filters, re-rank over the distinct axes.
 * NOTE: integration-gated — exercised against a live MySQL + OpenSearch; the pure
 * `rankCandidates`/axis functions above carry the unit coverage.
 */
export async function matchOpportunitiesForScholar(
  cwid: string,
  opts: MatchOptions = {},
): Promise<RankedOpportunity[]> {
  const now = opts.now ?? new Date();
  const [vector, stage] = await Promise.all([scholarTopicVector(cwid, now), scholarCareerStage(cwid, now)]);

  // Scholar MeSH fingerprint (people index) — best-effort secondary axis.
  let scholarMeshUi: string[] = [];
  const client = searchClient();
  try {
    const people = await client.search({
      index: "scholars-people",
      body: { size: 1, _source: ["publicationMeshUi"], query: { term: { cwid } } } as object,
    });
    const pbody = people.body as unknown as { hits: { hits: Array<{ _source?: { publicationMeshUi?: string[] } }> } };
    const hit = pbody.hits.hits[0]?._source ?? {};
    scholarMeshUi = Array.isArray(hit.publicationMeshUi) ? hit.publicationMeshUi : [];
  } catch {
    scholarMeshUi = [];
  }

  // Stage 1 — candidate retrieval under hard filters + coarse topic relevance.
  const topTopics = [...vector.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const nowIso = now.toISOString();
  const filters: unknown[] = [
    { terms: { status: ["open", "forecasted", "continuous"] } },
    {
      bool: {
        should: [
          { range: { dueDate: { gte: nowIso } } },
          { term: { status: "continuous" } },
          { bool: { must_not: { exists: { field: "dueDate" } } } },
        ],
        minimum_should_match: 1,
      },
    },
    { term: { eligibilityFlags: "us_eligible" } },
    { term: { eligibilityFlags: requiredEligibilityFlag(stage) } },
    // Honorific gate (GRANT# contract v2): never recommend nomination-based prizes
    // as "grants for you" — they're not applyable. `is_honorific` is the upstream
    // data flag (supersedes the #1296 title heuristic). Absent/false ⇒ kept; only
    // an explicit `true` is excluded. No-op until items are reprojected with the flag.
    { bool: { must_not: { term: { isHonorific: true } } } },
  ];
  if (stage !== "grad") filters.push({ bool: { must_not: { term: { eligibilityFlags: "student_only" } } } });

  const should = topTopics.map(([topic_id, w]) => ({ term: { topicIds: { value: topic_id, boost: w } } }));

  const resp = await client.search({
    index: OPPORTUNITIES_INDEX,
    body: {
      size: opts.candidatePoolSize ?? 200,
      query: { bool: { filter: filters, should, minimum_should_match: should.length ? 1 : 0 } },
    } as object,
  });

  const rbody = resp.body as unknown as { hits: { hits: Array<{ _source?: Record<string, unknown> }> } };
  const candidates: OpportunityCandidate[] = (rbody.hits.hits ?? []).map((h) => {
    const src = h._source ?? {};
    return {
      opportunityId: String(src.opportunityId ?? ""),
      title: String(src.title ?? ""),
      sponsor: String(src.sponsor ?? ""),
      dueDate: src.dueDate ? new Date(String(src.dueDate)) : null,
      status: String(src.status ?? ""),
      topicVector: (Array.isArray(src.topicVector) ? src.topicVector : []) as OpportunityTopicScore[],
      appealByStage: (src.appealByStage ?? {}) as Partial<Record<CareerStage, number>>,
      meshDescriptorUi: Array.isArray(src.meshDescriptorUi) ? (src.meshDescriptorUi as string[]) : [],
      mechanism: src.mechanism != null ? String(src.mechanism) : null,
      awardCeiling: typeof src.awardCeiling === "number" ? src.awardCeiling : null,
      prestige: asPrestige(src.prestige),
    };
  });

  // Stage 2 — composite re-rank over the distinct axes. Inject the env-driven
  // prestige weight only when the caller did not supply explicit weights, so
  // DEFAULT_WEIGHTS (prestige: 0) keeps pure unit tests deterministic.
  return rankCandidates(
    vector,
    stage,
    scholarMeshUi,
    candidates,
    opts.weights ? opts : { ...opts, weights: { ...DEFAULT_WEIGHTS, prestige: prestigeAxisWeight() } },
  );
}
