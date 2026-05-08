/**
 * Division-page data assembly. Mirrors lib/api/departments.ts shape but
 * scoped to a single division within its parent department.
 *
 * Routing: /departments/[slug]/divisions/[div] resolves a division by
 * its (deptCode, slug) composite — the same human-readable URL works for
 * both Cardiology divisions (Medicine + Pediatrics) without colliding.
 *
 * Top research areas + highlights + paginated tabs reuse the dept-side
 * helpers where possible; where a deptCode-keyed query needs to become a
 * divCode-keyed query, this file inlines the query rather than refactoring
 * the dept helpers (a follow-up commit can DRY the two paths).
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import type { DepartmentTopicArea } from "@/lib/api/departments";
import type {
  DeptHighlights,
  DeptPublicationCard,
  DeptGrantCard,
} from "@/lib/api/dept-highlights";
import type {
  DeptListPubResult,
  DeptListGrantResult,
  PubSort,
  GrantSort,
} from "@/lib/api/dept-lists";
import type { AuthorChip } from "@/components/publication/author-chip-row";
import { formatRoleCategory } from "@/lib/role-display";

const FACULTY_PAGE_SIZE = 20;
const PUB_PAGE_SIZE = 20;
const GRANT_PAGE_SIZE = 20;

export type DivisionChief = {
  cwid: string;
  preferredName: string;
  slug: string;
  chiefTitle: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
};

export type SiblingDivision = {
  code: string;
  name: string;
  slug: string;
};

export type DivisionStats = {
  scholars: number;
  publications: number;
  activeGrants: number;
};

export type DivisionDetail = {
  division: {
    code: string;
    name: string;
    slug: string;
    description: string | null;
  };
  parentDept: { code: string; name: string; slug: string };
  chief: DivisionChief | null;
  topResearchAreas: DepartmentTopicArea[];
  siblingDivisions: SiblingDivision[];
  stats: DivisionStats;
};

export async function getDivision(
  deptSlug: string,
  divSlug: string,
): Promise<DivisionDetail | null> {
  const dept = await prisma.department.findUnique({ where: { slug: deptSlug } });
  if (!dept) return null;

  const division = await prisma.division.findFirst({
    where: { deptCode: dept.code, slug: divSlug },
  });
  if (!division) return null;

  // Chief
  let chief: DivisionChief | null = null;
  if (division.chiefCwid) {
    const chiefScholar = await prisma.scholar.findUnique({
      where: { cwid: division.chiefCwid },
      select: { cwid: true, preferredName: true, slug: true, primaryTitle: true },
    });
    if (chiefScholar) {
      const chiefAppt = await prisma.appointment.findFirst({
        where: {
          cwid: division.chiefCwid,
          endDate: null,
          OR: [
            { title: { startsWith: "Chief" } },
            { title: { startsWith: "Director" } },
          ],
        },
        orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
        select: { title: true },
      });
      chief = {
        cwid: chiefScholar.cwid,
        preferredName: chiefScholar.preferredName,
        slug: chiefScholar.slug,
        chiefTitle: chiefAppt?.title ?? "Chief",
        primaryTitle: chiefScholar.primaryTitle,
        identityImageEndpoint: identityImageEndpoint(chiefScholar.cwid),
      };
    }
  }

  // Sibling divisions (every division of the parent dept, including the current one
  // so the UI can highlight it as the active chip).
  const siblingDivisions = await prisma.division.findMany({
    where: { deptCode: dept.code },
    select: { code: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });

  // Top research areas computed for division members only.
  const topResearchAreas = await getDivisionTopResearchAreas(division.code);

  // Stats: distinct member count, distinct publications, active grants.
  const memberCwids = await prisma.scholar
    .findMany({
      where: { divCode: division.code, deletedAt: null, status: "active" },
      select: { cwid: true },
    })
    .then((rows) => rows.map((r) => r.cwid));

  const [pubCount, grantCount] = await Promise.all([
    memberCwids.length === 0
      ? Promise.resolve(0)
      : prisma.publicationAuthor
          .findMany({
            where: { isConfirmed: true, cwid: { in: memberCwids } },
            select: { pmid: true },
            distinct: ["pmid"],
          })
          .then((rows) => rows.length),
    memberCwids.length === 0
      ? Promise.resolve(0)
      : prisma.grant
          .findMany({
            where: {
              endDate: { gte: new Date() },
              cwid: { in: memberCwids },
            },
            select: { externalId: true, id: true },
          })
          .then((rows) => {
            const keys = new Set(rows.map((r) => r.externalId ?? r.id));
            return keys.size;
          }),
  ]);

  return {
    division: {
      code: division.code,
      name: division.name,
      slug: division.slug,
      description: division.description,
    },
    parentDept: { code: dept.code, name: dept.name, slug: dept.slug },
    chief,
    topResearchAreas,
    siblingDivisions,
    stats: {
      scholars: memberCwids.length,
      publications: pubCount,
      activeGrants: grantCount,
    },
  };
}

export async function getDivisionTopResearchAreas(
  divCode: string,
): Promise<DepartmentTopicArea[]> {
  const memberCwids = await prisma.scholar
    .findMany({
      where: { divCode, deletedAt: null, status: "active" },
      select: { cwid: true },
    })
    .then((rows) => rows.map((r) => r.cwid));

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
        topicSlug: t.id, // Topic.id is the slug per Phase 2 convention
        pubCount: Number(r.pub_count),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export type DivisionFacultyResult = {
  hits: Array<{
    cwid: string;
    preferredName: string;
    slug: string;
    primaryTitle: string | null;
    divisionName: string | null;
    departmentName: string;
    identityImageEndpoint: string;
    roleCategory: string | null;
    overview: string | null;
    pubCount: number;
    grantCount: number;
  }>;
  total: number;
  /** Whole-scope role-category counts for the role-chip-row. (#17) */
  roleCategoryCounts: Record<string, number>;
  page: number;
  pageSize: number;
};

