/**
 * Centers data layer — `/centers/[slug]` page.
 *
 * `Center` is metadata; `CenterMembership` is the join to scholars.
 * Membership is hand-loaded from `data/center-members/<slug>.txt` until
 * upstream systems land. Member rows are shaped into `DepartmentFacultyHit`
 * so the existing `PersonRow` and `RoleChipRow` components render them
 * unchanged.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { formatRoleCategory } from "@/lib/role-display";
import type {
  DepartmentFacultyHit,
  DepartmentTopicArea,
} from "@/lib/api/departments";
import type { AuthorChip } from "@/components/publication/author-chip-row";
import type {
  DeptHighlights,
  DeptPublicationCard,
  DeptGrantCard,
} from "@/lib/api/dept-highlights";
import type {
  PubSort,
  GrantSort,
  DeptListPubResult,
  DeptListGrantResult,
} from "@/lib/api/dept-lists";

export type CenterDetail = {
  code: string;
  name: string;
  slug: string;
  description: string | null;
  director: {
    cwid: string;
    preferredName: string;
    primaryTitle: string | null;
    slug: string;
    identityImageEndpoint: string;
  } | null;
  scholarCount: number;
};

export type CenterMembersResult = {
  hits: DepartmentFacultyHit[];
  total: number;
  page: number;
  pageSize: number;
};

const MEMBERS_PAGE_SIZE = 20;

type CenterRow = {
  code: string;
  name: string;
  slug: string;
  description: string | null;
  directorCwid: string | null;
  scholarCount: number;
};

export async function getCenter(slug: string): Promise<CenterDetail | null> {
  const center = (await prisma.center.findUnique({
    where: { slug },
    select: {
      code: true,
      name: true,
      slug: true,
      description: true,
      directorCwid: true,
      scholarCount: true,
    },
  })) as CenterRow | null;
  if (!center) return null;

  let director: CenterDetail["director"] = null;
  if (center.directorCwid) {
    const d = await prisma.scholar.findUnique({
      where: { cwid: center.directorCwid },
      select: { cwid: true, preferredName: true, primaryTitle: true, slug: true },
    });
    if (d) {
      director = {
        cwid: d.cwid,
        preferredName: d.preferredName,
        primaryTitle: d.primaryTitle,
        slug: d.slug,
        identityImageEndpoint: identityImageEndpoint(d.cwid),
      };
    }
  }

  return {
    code: center.code,
    name: center.name,
    slug: center.slug,
    description: center.description,
    director,
    scholarCount: center.scholarCount,
  };
}

/**
 * Returns paginated members of a center, shaped as `DepartmentFacultyHit`
 * so `PersonRow` / `RoleChipRow` work unchanged. `divisionName` is null on
 * center members; `departmentName` falls back to the scholar's
 * `primaryDepartment` text when no FK department is resolved (auto-promoted
 * departments may have null deptCode for unmatched names).
 */
