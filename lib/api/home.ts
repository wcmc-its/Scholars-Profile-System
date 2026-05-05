/**
 * Home-page data assembly. Reads scholars, publications, and topic taxonomy and
 * computes Variant B rankings from `lib/ranking.ts`.
 *
 * Three surfaces, three exported functions:
 *   - getRecentContributions(): RecentContribution[] | null   (RANKING-01)
 *   - getSelectedResearch():    SubtopicCard[]      | null    (HOME-02)
 *   - getBrowseAllResearchAreas(): ParentTopic[]              (HOME-03; never null)
 *
 * Sparse-state hide returns null + emits a structured log line per
 * 02-CONTEXT.md D-12. Log lines never include scholar names or CWIDs (privacy
 * boundary; see threat T-02-07-01).
 *
 * Schema shape: candidate (e) per 02-SCHEMA-DECISION.md.
 *   - `topic` table contains 67 rows — ALL parents (no parentId column).
 *   - `publication_topic` holds (pmid, cwid, parent_topic_id) triples with
 *     subtopic data embedded (`primary_subtopic_id`, `subtopic_ids`).
 *   - Subtopics are NOT first-class entities; subtopic display labels are
 *     slug-derived (titlecase + replace underscores).
 *   - publication_topic.pmid FK-relates to publication.pmid (both VARCHAR(32))
 *     so card-rendering joins use Prisma `include: { publication }` directly.
 */

import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  scorePublication,
  type RankablePublication,
} from "@/lib/ranking";
import { ELIGIBLE_ROLES } from "@/lib/eligibility";

// ---------------------------------------------------------------------------
// Per-surface floors per UI-SPEC §States and CONTEXT.md D-12
// ---------------------------------------------------------------------------
const RECENT_CONTRIBUTIONS_TARGET = 6;
const RECENT_CONTRIBUTIONS_FLOOR = 3;
const SELECTED_RESEARCH_TARGET = 8;
const SELECTED_RESEARCH_FLOOR = 4;

// Hard-excluded publication types (locked by design spec v1.7.1).
const EXCLUDED_PUB_TYPES = ["Letter", "Editorial Article", "Erratum"] as const;

// ReCiterAI scoring data floor (D-15) — publication_score / publication_topic
// rows only cover 2020+ publications.
const RECITERAI_YEAR_FLOOR = 2020;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecentContribution = {
  cwid: string;
  slug: string;
  preferredName: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  authorshipRole: "first author" | "senior author";
  paper: {
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    pubmedUrl: string | null;
    doi: string | null;
  };
  // NO citation-count field — locked by design spec v1.7.1
};

export type SubtopicCard = {
  parentTopicSlug: string;
  parentTopicName: string;
  subtopicSlug: string;
  subtopicName: string;
  scholarCount: number;
  publicationCount: number;
  publications: Array<{
    pmid: string;
    title: string;
    journal: string | null;
    year: number | null;
    firstWcmAuthor: { cwid: string; slug: string; preferredName: string } | null;
  }>;
};

export type HomeStats = {
  scholarCount: number;
  publicationCount: number;
  researchAreaCount: number;
};

