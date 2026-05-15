/**
 * Spotlight surface — unified data layer for the §16 Spotlight section.
 *
 * Single shape (`SpotlightCard`) consumed by `<Spotlight>` across topic +
 * department pages (slices 2 + 3 add center + division by reusing this).
 *
 * Selection (same criterion intended by the prior Recent Highlights surface):
 *   - publication.impact_score >= 40         (impact floor; range ~9-83)
 *   - author_position IN ('first','last')
 *   - scholar.role_category = 'full_time_faculty', active, not deleted
 *   - publication.publication_type = 'Academic Article'
 *   - year >= 2020 (D-15 ReCiterAI scoring data floor)
 * Order: dateAddedToEntrez DESC, year DESC, impactScore DESC.
 *
 * Impact source: `Publication.impactScore` (canonical column from the IMPACT#
 * DynamoDB ETL, issue #316 PR-A). Before #316 PR-B-finalize this was read
 * through the `publication_topic.impact_score` mirror; that column has been
 * dropped and is no longer queried.
 *
 * Note: the legacy code in `lib/api/topics.ts:getRecentHighlightsForTopic`
 * filtered on `score` (the 0-1 relevance value) instead of `impact_score`
 * — a long-standing bug that caused the surface to silently render zero
 * cards. The variable name `RECENT_HIGHLIGHTS_IMPACT_FLOOR = 40` makes
 * the intent unambiguous; we apply it to `publication.impact_score` here.
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
  /** Issue #68 — author position on this paper for the entity scholar.
   *  null for tier-1 (first/last) rows where position isn't decisive;
   *  populated for tier-2 (middle-author) rows so the per-tier sort can
   *  break ties on "earlier author = stronger contribution". */
  position: number | null;
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

/**
 * Issue #68 — middle-author top-up for sparse entities (Library is the
 * canonical case). Tier-2 sort is impact-led with author-position as a
 * tiebreaker (earlier = better), so a 2nd-of-7 middle author outranks a
 * 5th-of-7 on the same paper.
 */
function sortTier2(rows: CandidateRow[]): CandidateRow[] {
  return [...rows].sort((a, b) => {
    if (b.impactScore !== a.impactScore) return b.impactScore - a.impactScore;
    const ap = a.position ?? Number.POSITIVE_INFINITY;
    const bp = b.position ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    const ay = a.publication.year ?? 0;
    const by = b.publication.year ?? 0;
    if (by !== ay) return by - ay;
    const at = a.publication.dateAddedToEntrez?.getTime() ?? 0;
    const bt = b.publication.dateAddedToEntrez?.getTime() ?? 0;
    return bt - at;
  });
}

const PUB_SELECT_FIELDS = {
  pmid: true,
  title: true,
  journal: true,
  year: true,
  pubmedUrl: true,
  doi: true,
  dateAddedToEntrez: true,
} as const;

/**
 * Run the tier-2 (middle-author) fill for a scholar-scoped entity. Returns
 * up to `need` extra candidates already deduped against `seenPmids` and
 * sorted by the tier-2 rule. Each candidate carries the publication-level
 * max impactScore (across all publication_topic rows for the pmid) and the
 * parent_topic / primary_subtopic from the highest-impact topic row, so the
 * caller can resolve the kicker via the same lookup table as tier 1.
 *
 * Implementation: two queries + a JS merge. We can't reuse publicationTopic
 * for the author query because middle-author rows aren't materialized
 * there; we go through publicationAuthor for position + scholar filtering,
 * then re-attach impact + topic via a separate publicationTopic group.
 */