export async function getCenterMembers(
  centerCode: string,
  opts: { page?: number } = {},
): Promise<CenterMembersResult> {
  const page = Math.max(0, opts.page ?? 0);

  const memberships = (await prisma.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true },
  })) as Array<{ cwid: string }>;
  const cwids = memberships.map((m) => m.cwid);

  const baseWhere = {
    cwid: { in: cwids },
    deletedAt: null,
    status: "active" as const,
  };
  const total = await prisma.scholar.count({ where: baseWhere });
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: MEMBERS_PAGE_SIZE };
  }

  const rows = await prisma.scholar.findMany({
    where: baseWhere,
    skip: page * MEMBERS_PAGE_SIZE,
    take: MEMBERS_PAGE_SIZE,
    orderBy: [{ preferredName: "asc" }],
    select: {
      cwid: true,
      preferredName: true,
      slug: true,
      primaryTitle: true,
      primaryDepartment: true,
      roleCategory: true,
      overview: true,
      department: { select: { name: true } },
      division: { select: { name: true } },
    },
  });

  const pageCwids = rows.map((s) => s.cwid);
  const now = new Date();
  const [pubCounts, grantCounts] = pageCwids.length > 0
    ? await Promise.all([
        prisma.publicationTopic.groupBy({
          by: ["cwid"],
          where: { cwid: { in: pageCwids } },
          _count: { pmid: true },
        }) as unknown as Promise<Array<{ cwid: string; _count: { pmid: number } }>>,
        prisma.grant.groupBy({
          by: ["cwid"],
          where: { cwid: { in: pageCwids }, endDate: { gte: now } },
          _count: { _all: true },
        }) as unknown as Promise<Array<{ cwid: string; _count: { _all: number } }>>,
      ])
    : [[], []];

  const pubMap = new Map(pubCounts.map((p) => [p.cwid, p._count.pmid]));
  const grantMap = new Map(grantCounts.map((g) => [g.cwid, g._count._all]));

  const hits: DepartmentFacultyHit[] = rows.map((s) => ({
    cwid: s.cwid,
    preferredName: s.preferredName,
    slug: s.slug,
    primaryTitle: s.primaryTitle,
    divisionName: s.division?.name ?? null,
    departmentName: s.department?.name ?? s.primaryDepartment ?? "",
    identityImageEndpoint: identityImageEndpoint(s.cwid),
    roleCategory: formatRoleCategory(s.roleCategory),
    overview: s.overview,
    pubCount: pubMap.get(s.cwid) ?? 0,
    grantCount: grantMap.get(s.cwid) ?? 0,
  }));

  return { hits, total, page, pageSize: MEMBERS_PAGE_SIZE };
}

const PUB_PAGE_SIZE = 20;

/**
 * Paginated publications surface for the center "Publications" tab. A
 * publication qualifies when it has at least one confirmed author whose CWID
 * is in the center's membership list. Sort options match the dept tab.
 *
 * Returns the same shape as `getDeptPublicationsList` so `DeptPublicationsList`
 * can render this surface unchanged (component is structurally generic; only
 * the name is dept-flavored).
 */
export async function getCenterPublicationsList(
  centerCode: string,
  opts: { page?: number; sort?: PubSort } = {},
): Promise<DeptListPubResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: PubSort = opts.sort ?? "newest";

  const memberRows = (await prisma.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true },
  })) as Array<{ cwid: string }>;
  const memberCwids = memberRows.map((m) => m.cwid);
  if (memberCwids.length === 0) {
    return { hits: [], total: 0, page, pageSize: PUB_PAGE_SIZE };
  }

  const pmidRows = (await prisma.publicationAuthor.findMany({
    where: { isConfirmed: true, cwid: { in: memberCwids } },
    select: { pmid: true },
    distinct: ["pmid"],
  })) as Array<{ pmid: string }>;
  const allPmids = pmidRows.map((r) => r.pmid);
  const total = allPmids.length;
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: PUB_PAGE_SIZE };
  }

  const orderBy =
    sort === "most_cited"
      ? [{ citationCount: "desc" as const }, { pmid: "asc" as const }]
      : [{ dateAddedToEntrez: "desc" as const }, { pmid: "asc" as const }];

  const pubs = await prisma.publication.findMany({
    where: { pmid: { in: allPmids } },
    orderBy,
    skip: page * PUB_PAGE_SIZE,
    take: PUB_PAGE_SIZE,
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
        select: { cwid: true, isFirst: true, isLast: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  });

  const cwids = Array.from(
    new Set(pubs.flatMap((p) => p.authors.map((a) => a.cwid!))),
  );
  type Sl = { cwid: string; preferredName: string; slug: string };
  const scholars =
    cwids.length > 0
      ? ((await prisma.scholar.findMany({
          where: { cwid: { in: cwids }, deletedAt: null },
          select: { cwid: true, preferredName: true, slug: true },
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
  }));

  return { hits, total, page, pageSize: PUB_PAGE_SIZE };
}

const GRANT_PAGE_SIZE = 20;

async function getCenterMemberCwids(centerCode: string): Promise<string[]> {
  const rows = await prisma.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true },
  });
  return rows.map((r) => r.cwid);
}

