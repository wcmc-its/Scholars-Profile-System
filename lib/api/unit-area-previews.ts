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
 * server-only: constructs Prisma queries. The client pill imports only the
 * TYPES from here (`import type`).
 */
import { prisma } from "@/lib/db";
import { cachedRead } from "@/lib/api/swr-cache";
import {
  isAuthorHidden,
  loadAllPublicationSuppressions,
  resolveUnitDarkPmids,
} from "@/lib/api/manual-layer";
import { loadActiveCenterMemberCwids } from "@/lib/api/centers";
import { loadDivisionMemberCwids } from "@/lib/api/divisions";
import { unitPublicationWhere, type UnitMembershipWhere } from "@/lib/api/unit-publication-where";
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

/**
 * Areas computed at once on a cache miss. Each area is a count + a findMany
 * (whose nested `authors` include is a follow-up query), so 2 areas hold at
 * most ~4 of the 15 pool connections — the preview rides on every unit-page
 * render and must not starve the tab queries rendering beside it.
 */
const AREA_CONCURRENCY = 2;

/** `fn` over `items`, at most `limit` in flight; results in input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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

  const entries = await mapBounded(topicIds, AREA_CONCURRENCY, async (area) => {
    const where = unitPublicationWhere({ membership, darkPmids, area });
    const [total, pubs] = await Promise.all([
      prisma.publication.count({ where }),
      prisma.publication.findMany({
        where,
        orderBy: [{ citationCount: "desc" }, { pmid: "asc" }],
        take: PREVIEW_PAPERS,
        select: {
          pmid: true,
          title: true,
          journal: true,
          year: true,
          doi: true,
          pubmedUrl: true,
          authors: {
            where: { isConfirmed: true, ...membership },
            select: { cwid: true },
          },
        },
      }),
    ]);
    const papers: UnitAreaPreviewPaper[] = pubs.map((p) => ({
      pmid: p.pmid,
      title: p.title,
      venue: p.journal,
      year: p.year,
      href: p.doi ? `https://doi.org/${p.doi}` : (p.pubmedUrl ?? null),
      unitAuthorCount: new Set(
        p.authors
          .map((a) => a.cwid)
          .filter((c): c is string => !!c && !isAuthorHidden(suppressions, p.pmid, c)),
      ).size,
    }));
    return [area, { total, papers }] as const;
  });
  return Object.fromEntries(entries);
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
