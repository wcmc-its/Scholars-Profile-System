import "server-only";

/**
 * Research-area hover preview for the unit hero's "Top research areas" pills
 * (Unit Page v2): per area, the number of this unit's visible publications in
 * that area and its 3 most-cited ones, each with how many of the unit's
 * authors are on it.
 *
 * Definitions, chosen so the preview never disagrees with the page it links to:
 *   - "Unit authors" / which papers count — the unit's Publications-tab
 *     predicate (`unitPublicationWhere`): a confirmed member author, a member
 *     `publication_topic` row for the area, and not one of the unit's dark
 *     pmids. NOT the roster predicate (`publicRoleWhere`) — see #718.
 *   - "Most cited" — `publication.citation_count` DESC, pmid ASC: the same
 *     order as the tab's "Most cited" sort, so the 3 preview papers are the
 *     first 3 rows of the "See all" destination and `total` is its count.
 *   - Per-paper author count — the paper's confirmed member authors, minus any
 *     who hid the paper (`isAuthorHidden`), exactly as PublicationCard drops
 *     their chips.
 *
 * Cost: ONE ranking statement for every area at once (`areaPreviewRankSql`),
 * then one publication and one author read for the <= 3 x areas winning pmids.
 * The former shape — a Prisma `count` + `findMany` per area — made the
 * optimizer scan the whole `publication` table once per area (a correlated
 * EXISTS per row), ~1s an area and ~5s for a 10-area department.
 *
 * server-only: constructs Prisma queries. The client pill imports only the
 * TYPES from here (`import type`).
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { cachedRead } from "@/lib/api/swr-cache";
import {
  isAuthorHidden,
  loadAllPublicationSuppressions,
  resolveUnitDarkPmids,
  type PublicationSuppressions,
} from "@/lib/api/manual-layer";
import { loadActiveCenterMemberCwids } from "@/lib/api/centers";
import { loadDivisionMemberCwids } from "@/lib/api/divisions";
import type { UnitMembershipWhere } from "@/lib/api/unit-publication-where";
import type { DepartmentTopicArea } from "@/lib/api/departments";

export type UnitKind = "department" | "center" | "division";

export type UnitAreaPreviewPaper = {
  pmid: string;
  /** Raw PubMed title (may carry inline markup) — render via sanitizePubTitle. */
  title: string;
  /** `publication.journal`; raw PubMed markup, render via PubJournal. */
  venue: string | null;
  year: number | null;
  /** DOI first, then PubMed — same resolution as PublicationCard. */
  href: string | null;
  unitAuthorCount: number;
};

export type UnitAreaPreview = { total: number; papers: UnitAreaPreviewPaper[] };

/** Keyed by parent topic id (`Topic.id`). */
export type UnitAreaPreviews = Record<string, UnitAreaPreview>;

const PREVIEW_PAPERS = 3;

async function resolveMembership(
  kind: UnitKind,
  code: string,
): Promise<UnitMembershipWhere | null> {
  if (kind === "department") {
    return { scholar: { deptCode: code, deletedAt: null, status: "active" } };
  }
  const cwids =
    kind === "center"
      ? await loadActiveCenterMemberCwids(code)
      : await loadDivisionMemberCwids(code);
  return cwids.length > 0 ? { cwid: { in: cwids } } : null;
}

/**
 * `unitPublicationWhere`'s member predicate over a row alias carrying `cwid`
 * (`publication_topic` / `publication_author`), in SQL. Returned as a JOIN
 * (empty for a cwid list) plus a WHERE condition:
 *   - department — `{ scholar: { deptCode, deletedAt: null, status } }`: the
 *     row's scholar is in the department, not soft-deleted, with that status.
 *     A JOIN, not an EXISTS, so the planner can drive from
 *     `scholar(dept_code)` into the row's `cwid` index;
 *   - center / division — `{ cwid: { in } }`: the row's cwid is in the list.
 */
