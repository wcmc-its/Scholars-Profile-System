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
import { careerStageBucket, type CareerStage } from "@/lib/career-stage";
import { db } from "@/lib/db";
import { TOP_SCHOLARS_ELIGIBLE_ROLES } from "@/lib/eligibility";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";
import { scorePublication, type RankablePublication } from "@/lib/ranking";
import { OPPORTUNITY_TOPIC_GATE, type OpportunityTopicScore } from "@/lib/search";

const RECITERAI_YEAR_FLOOR = 2020; // D-15; mirrors lib/api/topics.ts.

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
};

export type ResearcherSort = "fit" | "stage";

export type RankResearchersOptions = {
  /** The opportunity's appeal-by-stage map (for the stageAppeal axis / lens). */
  appealByStage?: Partial<Record<CareerStage, number>>;
  /** Career stage per candidate cwid (for the stageAppeal axis / lens). */
  stageByCwid?: Map<string, CareerStage>;
  /** When true, blend stageAppeal into defaultScore ("who would this suit"). Default off. */
  stageLens?: boolean;
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

  ranked.sort((a, b) =>
    (opts.sort ?? "fit") === "stage"
      ? b.axes.stageAppeal - a.axes.stageAppeal
      : b.defaultScore - a.defaultScore,
  );
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
 * Full reverse match: load the opportunity, fan getTopScholarsForTopic-style
 * aggregation across its topics, combine. Integration-gated (MySQL); the pure
 * `rankResearchers` core above carries the unit coverage.
 */
export async function rankResearchersForOpportunity(
  opportunityId: string,
  opts: { stageLens?: boolean; sort?: ResearcherSort; limit?: number; topK?: number; now?: Date } = {},
): Promise<RankedScholar[]> {
  const now = opts.now ?? new Date();
  const opp = await db.read.opportunity.findUnique({
    where: { opportunityId },
    select: { topicVector: true, appealByStage: true },
  });
  if (!opp) return [];

  const topics = opportunityTopTopics(
    (Array.isArray(opp.topicVector) ? opp.topicVector : []) as OpportunityTopicScore[],
    OPPORTUNITY_TOPIC_GATE,
    opts.topK ?? 8,
  );
  if (topics.length === 0) return [];

  // Per-topic: the getTopScholarsForTopic aggregation (first/last author, FT
  // faculty, year≥floor, non-excluded pub types), scored with the Variant-B curve.
  const topicResults: TopicResult[] = await Promise.all(
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

  // Career stage + display metadata per candidate. One query: stage feeds the
  // stageAppeal axis; primaryTitle/primaryDepartment are denormalized on the
  // scholar row (ED primary appointment) and attached post-ranking for the row.
  const cwids = [...new Set(topicResults.flatMap((tr) => tr.scholars.map((s) => s.cwid)))];
  const stageByCwid = new Map<string, CareerStage>();
  const profileByCwid = new Map<string, { title: string | null; department: string | null }>();
  if (cwids.length > 0) {
    const scholars = await db.read.scholar.findMany({
      where: { cwid: { in: cwids } },
      select: {
        cwid: true,
        roleCategory: true,
        primaryTitle: true,
        primaryDepartment: true,
        appointments: { select: { startDate: true } },
        educations: { select: { year: true } },
      },
    });
    for (const s of scholars) {
      stageByCwid.set(
        s.cwid,
        careerStageBucket({ roleCategory: s.roleCategory, appointments: s.appointments, educations: s.educations }, now),
      );
      profileByCwid.set(s.cwid, { title: s.primaryTitle, department: s.primaryDepartment });
    }
  }

  const ranked = rankResearchers(topicResults, {
    appealByStage: (opp.appealByStage ?? {}) as Partial<Record<CareerStage, number>>,
    stageByCwid,
    stageLens: opts.stageLens,
    sort: opts.sort,
    limit: opts.limit,
  });
  for (const r of ranked) {
    const p = profileByCwid.get(r.cwid);
    r.title = p?.title ?? null;
    r.department = p?.department ?? null;
  }
  return ranked;
}
