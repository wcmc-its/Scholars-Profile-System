/**
 * Data layer for <PersonPopover> contextual rows (#242).
 *
 * One server-side function per shape returned by the popover-context API.
 * All lookups are scoped to a single scholar (the popover target); some take
 * an optional context (other scholar, pmid, or topic slug) to light up the
 * surface-specific bottom row.
 *
 * All functions tolerate missing data and return `null`/`0` rather than throw,
 * so a single broken lookup doesn't black-hole the popover render.
 */
import { prisma } from "@/lib/db";
import { withReciterConnection } from "@/lib/sources/reciterdb";

export type PopoverContextHeader = {
  cwid: string;
  preferredName: string;
  postnominal: string | null;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  slug: string | null;
  identityImageEndpoint: string;
  totalPubCount: number;
  totalGrantCount: number;
  topTopic: string | null;
};

export type RecentPub = {
  pmid: string;
  title: string;
  year: number | null;
};

export type CoPubsSummary = {
  count: number;
  mostRecentYear: number | null;
  roleDistribution: {
    first: number;
    senior: number;
    coAuthor: number;
  } | null;
};

export type TopicRankSummary = {
  rank: number;
  topicPubCount: number;
  recent: RecentPub[];
};

/**
 * Header data + total pub/grant counts + scholar's all-time top topic.
 *
 * Filter-aware top-topic (the "most in {topic} within the filtered set" line
 * from the mockup) is *not* computed here — that would require the caller's
 * full filter state. Use this all-time top topic as the default; surfaces that
 * have filter context can override `topTopic` at render time.
 */
export async function fetchPopoverHeader(
  cwid: string,
): Promise<PopoverContextHeader | null> {
  const scholar = await prisma.scholar.findUnique({
    where: { cwid },
    select: {
      cwid: true,
      preferredName: true,
      postnominal: true,
      primaryTitle: true,
      primaryDepartment: true,
      slug: true,
      status: true,
      deletedAt: true,
      _count: {
        select: {
          authorships: true,
          grants: true,
        },
      },
      topicAssignments: {
        orderBy: { score: "desc" },
        take: 1,
        select: { topic: true },
      },
    },
  });
  if (!scholar) return null;
  if (scholar.deletedAt) return null;

  // Resolve the topic slug to its human-readable label so the popover doesn't
  // render the slug verbatim ("melanoma_skin_cancer" → "Melanoma & Skin Cancer").
  let topTopicLabel: string | null = null;
  const topTopicSlug = scholar.topicAssignments[0]?.topic ?? null;
  if (topTopicSlug) {
    const topic = await prisma.topic
      .findUnique({ where: { id: topTopicSlug }, select: { label: true } })
      .catch(() => null);
    topTopicLabel = topic?.label ?? topTopicSlug;
  }

  const { identityImageEndpoint } = await import("@/lib/headshot");
  return {
    cwid: scholar.cwid,
    preferredName: scholar.preferredName,
    postnominal: scholar.postnominal,
    primaryTitle: scholar.primaryTitle,
    primaryDepartment: scholar.primaryDepartment,
    slug: scholar.status === "active" ? scholar.slug : null,
    identityImageEndpoint: identityImageEndpoint(scholar.cwid),
    totalPubCount: scholar._count.authorships,
    totalGrantCount: scholar._count.grants,
    topTopic: topTopicLabel,
  };
}

/**
 * Two most recent confirmed publications for a scholar — used by the
 * pub-chip and (when no co-author context) top-scholar surfaces.
 */
export async function fetchRecentPubs(
  cwid: string,
  limit = 2,
): Promise<RecentPub[]> {
  if (!cwid) return [];
  return await withReciterConnection(async (conn) => {
    type Row = { pmid: number | bigint; title: string | null; year: number | null };
    const rows = (await conn.query(
      `SELECT a.pmid, art.articleTitle AS title, art.articleYear AS year
         FROM analysis_summary_author a
         JOIN analysis_summary_article art ON art.pmid = a.pmid
        WHERE a.personIdentifier = ?
        ORDER BY art.articleYear DESC, a.pmid DESC
        LIMIT ?`,
      [cwid, limit],
    )) as Row[];
    return rows.map((r) => ({
      pmid: String(typeof r.pmid === "bigint" ? Number(r.pmid) : r.pmid),
      title: r.title ?? "",
      year: r.year,
    }));
  }).catch(() => []);
}

/**
 * Recent pubs for a scholar, restricted to those tagged with a given topic.
 * Powers the top-scholar surface's "Recent in this topic" list.
 */
export async function fetchRecentPubsInTopic(
  cwid: string,
  topicId: string,
  limit = 2,
): Promise<RecentPub[]> {
  if (!cwid || !topicId) return [];
  // publication_topic is per-(pmid, cwid, parentTopicId), so it carries both
  // the scholar attribution AND the topic tag in one row — no need to join
  // through publication_author.
  const rows = await prisma.$queryRaw<
    Array<{ pmid: string; title: string | null; year: number | null }>
  >`
    SELECT p.pmid AS pmid, p.title AS title, p.year AS year
      FROM publication_topic pt
      JOIN publication p ON p.pmid = pt.pmid
     WHERE pt.cwid = ${cwid}
       AND pt.parent_topic_id = ${topicId}
     ORDER BY p.year DESC, p.pmid DESC
     LIMIT ${limit}
  `.catch(() => []);
  return rows.map((r) => ({
    pmid: r.pmid,
    title: r.title ?? "",
    year: r.year,
  }));
}