function memberSql(
  alias: "pt" | "pa",
  membership: UnitMembershipWhere,
): { join: Prisma.Sql; where: Prisma.Sql } {
  const col = Prisma.raw(`${alias}.cwid`);
  if ("scholar" in membership) {
    const { deptCode, status } = membership.scholar;
    const s = Prisma.raw(`${alias}_s`);
    return {
      join: Prisma.sql`JOIN scholar ${s} ON ${s}.cwid = ${col}`,
      where: Prisma.sql`${s}.dept_code = ${deptCode} AND ${s}.deleted_at IS NULL AND ${s}.status = ${status}`,
    };
  }
  return { join: Prisma.empty, where: Prisma.sql`${col} IN (${Prisma.join(membership.cwid.in)})` };
}

/**
 * The preview ranking for every area in ONE statement. Per area, the rows of
 * `unitPublicationWhere({ membership, darkPmids, area })` — the area-filtered
 * Publications tab's predicate — ranked in the tab's "Most cited" order
 * (`citation_count DESC, pmid ASC`), keeping the first `PREVIEW_PAPERS` plus
 * the area's full count:
 *   1. `area_pmid` — clause 2 + 3: a member `publication_topic` row for the
 *      area, pmid not dark. DISTINCT: a paper counts once per area however
 *      many members tagged it.
 *   2. `visible` — clause 1: a CONFIRMED member author exists. The join to
 *      `publication` is total (`publication_topic.pmid` is an FK to it) and
 *      supplies `citation_count`.
 *   3. `ranked` — `COUNT(*) OVER` is the tab's total; `ROW_NUMBER() OVER` its
 *      row order.
 *
 * KEEP IN STEP with `unitPublicationWhere` (lib/api/unit-publication-where.ts):
 * a clause added there must be added here, or the pill count and its "See all"
 * destination disagree. Exported for tests only.
 */
export function areaPreviewRankSql({
  membership,
  darkPmids,
  areas,
}: {
  membership: UnitMembershipWhere;
  darkPmids: string[];
  areas: string[];
}): Prisma.Sql {
  const ptMember = memberSql("pt", membership);
  const paMember = memberSql("pa", membership);
  const notDark =
    darkPmids.length > 0
      ? Prisma.sql`AND pt.pmid NOT IN (${Prisma.join(darkPmids)})`
      : Prisma.empty;
  return Prisma.sql`
    WITH area_pmid AS (
      SELECT DISTINCT pt.parent_topic_id AS area, pt.pmid
        FROM publication_topic pt
        ${ptMember.join}
       WHERE pt.parent_topic_id IN (${Prisma.join(areas)})
         AND ${ptMember.where}
         ${notDark}
    ),
    visible AS (
      SELECT ap.area, ap.pmid, p.citation_count
        FROM area_pmid ap
        JOIN publication p ON p.pmid = ap.pmid
       WHERE EXISTS (SELECT 1 FROM publication_author pa
                        ${paMember.join}
                      WHERE pa.pmid = ap.pmid
                        AND pa.is_confirmed = 1
                        AND ${paMember.where})
    ),
    ranked AS (
      SELECT area, pmid,
             COUNT(*) OVER (PARTITION BY area) AS total,
             ROW_NUMBER() OVER (PARTITION BY area ORDER BY citation_count DESC, pmid ASC) AS rn
        FROM visible
    )
    SELECT area, pmid, total, rn FROM ranked WHERE rn <= ${PREVIEW_PAPERS} ORDER BY area, rn`;
}

type RankRow = { area: string; pmid: string; total: number | bigint; rn: number | bigint };

async function getUnitAreaPreviewsUncached(
  kind: UnitKind,
  code: string,
  topicIds: string[],
): Promise<UnitAreaPreviews> {
  if (topicIds.length === 0) return {};
  const membership = await resolveMembership(kind, code);
  if (!membership) return {};

  const suppressions = await loadAllPublicationSuppressions(prisma);
  const darkPmids = await resolveUnitDarkPmids(suppressions, membership, prisma);
  return computeUnitAreaPreviews({ membership, darkPmids, suppressions, topicIds });
}

/**
 * The previews for an already-resolved unit: its membership predicate, its
 * dark pmids (`resolveUnitDarkPmids`) and the site's suppressions (for the
 * per-author hides). Exported for tests and the parity harness; pages call
 * `getUnitAreaPreviews`.
 */
