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
import type { DepartmentFacultyHit } from "@/lib/api/departments";
import type { AuthorChip } from "@/components/publication/author-chip-row";
import type { DeptPublicationCard } from "@/lib/api/dept-highlights";
import type { PubSort, DeptListPubResult } from "@/lib/api/dept-lists";

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
