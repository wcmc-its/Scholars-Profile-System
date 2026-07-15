/**
 * Paginated full lists for the Publications and Grants tabs on
 * /departments/[slug]. Same shapes as the highlight cards (DeptPublicationCard
 * / DeptGrantCard) so a single card component renders both surfaces.
 *
 * Sort options are constrained to data we actually have in Phase A:
 *   - Publications: newest (dateAddedToEntrez DESC), most-cited (citationCount
 *     DESC). "By impact" deferred — needs upstream score we don't carry per
 *     publication on the dept surface.
 *   - Grants: most-recent (start_date DESC), end-date (end_date DESC).
 *     "Largest" deferred — needs amount column.
 *
 * Pagination matches the scholars list pattern: 20 per page; page is
 * 1-indexed from the URL and 0-indexed internally.
 */
import { prisma } from "@/lib/db";
import { cachedRead } from "@/lib/api/swr-cache";
import { identityImageEndpoint } from "@/lib/headshot";
import type { AuthorChip } from "@/components/publication/author-chip-row";
import type {
  DeptPublicationCard,
  DeptGrantCard,
} from "@/lib/api/dept-highlights";
import {
  isAuthorHidden,
  loadAllPublicationSuppressions,
  resolveActiveGrantSuppression,
  resolveUnitDarkPmids,
} from "@/lib/api/manual-layer";

const PAGE_SIZE = 20;

export type PubSort = "newest" | "most_cited";
export type GrantSort = "most_recent" | "end_date";

export type DeptListPubResult = {
  hits: DeptPublicationCard[];
  total: number;
  page: number;
  pageSize: number;
};
export type DeptListGrantResult = {
  hits: DeptGrantCard[];
  total: number;
  page: number;
  pageSize: number;
};