export type ParentTopic = {
  slug: string;
  name: string;
  scholarCount: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logSparseHide(
  surface: string,
  qualifying: number,
  floor: number,
  context: Record<string, unknown> = {},
): void {
  // Construction guarantee: only `surface`, `qualifying`, `floor`, and a
  // caller-controlled context object. Implementations never pass scholar
  // identifiers — verified by Threat T-02-07-01 mitigation.
  console.warn(
    JSON.stringify({
      event: "sparse_state_hide",
      surface,
      qualifying,
      floor,
      ...context,
    }),
  );
}

/**
 * Subtopics are NOT first-class entities under candidate (e). DDB has no
 * human-readable label or description for them; the slug IS the canonical
 * identifier. Render a friendly name via titlecase + underscore replacement.
 */
function subtopicLabelFromSlug(slug: string): string {
  return slug
    .split("_")
    .map((s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join(" ");
}

// ---------------------------------------------------------------------------
// getRecentContributions — RANKING-01
// ---------------------------------------------------------------------------

/**
 * 6 cards max, scholar-centric, eligibility carve, parent-dedup, hide if <3.
 *
 * Pulls eligible-role first-or-senior author rows from `publication_topic`
 * (candidate (e)). Variant B ranking applied app-side via lib/ranking.ts;
 * dedup keeps the highest-scoring row per parent topic. Publication metadata
 * is included via the `publication` FK relation; hard-excluded pub types are
 * filtered in the same WHERE clause.
 */
export async function getRecentContributions(
  now: Date = new Date(),
): Promise<RecentContribution[] | null> {
  const rows = await prisma.publicationTopic.findMany({
    where: {
      authorPosition: { in: ["first", "last"] },
      year: { gte: RECITERAI_YEAR_FLOOR },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: { in: [...ELIGIBLE_ROLES] },
      },
      publication: { publicationType: { notIn: [...EXCLUDED_PUB_TYPES] } },
    },
    include: {
      scholar: {
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          primaryTitle: true,
          roleCategory: true,
        },
      },
      topic: { select: { id: true, label: true } },
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          publicationType: true,
          dateAddedToEntrez: true,
          pubmedUrl: true,
          doi: true,
        },
      },
    },
    take: 200, // bounded pull; further sort+filter in JS
  });

  if (rows.length === 0) {
    logSparseHide("home_recent_contributions", 0, RECENT_CONTRIBUTIONS_FLOOR);
    return null;
  }

  type Row = (typeof rows)[number];

  const scored = rows
    .map((r: Row) => {
      const pub = r.publication;
      const isFirst = r.authorPosition === "first";
      const isLast = r.authorPosition === "last";
      const rankable: RankablePublication = {
        pmid: pub.pmid,
        publicationType: pub.publicationType,
        // publication_topic.score IS the per-publication-per-scholar
        // ReCiterAI score under candidate (e). Decimal -> number coercion.
        reciteraiImpact: Number(r.score),
        dateAddedToEntrez: pub.dateAddedToEntrez,
        authorship: {
          isFirst,
          isLast,
          isPenultimate: r.authorPosition === "penultimate",
        },
        isConfirmed: true, // publication_topic rows are confirmed by definition
      };
      const score = scorePublication(rankable, "recent_contributions", true, now);
      return { row: r, pub, score, parentId: r.parentTopicId, isFirst, isLast };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedup one card per parent research area (one card per parent_topic_id).
  const seenParents = new Set<string>();
  const top: typeof scored = [];
  for (const s of scored) {
    if (seenParents.has(s.parentId)) continue;
    seenParents.add(s.parentId);
    top.push(s);
    if (top.length >= RECENT_CONTRIBUTIONS_TARGET) break;
  }

  if (top.length < RECENT_CONTRIBUTIONS_FLOOR) {
    logSparseHide("home_recent_contributions", top.length, RECENT_CONTRIBUTIONS_FLOOR);
    return null;
  }

  return top.map(({ row, pub, isLast }) => {
    const scholar = row.scholar!;
    return {
      cwid: scholar.cwid,
      slug: scholar.slug,
      preferredName: scholar.preferredName,
      primaryTitle: scholar.primaryTitle,
      identityImageEndpoint: identityImageEndpoint(scholar.cwid),
      authorshipRole: isLast ? "senior author" : "first author",
      paper: {
        pmid: pub.pmid,
        title: pub.title,
        journal: pub.journal,
        year: pub.year,
        pubmedUrl: pub.pubmedUrl ?? null,
        doi: pub.doi ?? null,
      },
    } satisfies RecentContribution;
  });
}

// ---------------------------------------------------------------------------
// getSelectedResearch — HOME-02
// ---------------------------------------------------------------------------

/**
 * 8 subtopic cards max, one per parent, hide if <4.
 *
 * Aggregation under candidate (e): groupBy `(parentTopicId, primarySubtopicId)`
 * with `_sum: { score }` and `_count: { _all }`, filter rows with non-null
 * subtopic, sort by aggregate score, dedup per parent, slice to top 8.
 *
 * Subtopic display labels are slug-derived (DDB has no human label for
 * subtopics — locked finding from probe).
 */
export async function getSelectedResearch(
  _now: Date = new Date(),
): Promise<SubtopicCard[] | null> {
  void _now;
  // Aggregate publication score per (parent, subtopic). Restrict to D-15 floor
  // and drop rows with null primary_subtopic_id. We do NOT join publication
  // here (no FK; would require IN clauses). Hard-excluded pub types are
  // filtered out at the publication-stitch step below.
  const groups = await prisma.publicationTopic.groupBy({
    by: ["parentTopicId", "primarySubtopicId"],
    where: {
      primarySubtopicId: { not: null },
      year: { gte: RECITERAI_YEAR_FLOOR },
    },
    _sum: { score: true },
    _count: { _all: true },
  });

  type Group = {
    parentTopicId: string;
    primarySubtopicId: string | null;
    _sum: { score: number | string | null };
    _count: { _all: number };
  };

  // Sort groups by aggregate score desc.
  const sorted = (groups as unknown as Group[])
    .filter((g) => g.primarySubtopicId !== null)
    .map((g) => ({
      parentTopicId: g.parentTopicId,
      primarySubtopicId: g.primarySubtopicId as string,
      score: Number(g._sum.score ?? 0),
      publicationCount: g._count._all,
    }))
    .filter((g) => g.score > 0)
    .sort((a, b) => b.score - a.score);

  // Dedup so each parent appears at most once.
  const seenParents = new Set<string>();
  const top: typeof sorted = [];
  for (const g of sorted) {
    if (seenParents.has(g.parentTopicId)) continue;
    seenParents.add(g.parentTopicId);
    top.push(g);
    if (top.length >= SELECTED_RESEARCH_TARGET) break;
  }

  if (top.length < SELECTED_RESEARCH_FLOOR) {
    logSparseHide("home_selected_research", top.length, SELECTED_RESEARCH_FLOOR);
    return null;
  }

  // Resolve parent labels.
  const parentIds = top.map((t) => t.parentTopicId);
  const parents =
    parentIds.length > 0
      ? await prisma.topic.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, label: true },
        })
      : [];
  const parentLabelById = new Map(parents.map((p) => [p.id, p.label]));

  // Resolve scholar count per (parent, subtopic) — distinct cwids. Prisma
  // groupBy can't express COUNT(DISTINCT cwid), so use raw SQL.
  type ScholarCountRow = {
    parent_topic_id: string;
    primary_subtopic_id: string;
    scholar_count: number | bigint;
  };
  const scholarCountRows: ScholarCountRow[] =
    parentIds.length > 0
      ? ((await prisma.$queryRawUnsafe(
          `SELECT pt.parent_topic_id, pt.primary_subtopic_id, COUNT(DISTINCT pt.cwid) AS scholar_count
             FROM publication_topic pt
             JOIN scholar s ON s.cwid = pt.cwid
            WHERE pt.primary_subtopic_id IS NOT NULL
              AND pt.year >= ?
              AND pt.parent_topic_id IN (${parentIds.map(() => "?").join(",")})
              AND s.deleted_at IS NULL
              AND s.status = 'active'
            GROUP BY pt.parent_topic_id, pt.primary_subtopic_id`,
          RECITERAI_YEAR_FLOOR,
          ...parentIds,
        )) as ScholarCountRow[]) ?? []
      : [];
  const scholarCountKey = (parent: string, subtopic: string) => `${parent}::${subtopic}`;
  const scholarCountByPair = new Map<string, number>(
    scholarCountRows.map((r) => [
      scholarCountKey(r.parent_topic_id, r.primary_subtopic_id),
      Number(r.scholar_count),
    ]),
  );

  // Fetch sample publication_topic rows for each (parent, subtopic) pair so
  // the card can show two example publications. Then stitch publication
  // metadata in a second batched query.
  const sampleRows = await prisma.publicationTopic.findMany({
    where: {
      OR: top.map((t) => ({
        parentTopicId: t.parentTopicId,
        primarySubtopicId: t.primarySubtopicId,
      })),
      year: { gte: RECITERAI_YEAR_FLOOR },
      publication: { publicationType: { notIn: [...EXCLUDED_PUB_TYPES] } },
    },
    include: {
      scholar: { select: { cwid: true, slug: true, preferredName: true } },
      publication: { select: { pmid: true, title: true, journal: true, year: true } },
    },
    orderBy: [{ score: "desc" }],
    take: top.length * 8, // generous; we'll bucket and slice 2 per pair
  });

  type SampleRow = (typeof sampleRows)[number];
  const sampleByPair = new Map<string, Array<{ row: SampleRow; pubTitle: string; pubPmid: string; pubJournal: string | null; pubYear: number | null }>>();
  for (const s of sampleRows) {
    const key = scholarCountKey(s.parentTopicId, s.primarySubtopicId ?? "");
    const arr = sampleByPair.get(key) ?? [];
    if (arr.length < 2) {
      arr.push({ row: s, pubTitle: s.publication.title, pubPmid: s.publication.pmid, pubJournal: s.publication.journal, pubYear: s.publication.year });
      sampleByPair.set(key, arr);
    }
  }

  return top.map((t) => {
    const key = scholarCountKey(t.parentTopicId, t.primarySubtopicId);
    const samples = sampleByPair.get(key) ?? [];
    return {
      parentTopicSlug: t.parentTopicId,
      parentTopicName: parentLabelById.get(t.parentTopicId) ?? t.parentTopicId,
      subtopicSlug: t.primarySubtopicId,
      subtopicName: subtopicLabelFromSlug(t.primarySubtopicId),
      scholarCount: scholarCountByPair.get(key) ?? 0,
      publicationCount: t.publicationCount,
      publications: samples.map((s) => ({
        pmid: s.pubPmid,
        title: s.pubTitle,
        journal: s.pubJournal,
        year: s.pubYear,
        firstWcmAuthor: s.row.scholar
          ? {
              cwid: s.row.scholar.cwid,
              slug: s.row.scholar.slug,
              preferredName: s.row.scholar.preferredName,
            }
          : null,
      })),
    } satisfies SubtopicCard;
  });
}

