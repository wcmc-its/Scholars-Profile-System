/**
 * Spotlight surface — unified data layer for the §16 Spotlight section.
 *
 * Single shape (`SpotlightCard`) consumed by `<Spotlight>` across topic +
 * department pages (slices 2 + 3 add center + division by reusing this).
 *
 * Selection (same criterion intended by the prior Recent Highlights surface):
 *   - publication_topic.impact_score >= 40   (impact floor; range ~9-83)
 *   - author_position IN ('first','last')
 *   - scholar.role_category = 'full_time_faculty', active, not deleted
 *   - publication.publication_type = 'Academic Article'
 *   - year >= 2020 (D-15 ReCiterAI scoring data floor)
 * Order: dateAddedToEntrez DESC, year DESC, impactScore DESC.
 *
 * Note: the legacy code in `lib/api/topics.ts:getRecentHighlightsForTopic`
 * filtered on `score` (the 0-1 relevance value) instead of `impact_score`
 * — a long-standing bug that caused the surface to silently render zero
 * cards. The variable name `RECENT_HIGHLIGHTS_IMPACT_FLOOR = 40` makes
 * the intent unambiguous; we apply it to `impact_score` here.
 *
 * Kicker varies by entity:
 *   - Topic page    → subtopic.displayName (drill into the topic)
 *   - Department    → parent topic label   (which research area on this dept)
 */
import { prisma } from "@/lib/db";
import { fetchWcmAuthorsForPmids, type WcmAuthorChip } from "@/lib/api/topics";

const RECITERAI_YEAR_FLOOR = 2020;
const HIGHLIGHTS_IMPACT_FLOOR = 40;
const SPOTLIGHT_TARGET = 3;

export type SpotlightCard = {
  pmid: string;
  kicker: string;
  kickerHref: string | null;
  title: string;
  journal: string | null;
  year: number | null;
  pubmedUrl: string | null;
  doi: string | null;
  authors: WcmAuthorChip[];
};

export type SpotlightData = {
  cards: SpotlightCard[];
  totalCount: number;
  viewAllHref: string;
};

type CandidateRow = {
  pmid: string;
  cwid: string;
  parentTopicId: string;
  primarySubtopicId: string | null;
  impactScore: number;
  publication: {
    pmid: string;
    title: string | null;
    journal: string | null;
    year: number | null;
    pubmedUrl: string | null;
    doi: string | null;
    dateAddedToEntrez: Date | null;
  };
};

/**
 * Dedupe per pmid, keeping the row with the highest impact so the kicker
 * reflects the publication's most-relevant topic for this entity.
 */
function dedupeByPmid(rows: CandidateRow[]): CandidateRow[] {
  const best = new Map<string, CandidateRow>();
  for (const r of rows) {
    const existing = best.get(r.pmid);
    if (!existing || r.impactScore > existing.impactScore) {
      best.set(r.pmid, r);
    }
  }
  return Array.from(best.values());
}

/** Sort: dateAddedToEntrez desc → year desc → impactScore desc. */
function sortForSpotlight(rows: CandidateRow[]): CandidateRow[] {
  return [...rows].sort((a, b) => {
    const at = a.publication.dateAddedToEntrez?.getTime() ?? 0;
    const bt = b.publication.dateAddedToEntrez?.getTime() ?? 0;
    if (bt !== at) return bt - at;
    const ay = a.publication.year ?? 0;
    const by = b.publication.year ?? 0;
    if (by !== ay) return by - ay;
    return b.impactScore - a.impactScore;
  });
}

// ---------------------------------------------------------------------------
// Topic page — kicker = subtopic.displayName
// ---------------------------------------------------------------------------