/**
 * Co-publication summary between two scholars: count, most recent year, and
 * authorship-role distribution from the popover target's perspective.
 *
 * Role distribution is computed from the publication-author table — `is_first`
 * / `is_last` for the popover-target cwid across the shared pmids.
 *
 * `targetCwid` is the popover target (e.g. the mentee chip's mentee).
 * `contextCwid` is the surrounding scholar context (e.g. the mentor whose
 * profile we're viewing).
 */
export async function fetchCoPubsSummary(
  targetCwid: string,
  contextCwid: string,
): Promise<CoPubsSummary> {
  if (!targetCwid || !contextCwid || targetCwid === contextCwid) {
    return { count: 0, mostRecentYear: null, roleDistribution: null };
  }
  // Intersection via the local publication_author table — confirmed-only, so
  // co-pub counts match the elsewhere-displayed badges (e.g. mentee chip).
  const rows = await prisma.$queryRaw<
    Array<{ pmid: string; year: number | null; is_first: number; is_last: number }>
  >`
    SELECT p.pmid AS pmid,
           p.year AS year,
           pa1.is_first AS is_first,
           pa1.is_last  AS is_last
      FROM publication_author pa1
      JOIN publication_author pa2 ON pa2.pmid = pa1.pmid
      JOIN publication p ON p.pmid = pa1.pmid
     WHERE pa1.cwid = ${targetCwid}
       AND pa2.cwid = ${contextCwid}
       AND pa1.is_confirmed = 1
       AND pa2.is_confirmed = 1
  `.catch(() => []);
  if (rows.length === 0) {
    return { count: 0, mostRecentYear: null, roleDistribution: null };
  }
  let first = 0;
  let senior = 0;
  let coAuthor = 0;
  let mostRecentYear: number | null = null;
  for (const r of rows) {
    if (r.year !== null && (mostRecentYear === null || r.year > mostRecentYear)) {
      mostRecentYear = r.year;
    }
    if (r.is_first) first += 1;
    else if (r.is_last) senior += 1;
    else coAuthor += 1;
  }
  return {
    count: rows.length,
    mostRecentYear,
    roleDistribution: { first, senior, coAuthor },
  };
}

/**
 * Scholar's rank in a topic by publication count + recent pubs tagged with
 * that topic. Powers the top-scholar surface bottom row.
 */
export async function fetchTopicRank(
  cwid: string,
  topicId: string,
): Promise<TopicRankSummary | null> {
  if (!cwid || !topicId) return null;
  // publication_topic is per-(pmid, cwid, parentTopicId): one row per
  // scholar/pub/topic. Count my rows in the topic, then rank against other
  // scholars in the same topic.
  const myCountRow = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n
      FROM publication_topic
     WHERE cwid = ${cwid}
       AND parent_topic_id = ${topicId}
  `.catch(() => [{ n: BigInt(0) }]);
  const topicPubCount = Number(myCountRow[0]?.n ?? 0);
  if (topicPubCount === 0) return null;

  const rankRow = await prisma.$queryRaw<Array<{ rank: bigint }>>`
    SELECT 1 + COUNT(*) AS rank
      FROM (
        SELECT cwid, COUNT(*) AS n
          FROM publication_topic
         WHERE parent_topic_id = ${topicId}
           AND cwid <> ${cwid}
         GROUP BY cwid
        HAVING n > ${topicPubCount}
      ) AS better
  `.catch(() => [{ rank: BigInt(1) }]);
  const rank = Number(rankRow[0]?.rank ?? 1);

  const recent = await fetchRecentPubsInTopic(cwid, topicId, 2);
  return { rank, topicPubCount, recent };
}

/**
 * Authorship role of a scholar on a specific publication. Powers the role
 * pill on pub-chip / co-author surfaces.
 */
export async function fetchAuthorshipOnPub(
  cwid: string,
  pmid: string,
): Promise<{
  isFirst: boolean;
  isLast: boolean;
  firstCount: number;
  lastCount: number;
} | null> {
  if (!cwid || !pmid) return null;
  const rows = await prisma.$queryRaw<
    Array<{ cwid: string; is_first: number; is_last: number }>
  >`
    SELECT cwid, is_first, is_last
      FROM publication_author
     WHERE pmid = ${pmid}
       AND is_confirmed = 1
  `.catch(() => []);
  if (rows.length === 0) return null;
  const me = rows.find((r) => r.cwid === cwid);
  if (!me) return null;
  let firstCount = 0;
  let lastCount = 0;
  for (const r of rows) {
    if (r.is_first) firstCount += 1;
    if (r.is_last) lastCount += 1;
  }
  return {
    isFirst: !!me.is_first,
    isLast: !!me.is_last,
    firstCount,
    lastCount,
  };
}