// ---------------------------------------------------------------------------
// getBrowseAllResearchAreas — HOME-03
// ---------------------------------------------------------------------------

/**
 * All 67 parents with active-scholar counts (D-03). Never hidden — Browse
 * grid always renders all 67 parents. If <67 rows exist, that's a data-layer
 * bug, not a sparse-state condition (D-12). Returns [] in that case (UI
 * renders the "Research areas temporarily unavailable" error state).
 *
 * Under candidate (e) every Topic row IS a parent — no `parentId IS NULL`
 * filter needed. Active-scholar count is computed on demand via raw SQL
 * (Prisma groupBy can't express COUNT(DISTINCT cwid)).
 */
export async function getBrowseAllResearchAreas(): Promise<ParentTopic[]> {
  const topics = await prisma.topic.findMany({
    select: { id: true, label: true },
    orderBy: { label: "asc" },
  });

  if (topics.length === 0) {
    return [];
  }

  // Distinct active-scholar count per parent — D-03 says "no eligibility
  // filter", so any scholar-attributed publication contributes.
  type CountRow = {
    parent_topic_id: string;
    scholar_count: number | bigint;
  };
  const countRows = ((await prisma.$queryRawUnsafe(
    `SELECT pt.parent_topic_id, COUNT(DISTINCT pt.cwid) AS scholar_count
       FROM publication_topic pt
       JOIN scholar s ON s.cwid = pt.cwid
      WHERE s.deleted_at IS NULL AND s.status = 'active'
      GROUP BY pt.parent_topic_id`,
  )) as CountRow[]) ?? [];
  const countByParent = new Map<string, number>(
    countRows.map((r) => [r.parent_topic_id, Number(r.scholar_count)]),
  );

  return topics.map((t) => ({
    slug: t.id,
    name: t.label,
    scholarCount: countByParent.get(t.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// getHomeStats — hero stats strip
// ---------------------------------------------------------------------------

export async function getHomeStats(): Promise<HomeStats> {
  const [scholarCount, publicationCount, researchAreaCount] = await Promise.all([
    prisma.scholar.count({ where: { deletedAt: null, status: "active" } }),
    prisma.publication.count(),
    prisma.topic.count(),
  ]);
  return { scholarCount, publicationCount, researchAreaCount };
}