/**
 * Top research areas computed from the center's member-authored work.
 * Returns up to 3 topic chips ranked by distinct PMID count.
 */
export async function getCenterTopResearchAreas(
  centerCode: string,
): Promise<DepartmentTopicArea[]> {
  const memberCwids = await getCenterMemberCwids(centerCode);
  if (memberCwids.length === 0) return [];

  type CountRow = {
    parent_topic_id: string;
    pub_count: number | bigint;
  };
  const countRows = ((await prisma.$queryRawUnsafe(
    `SELECT pt.parent_topic_id, COUNT(DISTINCT pt.pmid) AS pub_count
       FROM publication_topic pt
      WHERE pt.cwid IN (${memberCwids.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")})
      GROUP BY pt.parent_topic_id
      ORDER BY pub_count DESC
      LIMIT 3`,
  )) as CountRow[]) ?? [];
  if (countRows.length === 0) return [];

  const topics = await prisma.topic.findMany({
    where: { id: { in: countRows.map((r) => r.parent_topic_id) } },
    select: { id: true, label: true },
  });
  const topicById = new Map(topics.map((t) => [t.id, t]));

  return countRows
    .map((r) => {
      const t = topicById.get(r.parent_topic_id);
      if (!t) return null;
      return {
        topicId: t.id,
        topicLabel: t.label,
        topicSlug: t.id,
        pubCount: Number(r.pub_count),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * Center-scoped highlights: 3 recent publications + 3 active grants from
 * member-authored work.
 */
export async function getCenterHighlights(
  centerCode: string,
): Promise<DeptHighlights> {
  const memberCwids = await getCenterMemberCwids(centerCode);
  if (memberCwids.length === 0) {
    return { publications: [], grants: [] };
  }

  // Top 3 publications by citation × recency among member-authored work.
  const memberPmids = await prisma.publicationAuthor
    .findMany({
      where: { isConfirmed: true, cwid: { in: memberCwids } },
      select: { pmid: true },
      distinct: ["pmid"],
    })
    .then((r) => r.map((x) => x.pmid));

  const pubs = await prisma.publication.findMany({
    where: { pmid: { in: memberPmids } },
    orderBy: [{ citationCount: "desc" }, { dateAddedToEntrez: "desc" }],
    take: 3,
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
        select: { cwid: true, isFirst: true, isLast: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  });

  type Sl = { cwid: string; preferredName: string; slug: string };
  const allCwids = Array.from(
    new Set(pubs.flatMap((p) => p.authors.map((a) => a.cwid!))),
  );
  const scholars =
    allCwids.length === 0
      ? ([] as Sl[])
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: allCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })) as Sl[]);
  const scholarMap = new Map(scholars.map((s) => [s.cwid, s]));

  const publications: DeptPublicationCard[] = pubs.map((p) => ({
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
  }));

  // Top 3 active grants where any member is on the grant.
  const activeGrants = await prisma.grant.findMany({
    where: {
      endDate: { gte: new Date() },
      cwid: { in: memberCwids },
    },
    orderBy: [{ endDate: "desc" }],
    take: 12,
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
  });

  type GroupSeed = {
    title: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    externalId: string | null;
    awardNumber: string | null;
    cwids: string[];
    piCwids: string[];
  };
  const groups = new Map<string, GroupSeed>();
  function isPiRole(role: string): boolean {
    return /^(PI|Co-PI|MPI)/i.test(role);
  }
  for (const g of activeGrants) {
    const key = g.externalId ?? `__solo__${g.cwid}-${g.startDate.toISOString()}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        title: g.title,
        funder: g.funder,
        startDate: g.startDate,
        endDate: g.endDate,
        externalId: g.externalId,
        awardNumber: g.awardNumber,
        cwids: [g.cwid],
        piCwids: isPiRole(g.role) ? [g.cwid] : [],
      });
    } else {
      if (!existing.cwids.includes(g.cwid)) existing.cwids.push(g.cwid);
      if (isPiRole(g.role) && !existing.piCwids.includes(g.cwid))
        existing.piCwids.push(g.cwid);
    }
  }
  const top3 = Array.from(groups.values()).slice(0, 3);
  const grantCwids = Array.from(new Set(top3.flatMap((g) => g.cwids)));
  const grantScholars =
    grantCwids.length === 0
      ? ([] as Sl[])
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: grantCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })) as Sl[]);
  const grantScholarMap = new Map(grantScholars.map((s) => [s.cwid, s]));

  const grants: DeptGrantCard[] = top3.map((g) => {
    const piList = g.piCwids.length > 0 ? g.piCwids : g.cwids;
    const pis: AuthorChip[] = piList
      .map((c) => {
        const s = grantScholarMap.get(c);
        if (!s) return null;
        return {
          name: s.preferredName,
          cwid: s.cwid,
          slug: s.slug,
          identityImageEndpoint: identityImageEndpoint(s.cwid),
          isFirst: false,
          isLast: false,
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
    };
  });

  return { publications, grants };
}

export async function getCenterGrantsList(
  centerCode: string,
  opts: { page?: number; sort?: GrantSort } = {},
): Promise<DeptListGrantResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: GrantSort = opts.sort ?? "most_recent";
  const memberCwids = await getCenterMemberCwids(centerCode);
  if (memberCwids.length === 0) {
    return { hits: [], total: 0, page, pageSize: GRANT_PAGE_SIZE };
  }

  const baseWhere = {
    endDate: { gte: new Date() },
    cwid: { in: memberCwids },
  };

  const distinctRows = (await prisma.grant.findMany({
    where: baseWhere,
    select: { externalId: true, id: true },
  })) as Array<{ externalId: string | null; id: string }>;
  const totalKeys = new Set(distinctRows.map((r) => r.externalId ?? r.id));
  const total = totalKeys.size;
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: GRANT_PAGE_SIZE };
  }

  const orderBy =
    sort === "end_date"
      ? [{ endDate: "desc" as const }]
      : [{ startDate: "desc" as const }];

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
  }>;

  type Group = {
    title: string;
    funder: string;
    startDate: Date;
    endDate: Date;
    externalId: string | null;
    awardNumber: string | null;
    cwids: string[];
    piCwids: string[];
    sortKey: number;
  };
  const groups = new Map<string, Group>();
  function isPiRole(role: string): boolean {
    return /^(PI|Co-PI|MPI)/i.test(role);
  }
  for (const r of all) {
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
        cwids: [r.cwid],
        piCwids: isPiRole(r.role) ? [r.cwid] : [],
        sortKey,
      });
    } else {
      if (!existing.cwids.includes(r.cwid)) existing.cwids.push(r.cwid);
      if (isPiRole(r.role) && !existing.piCwids.includes(r.cwid))
        existing.piCwids.push(r.cwid);
      if (sortKey > existing.sortKey) existing.sortKey = sortKey;
    }
  }

  const sortedGroups = Array.from(groups.values()).sort(
    (a, b) => b.sortKey - a.sortKey,
  );
  const pageSlice = sortedGroups.slice(
    page * GRANT_PAGE_SIZE,
    (page + 1) * GRANT_PAGE_SIZE,
  );

  type Sl = { cwid: string; preferredName: string; slug: string };
  const cwids = Array.from(new Set(pageSlice.flatMap((g) => g.cwids)));
  const scholars =
    cwids.length === 0
      ? ([] as Sl[])
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: cwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })) as Sl[]);
  const scholarMap = new Map(scholars.map((s) => [s.cwid, s]));

  const hits: DeptGrantCard[] = pageSlice.map((g) => {
    const piList = g.piCwids.length > 0 ? g.piCwids : g.cwids;
    const pis: AuthorChip[] = piList
      .map((c) => {
        const s = scholarMap.get(c);
        if (!s) return null;
        return {
          name: s.preferredName,
          cwid: s.cwid,
          slug: s.slug,
          identityImageEndpoint: identityImageEndpoint(s.cwid),
          isFirst: false,
          isLast: false,
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
    };
  });

  return { hits, total, page, pageSize: GRANT_PAGE_SIZE };
}
