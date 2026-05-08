/**
 * Department highlight + full-list data for the Recent publications and
 * Active grants surfaces inserted between the stats line and the tabs on
 * /departments/[slug].
 *
 * Phase A scope (no upstream changes):
 *   - Recent publications selection uses citationCount as a proxy for impact
 *     (no citation-velocity timeseries available); recency uses
 *     dateAddedToEntrez; "diversity" picks an item from a different parent
 *     topic when one is available, else falls back to position-3 by score.
 *   - Active grants selection uses end_date >= today, ranked by:
 *       (1) most recent end date (i.e. longest still-running)
 *       (2) most recently awarded
 *       (3) broadest dept participation (most distinct cwids on same
 *           externalId)
 *     Dollar amounts not displayed (column missing — see Phase B).
 *
 * "Recently completed" fallback: if fewer than 3 active grants, pad with
 * grants whose end_date is within the last 12 months, marked
 * `isRecentlyCompleted: true` for visual differentiation.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import type { AuthorChip } from "@/components/publication/author-chip-row";

export type DeptPublicationCard = {
  pmid: string;
  title: string;
  journal: string | null;
  year: number | null;
  citationCount: number;
  doi: string | null;
  pubmedUrl: string | null;
  authors: AuthorChip[];
};

export type DeptGrantCard = {
  externalId: string | null;
  awardNumber: string | null;
  funder: string | null;
  title: string;
  startDate: Date | null;
  endDate: Date | null;
  isRecentlyCompleted: boolean;
  pis: AuthorChip[];
  /** True when ≥2 PIs across the same externalId (multi-PI grant). */
  isMultiPi: boolean;
};

export type DeptHighlights = {
  publications: DeptPublicationCard[];
  grants: DeptGrantCard[];
};

const DEPT_PUB_POOL_SIZE = 60;
const DEPT_GRANT_POOL_SIZE = 60;

type ScholarLite = {
  cwid: string;
  preferredName: string;
  slug: string;
};

async function loadScholarLite(cwids: string[]): Promise<Map<string, ScholarLite>> {
  if (cwids.length === 0) return new Map();
  const rows = (await prisma.scholar.findMany({
    where: { cwid: { in: cwids }, deletedAt: null },
    select: { cwid: true, preferredName: true, slug: true },
  })) as ScholarLite[];
  return new Map(rows.map((r) => [r.cwid, r]));
}