export async function getSpotlightCardsForTopic(
  topicSlug: string,
): Promise<SpotlightCard[] | null> {
  const topic = await prisma.topic.findUnique({ where: { id: topicSlug } });
  if (!topic) return null;

  const rows = (await prisma.publicationTopic.findMany({
    where: {
      parentTopicId: topicSlug,
      year: { gte: RECITERAI_YEAR_FLOOR },
      impactScore: { gte: HIGHLIGHTS_IMPACT_FLOOR },
      authorPosition: { in: ["first", "last"] },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: "full_time_faculty",
      },
      publication: { publicationType: "Academic Article" },
    },
    select: {
      pmid: true,
      cwid: true,
      parentTopicId: true,
      primarySubtopicId: true,
      impactScore: true,
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          pubmedUrl: true,
          doi: true,
          dateAddedToEntrez: true,
        },
      },
    },
  })) as unknown as Array<Omit<CandidateRow, "impactScore"> & { impactScore: unknown }>;

  const normalized: CandidateRow[] = rows.map((r) => ({
    ...r,
    impactScore: Number(r.impactScore),
  }));
  const top = sortForSpotlight(dedupeByPmid(normalized)).slice(0, SPOTLIGHT_TARGET);
  if (top.length === 0) return null;

  const subtopicIds = Array.from(
    new Set(top.map((r) => r.primarySubtopicId).filter((s): s is string => !!s)),
  );
  const subtopics = subtopicIds.length
    ? await prisma.subtopic.findMany({
        where: { id: { in: subtopicIds } },
        select: { id: true, displayName: true, label: true },
      })
    : [];
  const subtopicById = new Map(subtopics.map((s) => [s.id, s]));

  const authorsByPmid = await fetchWcmAuthorsForPmids(top.map((r) => r.pmid));

  const cards: SpotlightCard[] = top.map((r) => {
    const sub = r.primarySubtopicId ? subtopicById.get(r.primarySubtopicId) : null;
    const kicker = sub?.displayName?.trim() || sub?.label?.trim() || topic.label;
    return {
      pmid: r.pmid,
      kicker,
      kickerHref: null, // subtopic anchors are scoped to the topic page rail; no link target by default
      title: r.publication.title ?? "",
      journal: r.publication.journal,
      year: r.publication.year,
      pubmedUrl: r.publication.pubmedUrl,
      doi: r.publication.doi,
      authors: authorsByPmid.get(r.pmid) ?? [],
    };
  });

  return cards;
}

// ---------------------------------------------------------------------------
// Department / division / center — kicker = parent topic label
// ---------------------------------------------------------------------------

/**
 * Shared backbone for entity-scoped Spotlights (department, division,
 * center). The scoring filters are identical; only the scholar carve-out
 * varies. Returns dedupe + impact-sorted top 3 with parent-topic kicker
 * resolved to a label, or null when zero candidates qualify.
 */
async function getSpotlightCardsForEntity(
  scholarFilter: object,
): Promise<SpotlightCard[] | null> {
  const rows = (await prisma.publicationTopic.findMany({
    where: {
      year: { gte: RECITERAI_YEAR_FLOOR },
      impactScore: { gte: HIGHLIGHTS_IMPACT_FLOOR },
      authorPosition: { in: ["first", "last"] },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: "full_time_faculty",
        ...scholarFilter,
      },
      publication: { publicationType: "Academic Article" },
    },
    select: {
      pmid: true,
      cwid: true,
      parentTopicId: true,
      primarySubtopicId: true,
      impactScore: true,
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          pubmedUrl: true,
          doi: true,
          dateAddedToEntrez: true,
        },
      },
    },
  })) as unknown as Array<Omit<CandidateRow, "impactScore"> & { impactScore: unknown }>;

  const normalized: CandidateRow[] = rows.map((r) => ({
    ...r,
    impactScore: Number(r.impactScore),
  }));
  const top = sortForSpotlight(dedupeByPmid(normalized)).slice(0, SPOTLIGHT_TARGET);
  if (top.length === 0) return null;

  const topicIds = Array.from(new Set(top.map((r) => r.parentTopicId)));
  const topics = await prisma.topic.findMany({
    where: { id: { in: topicIds } },
    select: { id: true, label: true },
  });
  const topicById = new Map(topics.map((t) => [t.id, t]));

  const authorsByPmid = await fetchWcmAuthorsForPmids(top.map((r) => r.pmid));

  const cards: SpotlightCard[] = top.map((r) => {
    const t = topicById.get(r.parentTopicId);
    return {
      pmid: r.pmid,
      kicker: t?.label ?? r.parentTopicId,
      kickerHref: t ? `/topics/${t.id}` : null,
      title: r.publication.title ?? "",
      journal: r.publication.journal,
      year: r.publication.year,
      pubmedUrl: r.publication.pubmedUrl,
      doi: r.publication.doi,
      authors: authorsByPmid.get(r.pmid) ?? [],
    };
  });

  return cards;
}

export function getSpotlightCardsForDepartment(
  deptCode: string,
): Promise<SpotlightCard[] | null> {
  return getSpotlightCardsForEntity({ deptCode });
}

export function getSpotlightCardsForDivision(
  deptCode: string,
  divCode: string,
): Promise<SpotlightCard[] | null> {
  return getSpotlightCardsForEntity({ deptCode, divCode });
}

/**
 * Center scope: pre-resolve CenterMembership cwids and pass them as a
 * `cwid IN (...)` filter. Schema has no Scholar↔CenterMembership relation,
 * so we can't do a nested where. Centers without populated membership
 * return null (the surface omits).
 */
export async function getSpotlightCardsForCenter(
  centerCode: string,
): Promise<SpotlightCard[] | null> {
  const memberRows = await prisma.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true },
  });
  if (memberRows.length === 0) return null;
  const memberCwids = memberRows.map((r) => r.cwid);
  return getSpotlightCardsForEntity({ cwid: { in: memberCwids } });
}