export async function getDivisionFaculty(
  divCode: string,
  opts: { page?: number },
): Promise<DivisionFacultyResult> {
  const page = Math.max(0, opts.page ?? 0);
  const where = {
    divCode,
    deletedAt: null,
    status: "active" as const,
  };

  const total = await prisma.scholar.count({ where });
  if (total === 0) {
    return { hits: [], total: 0, roleCategoryCounts: {}, page, pageSize: FACULTY_PAGE_SIZE };
  }

  const roleCategoryCounts = await (async () => {
    const rows = await prisma.scholar.groupBy({
      by: ["roleCategory"],
      where,
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) {
      const label = formatRoleCategory(r.roleCategory);
      if (label === null) continue;
      out[label] = (out[label] ?? 0) + r._count._all;
    }
    return out;
  })();

  const div = await prisma.division.findFirst({
    where: { code: divCode },
    select: { chiefCwid: true },
  });
  const chiefCwid = div?.chiefCwid ?? null;

  const includeClause = {
    department: { select: { name: true } },
    division: { select: { name: true } },
  } as const;

  let chiefRow: Awaited<ReturnType<typeof prisma.scholar.findFirst>> | null = null;
  if (chiefCwid && page === 0) {
    chiefRow = await prisma.scholar.findFirst({
      where: { cwid: chiefCwid, ...where },
      include: includeClause,
    });
  }

  const restWhere = chiefRow ? { ...where, NOT: { cwid: chiefRow.cwid } } : where;
  const restTake = chiefRow ? FACULTY_PAGE_SIZE - 1 : FACULTY_PAGE_SIZE;
  const restSkip =
    chiefRow && page > 0 ? page * FACULTY_PAGE_SIZE - 1 : page * FACULTY_PAGE_SIZE;

  const rest = await prisma.scholar.findMany({
    where: restWhere,
    skip: Math.max(0, restSkip),
    take: restTake,
    orderBy: [{ preferredName: "asc" }],
    include: includeClause,
  });
  const allRows = chiefRow ? [chiefRow, ...rest] : rest;

  // Pub/grant counts per scholar — same shape as dept faculty rows.
  const cwids = allRows.map((r) => r.cwid);
  const [pubCounts, grantCounts] = await Promise.all([
    cwids.length === 0
      ? Promise.resolve([] as Array<{ cwid: string; _count: { _all: number } }>)
      : (prisma.publicationAuthor.groupBy as unknown as (
          args: unknown,
        ) => Promise<Array<{ cwid: string; _count: { _all: number } }>>)({
          by: ["cwid"],
          where: { isConfirmed: true, cwid: { in: cwids } },
          _count: { _all: true },
          orderBy: { cwid: "asc" },
        }),
    cwids.length === 0
      ? Promise.resolve([] as Array<{ cwid: string; _count: { _all: number } }>)
      : (prisma.grant.groupBy as unknown as (
          args: unknown,
        ) => Promise<Array<{ cwid: string; _count: { _all: number } }>>)({
          by: ["cwid"],
          where: { cwid: { in: cwids } },
          _count: { _all: true },
          orderBy: { cwid: "asc" },
        }),
  ]);
  const pubByCwid = new Map(pubCounts.map((r) => [r.cwid, r._count._all]));
  const grantByCwid = new Map(grantCounts.map((r) => [r.cwid, r._count._all]));

  type RowWithRelations = (typeof allRows)[number] & {
    department: { name: string } | null;
    division: { name: string } | null;
  };
  const hits = (allRows as RowWithRelations[]).map((r) => ({
    cwid: r.cwid,
    preferredName: r.preferredName,
    slug: r.slug,
    primaryTitle: r.primaryTitle,
    divisionName: r.division?.name ?? null,
    departmentName: r.department?.name ?? "",
    identityImageEndpoint: identityImageEndpoint(r.cwid),
    roleCategory: r.roleCategory,
    overview: r.overview ? r.overview.slice(0, 120) : null,
    pubCount: pubByCwid.get(r.cwid) ?? 0,
    grantCount: grantByCwid.get(r.cwid) ?? 0,
  }));

  return { hits, total, roleCategoryCounts, page, pageSize: FACULTY_PAGE_SIZE };
}

/**
 * Division-scoped highlights: 3 recent publications + 3 active grants from
 * member-authored work. Reuses dept-highlights' card shape but builds a
 * fresh query bounded to division members.
 */
export async function getDivisionHighlights(divCode: string): Promise<DeptHighlights> {
  const memberCwids = await prisma.scholar
    .findMany({
      where: { divCode, deletedAt: null, status: "active" },
      select: { cwid: true },
    })
    .then((rows) => rows.map((r) => r.cwid));

  if (memberCwids.length === 0) {
    return { publications: [], grants: [] };
  }

  // Top 3 publications by citationCount × recency among member-authored work.
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

  const allCwids = Array.from(
    new Set(pubs.flatMap((p) => p.authors.map((a) => a.cwid!))),
  );
  type Sl = { cwid: string; preferredName: string; slug: string };
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

  // Top 3 active grants by most-recent end date.
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

  // Group by externalId for multi-PI rendering, keep top 3 groups.
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
  const top3Groups = Array.from(groups.values()).slice(0, 3);
  const grantCwids = Array.from(new Set(top3Groups.flatMap((g) => g.cwids)));
  const grantScholars =
    grantCwids.length === 0
      ? ([] as Sl[])
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: grantCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })) as Sl[]);
  const grantScholarMap = new Map(grantScholars.map((s) => [s.cwid, s]));

  const grants: DeptGrantCard[] = top3Groups.map((g) => {
    const piList =
      g.piCwids.length > 0
        ? g.piCwids
        : g.cwids; // fall back: render all if no PI marked
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

export async function getDivisionPublicationsList(
  divCode: string,
  opts: { page?: number; sort?: PubSort } = {},
): Promise<DeptListPubResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: PubSort = opts.sort ?? "newest";

  const memberPmidRows = (await prisma.publicationAuthor.findMany({
    where: {
      isConfirmed: true,
      scholar: { divCode, deletedAt: null, status: "active" },
    },
    select: { pmid: true },
    distinct: ["pmid"],
  })) as Array<{ pmid: string }>;
  const allPmids = memberPmidRows.map((r) => r.pmid);
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

export async function getDivisionGrantsList(
  divCode: string,
  opts: { page?: number; sort?: GrantSort } = {},
): Promise<DeptListGrantResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: GrantSort = opts.sort ?? "most_recent";
  const now = new Date();

  const baseWhere = {
    scholar: { divCode, deletedAt: null, status: "active" as const },
    endDate: { gte: now },
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

  const cwids = Array.from(new Set(pageSlice.flatMap((g) => g.cwids)));
  type Sl = { cwid: string; preferredName: string; slug: string };
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
