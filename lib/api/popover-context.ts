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
import { loadHiddenAuthorshipCounts } from "@/lib/api/manual-layer";
import { isPubliclyDisplayed, publicRoleWhere } from "@/lib/eligibility";

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
 *
 * #2221 — this is the ONLY gate on a PUBLIC, UNAUTHENTICATED endpoint
 * (`/api/scholars/[cwid]/popover-context`): the route 404s the whole request the
 * moment this returns null, so every #536 hidden identity class must be dropped
 * HERE. It used to gate on `deletedAt` alone, which is inert against the prod
 * data shape — 690 scholars carry the BARE `doctoral_student` role with
 * `deleted_at IS NULL` — so an anonymous caller with a CWID harvested from a
 * department page (#2202) got a full identity card: degree postnominal,
 * "Graduate Student" title, school affiliation, headshot, pub/grant counts.
 * (On staging the same students are suffixed AND soft-deleted, so `deletedAt`
 * masks the hole entirely; a staging-only test proves nothing here.)
 *
 * Returning `null` — not a distinguishable error — is deliberate: a hidden
 * scholar and a nonexistent CWID must produce the identical 404, or the endpoint
 * becomes an existence oracle for exactly the population it is hiding.
 */
export async function fetchPopoverHeader(
  cwid: string,
): Promise<PopoverContextHeader | null> {
  const scholar = await prisma.scholar.findFirst({
    // The carve runs at the QUERY layer, not as a post-filter: this is an
    // anonymous API boundary, so the where-clause is the access control.
    // `publicRoleWhere()` admits `role_category IS NULL` explicitly — a bare
    // `notIn` would also drop NULL rows and 404 every un-backfilled scholar.
    where: { cwid, deletedAt: null, ...publicRoleWhere() },
    select: {
      cwid: true,
      preferredName: true,
      postnominal: true,
      primaryTitle: true,
      primaryDepartment: true,
      slug: true,
      status: true,
      deletedAt: true,
      roleCategory: true,
      _count: {
        select: {
          authorships: true,
          // RePORTER-backfilled grants are individual history, not WCM-administered
          // awards; exclude so the hover-card count matches the filtered unit lists.
          grants: { where: { source: { not: "RePORTER" } } },
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
  // Belt-and-braces on the RAW `role_category` column — never a humanized label
  // (that mixup was the #2202 bug). Prisma can't express the `doctoral_student*`
  // prefix, so `publicRoleWhere()` only enumerates the known suffixes; this
  // predicate prefix-matches AND fails closed on any unrecognized role, so an
  // out-of-band value the enum hasn't caught up with hides rather than leaks.
  if (!isPubliclyDisplayed(scholar.roleCategory)) return null;

  // #356 — a per-author hide lowers the scholar's public publication count.
  const hiddenPubs =
    (await loadHiddenAuthorshipCounts([cwid], prisma)).get(cwid) ?? 0;

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
    totalPubCount: Math.max(0, scholar._count.authorships - hiddenPubs),
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
  // #928 P2 — in-VPC (MENTORING_COPUB_BRIDGE on) the live ReciterDB query is
  // unreachable, so read the scholar's recent CONFIRMED publications from the
  // local publication_author + publication tables instead — the same source
  // every sibling lookup in this module already uses, so the popover is
  // internally consistent. Off ⇒ the live ReciterDB query (unchanged).
  if (process.env.MENTORING_COPUB_BRIDGE === "on") {
    const rows = await prisma.$queryRaw<
      Array<{ pmid: string; title: string | null; year: number | null }>
    >`
      SELECT p.pmid AS pmid, p.title AS title, p.year AS year
        FROM publication_author pa
        JOIN publication p ON p.pmid = pa.pmid
       WHERE pa.cwid = ${cwid}
         AND pa.is_confirmed = 1
       ORDER BY p.year DESC, p.pmid DESC
       LIMIT ${limit}
    `.catch(() => []);
    return rows.map((r) => ({ pmid: r.pmid, title: r.title ?? "", year: r.year }));
  }
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

/**
 * Active grant for the recent-grants list on the grant-investigator popover
 * (#257). `endYear` is always populated — `Grant.end_date` is non-null.
 */
export type RecentGrant = {
  id: string;
  title: string;
  sponsor: string | null;
  endYear: number;
};

/** 12-month NCE grace beyond end_date — mirrors NCE_GRACE_MS in
 *  lib/api/search-funding.ts (a grant counts as active until end_date + 365d). */
const NCE_GRACE_MS = 365 * 24 * 60 * 60 * 1000;

/** Account number embedded in a `Grant.externalId` (`INFOED-{accountNumber}-{cwid}`,
 *  per parseExternalId in lib/funding-projection.ts) — used to drop the hovered
 *  project from the recent-grants list. */
function accountNumberFromExternalId(externalId: string): string | null {
  const m = externalId.match(/^INFOED-(.+)-([^-]+)$/);
  return m ? m[1] : null;
}

/**
 * The scholar's most recently-ending *active* grants — the optional bottom
 * list on the grant-investigator popover. `excludeProjectId` drops the grant
 * the user is hovering so the card doesn't echo its own row.
 */
export async function fetchRecentActiveGrants(
  cwid: string,
  opts: { limit?: number; excludeProjectId?: string } = {},
): Promise<RecentGrant[]> {
  if (!cwid) return [];
  const limit = opts.limit ?? 2;
  const cutoff = new Date(Date.now() - NCE_GRACE_MS);
  const rows = await prisma.grant
    .findMany({
      where: { cwid, endDate: { gt: cutoff }, source: { not: "RePORTER" } },
      orderBy: [{ endDate: "desc" }, { startDate: "desc" }],
      take: limit + 1, // headroom to drop the hovered project
      select: {
        id: true,
        title: true,
        externalId: true,
        endDate: true,
        primeSponsor: true,
        primeSponsorRaw: true,
      },
    })
    .catch(() => []);
  const out: RecentGrant[] = [];
  for (const r of rows) {
    if (
      opts.excludeProjectId &&
      accountNumberFromExternalId(r.externalId) === opts.excludeProjectId
    ) {
      continue;
    }
    out.push({
      id: r.id,
      title: r.title,
      sponsor: r.primeSponsor ?? r.primeSponsorRaw,
      endYear: r.endDate.getUTCFullYear(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The investigator's most frequent prime sponsor across all their grants —
 * the "top in {sponsor}" tail on the grant-facet popover line. All-time, not
 * filter-aware (a filter-aware version is a #257 v1.1 follow-up).
 */
export async function fetchInvestigatorTopSponsor(
  cwid: string,
): Promise<string | null> {
  if (!cwid) return null;
  const rows = await prisma.grant
    .findMany({
      where: { cwid },
      select: { primeSponsor: true, primeSponsorRaw: true },
    })
    .catch(() => []);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const sponsor = r.primeSponsor ?? r.primeSponsorRaw;
    if (!sponsor) continue;
    counts.set(sponsor, (counts.get(sponsor) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [sponsor, n] of counts) {
    // Most frequent; ties broken alphabetically for a stable result.
    if (n > bestN || (n === bestN && best !== null && sponsor < best)) {
      best = sponsor;
      bestN = n;
    }
  }
  return best;
}