async function fillTier2(
  scholarFilter: object,
  seenPmids: Set<string>,
  need: number,
  /** When set, restrict to publications tagged to this parent topic — used
   *  by `getSpotlightCardsForTopic`. The dept/division/center callers leave
   *  this null because their scoping comes from `scholarFilter` alone. */
  topicSlug: string | null = null,
): Promise<CandidateRow[]> {
  if (need <= 0) return [];
  const authorRows = await prisma.publicationAuthor.findMany({
    where: {
      isFirst: false,
      isLast: false,
      position: { gt: 0 },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: "full_time_faculty",
        ...scholarFilter,
      },
      publication: {
        publicationType: "Academic Article",
        year: { gte: RECITERAI_YEAR_FLOOR },
        ...(seenPmids.size > 0 ? { pmid: { notIn: Array.from(seenPmids) } } : {}),
        ...(topicSlug
          ? {
              // Tagged to this parent topic via at least one publication_topic
              // row. The author of that row may be a different scholar than
              // the middle-author we surface — that's fine; topic membership
              // is a pmid-level fact regardless of which scholar's authorship
              // entered it into the projection.
              publicationTopics: { some: { parentTopicId: topicSlug } },
            }
          : {}),
      },
    },
    select: {
      pmid: true,
      cwid: true,
      position: true,
      publication: { select: PUB_SELECT_FIELDS },
    },
  });
  if (authorRows.length === 0) return [];

  // Pick the strongest entity-scholar row per pmid: lowest position wins.
  const bestAuthorRowByPmid = new Map<string, (typeof authorRows)[number]>();
  for (const r of authorRows) {
    const cur = bestAuthorRowByPmid.get(r.pmid);
    if (!cur || r.position < cur.position) bestAuthorRowByPmid.set(r.pmid, r);
  }

  const pmids = Array.from(bestAuthorRowByPmid.keys());
  const topicRows = await prisma.publicationTopic.findMany({
    where: {
      pmid: { in: pmids },
      publication: { impactScore: { gte: HIGHLIGHTS_IMPACT_FLOOR } },
    },
    select: {
      pmid: true,
      parentTopicId: true,
      primarySubtopicId: true,
      publication: { select: { impactScore: true } },
    },
  });
  type Best = {
    parentTopicId: string;
    primarySubtopicId: string | null;
    impactScore: number;
  };
  const bestTopicByPmid = new Map<string, Best>();
  for (const t of topicRows) {
    // Post-#316 PR-B-finalize: every publication_topic row for a pmid has the
    // same global impact value via the publication relation. The "best topic"
    // pick degenerates to "first topic seen" — keep the loop for clarity even
    // though the MAX collapse is now a no-op.
    const score = Number(t.publication.impactScore);
    const cur = bestTopicByPmid.get(t.pmid);
    if (!cur || score > cur.impactScore) {
      bestTopicByPmid.set(t.pmid, {
        parentTopicId: t.parentTopicId,
        primarySubtopicId: t.primarySubtopicId,
        impactScore: score,
      });
    }
  }

  const candidates: CandidateRow[] = [];
  for (const [pmid, authorRow] of bestAuthorRowByPmid) {
    const topic = bestTopicByPmid.get(pmid);
    if (!topic) continue; // no impact signal — skip per issue acceptance
    candidates.push({
      pmid,
      cwid: authorRow.cwid ?? "",
      parentTopicId: topic.parentTopicId,
      primarySubtopicId: topic.primarySubtopicId,
      impactScore: topic.impactScore,
      position: authorRow.position,
      publication: authorRow.publication,
    });
  }

  return sortTier2(candidates).slice(0, need);
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
      authorPosition: { in: ["first", "last"] },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: "full_time_faculty",
      },
      publication: {
        publicationType: "Academic Article",
        impactScore: { gte: HIGHLIGHTS_IMPACT_FLOOR },
      },
    },
    select: {
      pmid: true,
      cwid: true,
      parentTopicId: true,
      primarySubtopicId: true,
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          pubmedUrl: true,
          doi: true,
          dateAddedToEntrez: true,
          impactScore: true,
        },
      },
    },
  })) as unknown as Array<
    Omit<CandidateRow, "impactScore" | "position"> & {
      publication: { impactScore: unknown } & CandidateRow["publication"];
    }
  >;

  const normalized: CandidateRow[] = rows.map((r) => ({
    ...r,
    impactScore: Number(r.publication.impactScore),
    position: null,
  }));
  let top = sortForSpotlight(dedupeByPmid(normalized)).slice(0, SPOTLIGHT_TARGET);

  // Issue #68 — top up sparse topic surfaces with middle-author publications.
  if (top.length < SPOTLIGHT_TARGET) {
    const seenPmids = new Set(top.map((r) => r.pmid));
    const tier2 = await fillTier2(
      {}, // no scholar carve-out beyond active FT faculty — topic membership
      //  comes from the publication being tagged to this topic.
      seenPmids,
      SPOTLIGHT_TARGET - top.length,
      topicSlug,
    );
    // Tier-2 candidates inherit the topic via publication_topic, so their
    // primarySubtopicId may differ from a strict topic-page kicker. We
    // keep whatever the highest-impact topic row reported; if the parent
    // topic is the topic-page slug itself, the kicker falls back to topic.label.
    top = [...top, ...tier2];
  }

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
      // Issue #61 — subtopic kickers are now linkable on the topic page,
      // mirroring the home-page Spotlight target shape so users land on the
      // subtopic-filtered publication feed. Falls back to a non-link when
      // the card has no primarySubtopicId (kicker = topic.label).
      kickerHref: r.primarySubtopicId
        ? `/topics/${topicSlug}?subtopic=${r.primarySubtopicId}#publications`
        : null,
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
      authorPosition: { in: ["first", "last"] },
      scholar: {
        deletedAt: null,
        status: "active",
        roleCategory: "full_time_faculty",
        ...scholarFilter,
      },
      publication: {
        publicationType: "Academic Article",
        impactScore: { gte: HIGHLIGHTS_IMPACT_FLOOR },
      },
    },
    select: {
      pmid: true,
      cwid: true,
      parentTopicId: true,
      primarySubtopicId: true,
      publication: {
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          pubmedUrl: true,
          doi: true,
          dateAddedToEntrez: true,
          impactScore: true,
        },
      },
    },
  })) as unknown as Array<
    Omit<CandidateRow, "impactScore" | "position"> & {
      publication: { impactScore: unknown } & CandidateRow["publication"];
    }
  >;

  const normalized: CandidateRow[] = rows.map((r) => ({
    ...r,
    impactScore: Number(r.publication.impactScore),
    position: null,
  }));
  let top = sortForSpotlight(dedupeByPmid(normalized)).slice(0, SPOTLIGHT_TARGET);

  // Issue #68 — top up sparse entity Spotlights (Library is the canonical
  // case) with middle-author publications. The tier-2 sort favors high
  // impact, then earlier author position, so a 2nd-of-7 outranks a 5th-of-7.
  if (top.length < SPOTLIGHT_TARGET) {
    const seenPmids = new Set(top.map((r) => r.pmid));
    const tier2 = await fillTier2(
      scholarFilter,
      seenPmids,
      SPOTLIGHT_TARGET - top.length,
    );
    top = [...top, ...tier2];
  }

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