export async function getDeptRecentPublications(
  deptCode: string,
): Promise<DeptPublicationCard[]> {
  // Pull a pool of candidate PMIDs that have at least one WCM author whose
  // dept_code matches the department. We aggregate per pmid so each pub only
  // shows up once even when several dept members co-author it.
  const poolRaw = (await prisma.publicationAuthor.findMany({
    where: {
      isConfirmed: true,
      scholar: { deptCode, deletedAt: null, status: "active" },
    },
    select: { pmid: true },
    distinct: ["pmid"],
    take: DEPT_PUB_POOL_SIZE * 4,
  })) as Array<{ pmid: string }>;
  const poolPmids = poolRaw.map((r) => r.pmid);
  if (poolPmids.length === 0) return [];

  // Fetch publication metadata + ALL confirmed authors (WCM + dept overlap)
  // for chip rendering. Order pool by recency × citation desc.
  const pubs = await prisma.publication.findMany({
    where: { pmid: { in: poolPmids } },
    select: {
      pmid: true,
      title: true,
      journal: true,
      year: true,
      citationCount: true,
      doi: true,
      pubmedUrl: true,
      dateAddedToEntrez: true,
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

  // Pull topic ids for diversity selection — first parent topic per pmid.
  const topics = (await prisma.publicationTopic.findMany({
    where: { pmid: { in: poolPmids } },
    select: { pmid: true, parentTopicId: true },
  })) as Array<{ pmid: string; parentTopicId: string }>;
  const topicByPmid = new Map<string, string>();
  for (const t of topics) {
    if (!topicByPmid.has(t.pmid)) topicByPmid.set(t.pmid, t.parentTopicId);
  }

  // Resolve author chip metadata.
  const allAuthorCwids = Array.from(
    new Set(pubs.flatMap((p) => p.authors.map((a) => a.cwid!))),
  );
  const scholars = await loadScholarLite(allAuthorCwids);

  type Candidate = DeptPublicationCard & {
    dateAddedToEntrez: Date | null;
    parentTopicId: string | null;
  };
  const candidates: Candidate[] = pubs
    .map((p) => ({
      pmid: p.pmid,
      title: p.title,
      journal: p.journal,
      year: p.year,
      citationCount: p.citationCount,
      doi: p.doi,
      pubmedUrl: p.pubmedUrl,
      dateAddedToEntrez: p.dateAddedToEntrez,
      parentTopicId: topicByPmid.get(p.pmid) ?? null,
      authors: p.authors
        .map((a) => {
          const s = scholars.get(a.cwid!);
          if (!s) return null;
          return {
            name: s.preferredName,
            cwid: s.cwid,
            slug: s.slug,
            identityImageEndpoint: identityImageEndpoint(s.cwid),
            isFirst: a.isFirst,
            isLast: a.isLast,
          } satisfies AuthorChip;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    }))
    .filter((c) => c.authors.length > 0);

  // Selection:
  //   #1 highest citationCount overall (impact proxy)
  //   #2 most recent by dateAddedToEntrez (recency), excluding #1
  //   #3 first remaining whose parent topic differs from #1 and #2 (diversity);
  //      fall back to next highest citation if no diverse candidate exists.
  const byImpact = [...candidates].sort(
    (a, b) => b.citationCount - a.citationCount,
  );
  const byRecency = [...candidates].sort((a, b) => {
    const ad = a.dateAddedToEntrez?.getTime() ?? 0;
    const bd = b.dateAddedToEntrez?.getTime() ?? 0;
    return bd - ad;
  });

  const picks: Candidate[] = [];
  const usedPmids = new Set<string>();

  if (byImpact[0]) {
    picks.push(byImpact[0]);
    usedPmids.add(byImpact[0].pmid);
  }
  for (const c of byRecency) {
    if (picks.length >= 2) break;
    if (!usedPmids.has(c.pmid)) {
      picks.push(c);
      usedPmids.add(c.pmid);
    }
  }
  const usedTopics = new Set(picks.map((p) => p.parentTopicId).filter(Boolean));
  for (const c of byImpact) {
    if (picks.length >= 3) break;
    if (usedPmids.has(c.pmid)) continue;
    if (c.parentTopicId && !usedTopics.has(c.parentTopicId)) {
      picks.push(c);
      usedPmids.add(c.pmid);
    }
  }
  for (const c of byImpact) {
    if (picks.length >= 3) break;
    if (!usedPmids.has(c.pmid)) {
      picks.push(c);
      usedPmids.add(c.pmid);
    }
  }

  return picks.map(({ dateAddedToEntrez, parentTopicId, ...rest }) => rest);
}

export async function getDeptActiveGrants(
  deptCode: string,
): Promise<DeptGrantCard[]> {
  const now = new Date();
  // Pull active grants for dept members. role=PI primarily, but we keep the
  // broad set so we can compute multi-PI / co-investigator counts.
  const rows = (await prisma.grant.findMany({
    where: {
      scholar: { deptCode, deletedAt: null, status: "active" },
      endDate: { gte: now },
    },
    select: {
      cwid: true,
      title: true,
      role: true,
      funder: true,
      startDate: true,
      endDate: true,
      externalId: true,
      awardNumber: true,
    },
    orderBy: { endDate: "desc" },
    take: DEPT_GRANT_POOL_SIZE * 4,
  })) as Array<{
    cwid: string;
    title: string;
    role: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    externalId: string | null;
    awardNumber: string | null;
  }>;

  return await groupAndPickGrants(rows, false);
}

async function groupAndPickGrants(
  rows: Array<{
    cwid: string;
    title: string;
    role: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    externalId: string | null;
    awardNumber: string | null;
  }>,
  allRecentlyCompleted: boolean,
): Promise<DeptGrantCard[]> {
  if (rows.length === 0) return [];

  // Group rows by externalId (when present) so multi-PI / multi-investigator
  // grants collapse into a single card. Rows with null externalId are kept
  // independent (one card per row).
  type Group = {
    title: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    externalId: string | null;
    awardNumber: string | null;
    /** All cwids of dept members on this grant (union of PI + Co-I + ...) */
    cwids: string[];
    /** cwids that hold a PI-class role on this grant */
    piCwids: string[];
  };
  const groups = new Map<string, Group>();

  function isPiRole(role: string): boolean {
    return /^(PI|Co-PI|MPI)/i.test(role);
  }

  for (const r of rows) {
    const key = r.externalId ?? `__solo__${r.cwid}-${r.startDate.toISOString()}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        title: r.title,
        funder: r.funder,
        startDate: r.startDate,
        endDate: r.endDate,
        externalId: r.externalId,
        awardNumber: r.awardNumber,
        cwids: [r.cwid],
        piCwids: isPiRole(r.role) ? [r.cwid] : [],
      });
    } else {
      if (!existing.cwids.includes(r.cwid)) existing.cwids.push(r.cwid);
      if (isPiRole(r.role) && !existing.piCwids.includes(r.cwid))
        existing.piCwids.push(r.cwid);
    }
  }

  const allCwids = Array.from(
    new Set(Array.from(groups.values()).flatMap((g) => g.cwids)),
  );
  const scholars = await loadScholarLite(allCwids);

  // Convert each group to a sortable, render-ready candidate.
  type Candidate = {
    card: DeptGrantCard;
    rankRecentEnd: number;
    rankRecentStart: number;
    rankParticipation: number;
  };
  const candidates: Candidate[] = Array.from(groups.values()).map((g) => {
    // Build PI chip list. If no PI roles found (e.g. grant only lists a Co-I
    // from the dept), fall back to the dept member as the chip so the card
    // still has someone visible.
    const chipCwids = g.piCwids.length > 0 ? g.piCwids : g.cwids.slice(0, 1);
    const pis: AuthorChip[] = chipCwids
      .map((cwid) => {
        const s = scholars.get(cwid);
        if (!s) return null;
        return {
          name: s.preferredName,
          cwid: s.cwid,
          slug: s.slug,
          identityImageEndpoint: identityImageEndpoint(s.cwid),
          // Author chip semantics don't apply to grants; reuse the slate
          // first-author variant by setting isFirst=true for visual parity
          // with the spec.
          isFirst: true,
          isLast: false,
        } satisfies AuthorChip;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const card: DeptGrantCard = {
      externalId: g.externalId,
      awardNumber: g.awardNumber,
      funder: g.funder,
      title: g.title,
      startDate: g.startDate,
      endDate: g.endDate,
      isRecentlyCompleted: allRecentlyCompleted,
      pis,
      isMultiPi: g.piCwids.length >= 2,
    };
    return {
      card,
      rankRecentEnd: g.endDate.getTime(),
      rankRecentStart: g.startDate.getTime(),
      rankParticipation: g.cwids.length,
    };
  });

  const picked: DeptGrantCard[] = [];
  const used = new Set<string>();
  function add(c: Candidate | undefined): void {
    if (!c) return;
    const key = c.card.externalId ?? c.card.title;
    if (used.has(key)) return;
    used.add(key);
    picked.push(c.card);
  }

  // 1. Latest end date (longest still-running)
  add([...candidates].sort((a, b) => b.rankRecentEnd - a.rankRecentEnd)[0]);
  // 2. Most recently awarded (latest start date)
  add(
    [...candidates]
      .sort((a, b) => b.rankRecentStart - a.rankRecentStart)
      .find((c) => !used.has(c.card.externalId ?? c.card.title)),
  );
  // 3. Broadest dept participation (most distinct dept cwids)
  add(
    [...candidates]
      .sort((a, b) => b.rankParticipation - a.rankParticipation)
      .find((c) => !used.has(c.card.externalId ?? c.card.title)),
  );
  return picked.slice(0, 3);
}

export async function getDeptHighlights(deptCode: string): Promise<DeptHighlights> {
  const [publications, grants] = await Promise.all([
    getDeptRecentPublications(deptCode),
    getDeptActiveGrants(deptCode),
  ]);

  // Recently-completed fallback for grants when fewer than 3 active.
  if (grants.length < 3) {
    const since = new Date();
    since.setMonth(since.getMonth() - 12);
    const now = new Date();
    const closedRows = (await prisma.grant.findMany({
      where: {
        scholar: { deptCode, deletedAt: null, status: "active" },
        endDate: { gte: since, lt: now },
      },
      select: {
        cwid: true,
        title: true,
        role: true,
        funder: true,
        startDate: true,
        endDate: true,
        externalId: true,
        awardNumber: true,
      },
      orderBy: { endDate: "desc" },
      take: DEPT_GRANT_POOL_SIZE,
    })) as Parameters<typeof groupAndPickGrants>[0];
    const closedCards = await groupAndPickGrants(closedRows, true);
    const usedKeys = new Set(grants.map((g) => g.externalId ?? g.title));
    for (const c of closedCards) {
      if (grants.length >= 3) break;
      const key = c.externalId ?? c.title;
      if (!usedKeys.has(key)) {
        grants.push(c);
        usedKeys.add(key);
      }
    }
  }

  return { publications, grants };
}