async function getDeptPublicationsListUncached(
  deptCode: string,
  opts: { page?: number; sort?: PubSort } = {},
): Promise<DeptListPubResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: PubSort = opts.sort ?? "newest";

  // #1505 — push dept membership into the page query and count via an
  // `authors: { some }` relation filter instead of materializing every distinct
  // dept pmid (50k-100k for a large dept). Suppression is inverted: load the
  // SMALL sitewide active-suppression set, resolve the unit's dark pmids from it
  // (tens of rows), and exclude them via `pmid: { notIn }`. #356 — total and the
  // page window are both computed over this visible set.
  const membership = { scholar: { deptCode, deletedAt: null, status: "active" } };
  const suppressions = await loadAllPublicationSuppressions(prisma);
  const unitDarkPmids = await resolveUnitDarkPmids(suppressions, membership, prisma);
  const visibleWhere = {
    authors: { some: { isConfirmed: true, ...membership } },
    ...(unitDarkPmids.length > 0 ? { pmid: { notIn: unitDarkPmids } } : {}),
  };
  const total = await prisma.publication.count({ where: visibleWhere });
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: PAGE_SIZE };
  }

  const orderBy =
    sort === "most_cited"
      ? [{ citationCount: "desc" as const }, { pmid: "asc" as const }]
      : [{ dateAddedToEntrez: "desc" as const }, { pmid: "asc" as const }];

  const pubs = await prisma.publication.findMany({
    where: visibleWhere,
    orderBy,
    skip: page * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      citationCount: true,
      doi: true,
      pubmedUrl: true,
      authors: {
        where: { isConfirmed: true, cwid: { not: null } },
        select: {
          cwid: true,
          isFirst: true,
          isLast: true,
          position: true,
        },
        orderBy: { position: "asc" },
      },
    },
  });

  const cwids = Array.from(
    new Set(pubs.flatMap((p) => p.authors.map((a) => a.cwid!))),
  );
  type Sl = { cwid: string; preferredName: string; slug: string; roleCategory: string | null };
  const scholars =
    cwids.length > 0
      ? ((await prisma.scholar.findMany({
          where: { cwid: { in: cwids }, deletedAt: null },
          select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
        })) as Sl[])
      : [];
  const scholarMap = new Map(scholars.map((s) => [s.cwid, s]));

  const hits: DeptPublicationCard[] = pubs.map((p) => ({
    pmid: p.pmid,
    title: p.title,
    journal: p.journal,
    year: p.year,
    citationCount: p.citationCount,
    doi: p.doi,
    pubmedUrl: p.pubmedUrl,
    authors: p.authors
      .map((a) => {
        const s = scholarMap.get(a.cwid!);
        // #356 — drop the chip of a co-author who hid this publication.
        if (!s || isAuthorHidden(suppressions, p.pmid, a.cwid!)) return null;
        return {
          name: s.preferredName,
          cwid: s.cwid,
          slug: s.slug,
          identityImageEndpoint: identityImageEndpoint(s.cwid),
          isFirst: a.isFirst,
          isLast: a.isLast,
          roleCategory: s.roleCategory,
        } satisfies AuthorChip;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  }));

  return { hits, total, page, pageSize: PAGE_SIZE };
}

async function getDeptGrantsListUncached(
  deptCode: string,
  opts: { page?: number; sort?: GrantSort } = {},
): Promise<DeptListGrantResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: GrantSort = opts.sort ?? "most_recent";
  const now = new Date();

  // Active grants only on this surface to match the stats line. Exclude
  // source='RePORTER' (individual prior-institution/history rows, not
  // WCM-administered awards) so they never enter unit rollups.
  const baseWhere = {
    scholar: { deptCode, deletedAt: null, status: "active" },
    endDate: { gte: now },
    source: { not: "RePORTER" },
  };

  // Count distinct externalIds (grants) — fall back to count of rows when
  // externalId is null. #160/#481(b) — drop suppressed grants from the count
  // and (below) from the grouping, so the list and its badge never surface a
  // hidden grant.
  const distinctRows = (await prisma.grant.findMany({
    where: baseWhere,
    select: { externalId: true, id: true },
  })) as Array<{ externalId: string | null; id: string }>;
  const { suppressed, unsuppressedKeyCount: total } =
    await resolveActiveGrantSuppression(distinctRows, prisma);
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: PAGE_SIZE };
  }

  const orderBy =
    sort === "end_date"
      ? [{ endDate: "desc" as const }]
      : [{ startDate: "desc" as const }];

  // Pull all grants and group client-side by externalId — needed for multi-PI
  // chips. Pagination is applied AFTER grouping. Pool size sufficient for
  // departments with <2k active grants; revisit if perf shows up.
  const all = (await prisma.grant.findMany({
    where: baseWhere,
    orderBy,
    select: {
      cwid: true,
      title: true,
      role: true,
      funder: true,
      startDate: true,
      endDate: true,
      externalId: true,
      awardNumber: true,
      applId: true,
    },
  })) as Array<{
    cwid: string;
    title: string;
    role: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    externalId: string | null;
    awardNumber: string | null;
    applId: number | null;
  }>;

  type Group = {
    title: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    externalId: string | null;
    awardNumber: string | null;
    applId: number | null;
    cwids: string[];
    piCwids: string[];
    sortKey: number;
  };
  const groups = new Map<string, Group>();
  function isPiRole(role: string): boolean {
    return /^(PI|Co-PI|MPI)/i.test(role);
  }
  for (const r of all) {
    // #160/#481(b) — skip suppressed grant rows before grouping (keyed on the
    // same externalId set the count excluded above).
    if (r.externalId !== null && suppressed.has(r.externalId)) continue;
    const key = r.externalId ?? `__solo__${r.cwid}-${r.startDate.toISOString()}`;
    const existing = groups.get(key);
    const sortKey =
      sort === "end_date" ? r.endDate.getTime() : r.startDate.getTime();
    if (!existing) {
      groups.set(key, {
        title: r.title,
        funder: r.funder,
        startDate: r.startDate,
        endDate: r.endDate,
        externalId: r.externalId,
        awardNumber: r.awardNumber,
        applId: r.applId,
        cwids: [r.cwid],
        piCwids: isPiRole(r.role) ? [r.cwid] : [],
        sortKey,
      });
    } else {
      if (!existing.cwids.includes(r.cwid)) existing.cwids.push(r.cwid);
      if (isPiRole(r.role) && !existing.piCwids.includes(r.cwid))
        existing.piCwids.push(r.cwid);
      if (existing.applId === null && r.applId !== null) existing.applId = r.applId;
      if (sortKey > existing.sortKey) existing.sortKey = sortKey;
    }
  }

  const sortedGroups = Array.from(groups.values()).sort(
    (a, b) => b.sortKey - a.sortKey,
  );
  const pageSlice = sortedGroups.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );

  const cwids = Array.from(new Set(pageSlice.flatMap((g) => g.cwids)));
  type Sl = { cwid: string; preferredName: string; slug: string; roleCategory: string | null };
  const scholars =
    cwids.length > 0
      ? ((await prisma.scholar.findMany({
          where: { cwid: { in: cwids }, deletedAt: null },
          select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
        })) as Sl[])
      : [];
  const scholarMap = new Map(scholars.map((s) => [s.cwid, s]));

  const hits: DeptGrantCard[] = pageSlice.map((g) => {
    const chipCwids = g.piCwids.length > 0 ? g.piCwids : g.cwids.slice(0, 1);
    const pis: AuthorChip[] = chipCwids
      .map((cwid) => {
        const s = scholarMap.get(cwid);
        if (!s) return null;
        return {
          name: s.preferredName,
          cwid: s.cwid,
          slug: s.slug,
          identityImageEndpoint: identityImageEndpoint(s.cwid),
          isFirst: true,
          isLast: false,
          roleCategory: s.roleCategory,
        } satisfies AuthorChip;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      externalId: g.externalId,
      awardNumber: g.awardNumber,
      funder: g.funder,
      title: g.title,
      startDate: g.startDate,
      endDate: g.endDate,
      isRecentlyCompleted: false,
      pis,
      isMultiPi: g.piCwids.length >= 2,
      applId: g.applId,
    };
  });

  return { hits, total: sortedGroups.length, page, pageSize: PAGE_SIZE };
}

// --- Cached public wrappers (viewer-independent reads via lib/api/swr-cache;
//     mirrors the center-page caching in lib/api/centers.ts). ---
export const getDeptPublicationsList = (
  deptCode: string,
  opts: { page?: number; sort?: PubSort } = {},
) =>
  cachedRead(
    `department:pubs:${deptCode}:${Math.max(0, opts.page ?? 0)}:${opts.sort ?? "newest"}`,
    () => getDeptPublicationsListUncached(deptCode, opts),
  );

export const getDeptGrantsList = (
  deptCode: string,
  opts: { page?: number; sort?: GrantSort } = {},
) =>
  cachedRead(
    `department:grants:${deptCode}:${Math.max(0, opts.page ?? 0)}:${opts.sort ?? "most_recent"}`,
    () => getDeptGrantsListUncached(deptCode, opts),
  );