export async function computeUnitAreaPreviews({
  membership,
  darkPmids,
  suppressions,
  topicIds,
}: {
  membership: UnitMembershipWhere;
  darkPmids: string[];
  suppressions: PublicationSuppressions;
  topicIds: string[];
}): Promise<UnitAreaPreviews> {
  if (topicIds.length === 0) return {};
  const ranked =
    ((await prisma.$queryRaw(
      areaPreviewRankSql({ membership, darkPmids, areas: topicIds }),
    )) as RankRow[] | undefined) ?? [];

  const pmids = [...new Set(ranked.map((r) => r.pmid))];
  const [pubs, authors] =
    pmids.length === 0
      ? [[], []]
      : await Promise.all([
          prisma.publication.findMany({
            where: { pmid: { in: pmids } },
            select: { pmid: true, title: true, journal: true, year: true, doi: true, pubmedUrl: true },
          }),
          // The paper's confirmed member authors — the same filter the per-area
          // `authors` include used.
          prisma.publicationAuthor.findMany({
            where: { pmid: { in: pmids }, isConfirmed: true, ...membership },
            select: { pmid: true, cwid: true },
          }),
        ]);
  const pubByPmid = new Map(pubs.map((p) => [p.pmid, p]));
  const authorCwids = new Map<string, Set<string>>();
  for (const a of authors) {
    if (!a.cwid || isAuthorHidden(suppressions, a.pmid, a.cwid)) continue;
    const set = authorCwids.get(a.pmid) ?? new Set<string>();
    set.add(a.cwid);
    authorCwids.set(a.pmid, set);
  }

  const byArea = new Map<string, UnitAreaPreview>();
  // Rows arrive ordered by (area, rn), so each area's papers are in tab order.
  for (const r of ranked) {
    const entry = byArea.get(r.area) ?? { total: Number(r.total), papers: [] };
    byArea.set(r.area, entry);
    const p = pubByPmid.get(r.pmid);
    if (!p) continue;
    entry.papers.push({
      pmid: p.pmid,
      title: p.title,
      venue: p.journal,
      year: p.year,
      href: p.doi ? `https://doi.org/${p.doi}` : (p.pubmedUrl ?? null),
      unitAuthorCount: authorCwids.get(p.pmid)?.size ?? 0,
    });
  }
  // Every requested area gets an entry, in request order; one with no visible
  // paper is `{ total: 0 }` so `applyAreaPreviewCounts` drops its pill.
  return Object.fromEntries(
    topicIds.map((area) => [area, byArea.get(area) ?? { total: 0, papers: [] }]),
  );
}

/**
 * Cached per (unit, area list). The key's first segment is the unit kind, so
 * the existing `bust("department:")` / `bust("center:")` / `bust("division:")`
 * calls clear it along with the rest of that unit's reads.
 */
export function getUnitAreaPreviews(
  kind: UnitKind,
  code: string,
  topicIds: string[],
): Promise<UnitAreaPreviews> {
  return cachedRead(`${kind}:areapreview:${code}:${topicIds.join(",")}`, () =>
    getUnitAreaPreviewsUncached(kind, code, topicIds),
  );
}

/**
 * The pill number becomes the preview's `total` — the same number as the
 * card's blurb, its "See all N" and the filtered tab — and the pills are
 * re-sorted by it (stable). An area with no preview keeps its own count; one
 * whose visible total is 0 (every paper unconfirmed or hidden) is dropped
 * rather than shown as a "0" pill.
 */
export function applyAreaPreviewCounts(
  areas: DepartmentTopicArea[],
  previews: UnitAreaPreviews,
): DepartmentTopicArea[] {
  return areas
    .filter((a) => previews[a.topicId]?.total !== 0)
    .map((a, i) => ({ a: { ...a, pubCount: previews[a.topicId]?.total ?? a.pubCount }, i }))
    .sort((x, y) => y.a.pubCount - x.a.pubCount || x.i - y.i)
    .map((x) => x.a);
}
