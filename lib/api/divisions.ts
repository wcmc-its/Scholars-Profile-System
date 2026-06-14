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
import {
  isAuthorHidden,
  isUnitSuppressed,
  loadHiddenAuthorshipCounts,
  loadPublicationSuppressions,
  loadUnitFieldOverrides,
  mergeUnitFields,
  resolveActiveGrantSuppression,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import {
  loadPublicFamiliesForMembers,
  ROSTER_ROW_METHODS_CAP,
  type MemberMethodFamily,
} from "@/lib/api/methods-roster";
import { isOrgUnitMethodsChipsEnabled } from "@/lib/profile/methods-lens-flags";

const FACULTY_PAGE_SIZE = 20;
const PUB_PAGE_SIZE = 20;
const GRANT_PAGE_SIZE = 20;

/**
 * Return the active CWID set for a division — LDAP-attached scholars
 * (`Scholar.divCode = code`) plus, when `Division.source = 'manual'`, the
 * `DivisionMembership` roster. Deduped by CWID, filtered through `Scholar`
 * so a manual-roster row pointing at a soft-deleted / inactive scholar or
 * one whose ED record has not yet landed (#540 SPEC edge 19) never surfaces
 * on public reads. Issue #540 Phase 8.
 *
 * `opts.source` is an optional shortcut for callers that already loaded the
 * division row; passing it elides one point lookup.
 */
async function loadDivisionMemberCwids(
  divCode: string,
  opts: { source?: string } = {},
): Promise<string[]> {
  const ldapRows = await prisma.scholar.findMany({
    where: { divCode, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  let source = opts.source;
  if (source === undefined) {
    const div = await prisma.division.findFirst({
      where: { code: divCode },
      select: { source: true },
    });
    source = div?.source;
  }
  if (source !== "manual") {
    return ldapRows.map((r) => r.cwid);
  }
  const manualRows = await prisma.divisionMembership.findMany({
    where: { divisionCode: divCode },
    select: { cwid: true },
  });
  if (manualRows.length === 0) {
    return ldapRows.map((r) => r.cwid);
  }
  const union = new Set<string>(ldapRows.map((r) => r.cwid));
  for (const r of manualRows) union.add(r.cwid);
  // Filter the unioned set through Scholar to (a) preserve activity gating for
  // manual-roster CWIDs and (b) drop CWIDs with no Scholar row yet — edge 19's
  // "stored, attaches when the row lands". An LDAP-side scholar passes
  // trivially (we already filtered them above).
  const activeRows = await prisma.scholar.findMany({
    where: {
      cwid: { in: Array.from(union) },
      deletedAt: null,
      status: "active",
    },
    select: { cwid: true },
  });
  return activeRows.map((r) => r.cwid);
}

export type DivisionChief = {
  cwid: string;
  preferredName: string;
  slug: string;
  chiefTitle: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  /** Interim/acting qualifier — `field_override(leaderInterim)` (#540 / ADR-005
   *  Amendment 1 § A1.1). Renders "Interim Chief"; default false. */
  isInterim: boolean;
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

  // #540 — a retired (whole-unit-suppressed) division is a 404.
  if (await isUnitSuppressed("division", division.code, prisma)) return null;

  // #540 — field-override merge over `description`, `leaderCwid`,
  // `leaderInterim` (ADR-005 Amendment 1 § A1.1). `slug` is consumed by
  // `etl/ed`, not merged here.
  const overrides = await loadUnitFieldOverrides("division", division.code, prisma);
  const merged = mergeUnitFields(
    { description: division.description, leaderCwid: division.chiefCwid },
    overrides,
  );

  // Chief — three-state (#540 SPEC § 1): null = no row, "" = explicit vacancy,
  // non-empty = the curated CWID.
  let chief: DivisionChief | null = null;
  if (merged.leaderCwid && merged.leaderCwid !== "") {
    const chiefScholar = await prisma.scholar.findUnique({
      where: { cwid: merged.leaderCwid },
      select: { cwid: true, preferredName: true, slug: true, primaryTitle: true },
    });
    if (chiefScholar) {
      const chiefAppt = await prisma.appointment.findFirst({
        where: {
          cwid: merged.leaderCwid,
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
        isInterim: merged.leaderInterim,
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
  // #540 Phase 8 — `loadDivisionMemberCwids` unions LDAP-attached scholars
  // with the `DivisionMembership` roster (when `source='manual'`, edge 15),
  // filtered through `Scholar` for active gating.
  const memberCwids = await loadDivisionMemberCwids(division.code, {
    source: division.source,
  });

  const [pubCount, grantCount] = await Promise.all([
    memberCwids.length === 0
      ? Promise.resolve(0)
      : (async () => {
          // #356 — count only publications still visible (not taken down or
          // derived-dark).
          const poolPmids = (
            await prisma.publicationAuthor.findMany({
              where: { isConfirmed: true, cwid: { in: memberCwids } },
              select: { pmid: true },
              distinct: ["pmid"],
            })
          ).map((r) => r.pmid);
          const suppressions = await loadPublicationSuppressions(poolPmids, prisma);
          const darkPmids = await resolveDarkPmids(poolPmids, suppressions, prisma);
          return poolPmids.filter((p) => !darkPmids.has(p)).length;
        })(),
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
          // #481(b) — exclude #160-suppressed grants so the stat agrees with
          // the Grants-tab list/badge.
          .then((rows) =>
            resolveActiveGrantSuppression(rows, prisma).then(
              (r) => r.unsuppressedKeyCount,
            ),
          ),
  ]);

  return {
    division: {
      code: division.code,
      name: division.name,
      slug: division.slug,
      description: merged.description,
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
  // #540 Phase 8 — include `DivisionMembership` roster for manual divisions.
  const memberCwids = await loadDivisionMemberCwids(divCode);

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
    /** #974 — top ≤3 PUBLIC method families for the per-row chips. Present only
     *  when ORG_UNIT_METHODS_CHIPS (+ METHODS_LENS_ENABLED) is on AND the member
     *  has ≥1 public family; undefined otherwise. */
    topMethods?: MemberMethodFamily[];
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

  // #540 Phase 8 — one division-row lookup feeds both `loadDivisionMemberCwids`
  // (for `source`) and the chief lookup (for `chiefCwid`).
  const div = await prisma.division.findFirst({
    where: { code: divCode },
    select: { chiefCwid: true, source: true },
  });
  const chiefCwid = div?.chiefCwid ?? null;

  const memberCwids = await loadDivisionMemberCwids(divCode, {
    source: div?.source,
  });
  const total = memberCwids.length;
  if (total === 0) {
    return { hits: [], total: 0, roleCategoryCounts: {}, page, pageSize: FACULTY_PAGE_SIZE };
  }
  const memberCwidSet = new Set(memberCwids);
  const where = {
    cwid: { in: memberCwids },
    deletedAt: null,
    status: "active" as const,
  };

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

  const includeClause = {
    department: { select: { name: true } },
    division: { select: { name: true } },
  } as const;

  let chiefRow: Awaited<ReturnType<typeof prisma.scholar.findFirst>> | null = null;
  if (chiefCwid && page === 0 && memberCwidSet.has(chiefCwid)) {
    chiefRow = await prisma.scholar.findFirst({
      where: { cwid: chiefCwid, deletedAt: null, status: "active" },
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
  // #356 — subtract each scholar's per-author hides from their pub count.
  const hiddenCounts = await loadHiddenAuthorshipCounts(cwids, prisma);
  const pubByCwid = new Map(
    pubCounts.map((r) => [
      r.cwid,
      Math.max(0, r._count._all - (hiddenCounts.get(r.cwid) ?? 0)),
    ]),
  );
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

  // #974 — attach top-≤3 PUBLIC method families for the per-row chips, keyed on
  // the visible page's ≤20 CWIDs (no whole-dataset aggregation — that's Phase 2).
  // The loader self-gates on the flag, so off → empty map → hits pass through
  // byte-identical, and the page stays CloudFront-cacheable (a plain DB read,
  // no per-viewer call).
  const famByCwid = await loadPublicFamiliesForMembers(cwids, {
    enabled: isOrgUnitMethodsChipsEnabled(),
  });
  const finalHits =
    famByCwid.size === 0
      ? hits
      : hits.map((h) => {
          const fams = famByCwid.get(h.cwid);
          return fams && fams.length > 0
            ? { ...h, topMethods: fams.slice(0, ROSTER_ROW_METHODS_CAP) }
            : h;
        });

  return { hits: finalHits, total, roleCategoryCounts, page, pageSize: FACULTY_PAGE_SIZE };
}

/**
 * Division-scoped highlights: 3 recent publications + 3 active grants from
 * member-authored work. Reuses dept-highlights' card shape but builds a
 * fresh query bounded to division members.
 */
export async function getDivisionHighlights(divCode: string): Promise<DeptHighlights> {
  // #540 Phase 8 — include `DivisionMembership` roster for manual divisions.
  const memberCwids = await loadDivisionMemberCwids(divCode);

  if (memberCwids.length === 0) {
    return { publications: [], grants: [] };
  }

  // Top 3 publications by citationCount × recency among member-authored work.
  const poolPmids = await prisma.publicationAuthor
    .findMany({
      where: { isConfirmed: true, cwid: { in: memberCwids } },
      select: { pmid: true },
      distinct: ["pmid"],
    })
    .then((r) => r.map((x) => x.pmid));
  // #356 — exclude publications taken down or derived-dark from the pool.
  const suppressions = await loadPublicationSuppressions(poolPmids, prisma);
  const darkPmids = await resolveDarkPmids(poolPmids, suppressions, prisma);
  const memberPmids = poolPmids.filter((p) => !darkPmids.has(p));

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
  type Sl = { cwid: string; preferredName: string; slug: string; roleCategory: string | null };
  const scholars =
    allCwids.length === 0
      ? ([] as Sl[])
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: allCwids } },
          select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
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
          select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
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

  // #540 Phase 8 — include `DivisionMembership` roster for manual divisions.
  const memberCwids = await loadDivisionMemberCwids(divCode);
  if (memberCwids.length === 0) {
    return { hits: [], total: 0, page, pageSize: PUB_PAGE_SIZE };
  }
  const memberPmidRows = (await prisma.publicationAuthor.findMany({
    where: {
      isConfirmed: true,
      cwid: { in: memberCwids },
    },
    select: { pmid: true },
    distinct: ["pmid"],
  })) as Array<{ pmid: string }>;
  const poolPmids = memberPmidRows.map((r) => r.pmid);
  // #356 — drop taken-down / derived-dark publications before paginating.
  const suppressions = await loadPublicationSuppressions(poolPmids, prisma);
  const darkPmids = await resolveDarkPmids(poolPmids, suppressions, prisma);
  const allPmids = poolPmids.filter((p) => !darkPmids.has(p));
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

  return { hits, total, page, pageSize: PUB_PAGE_SIZE };
}

export async function getDivisionGrantsList(
  divCode: string,
  opts: { page?: number; sort?: GrantSort } = {},
): Promise<DeptListGrantResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: GrantSort = opts.sort ?? "most_recent";
  const now = new Date();

  // #540 Phase 8 — include `DivisionMembership` roster for manual divisions.
  const memberCwids = await loadDivisionMemberCwids(divCode);
  if (memberCwids.length === 0) {
    return { hits: [], total: 0, page, pageSize: GRANT_PAGE_SIZE };
  }
  const baseWhere = {
    cwid: { in: memberCwids },
    endDate: { gte: now },
  };

  const distinctRows = (await prisma.grant.findMany({
    where: baseWhere,
    select: { externalId: true, id: true },
  })) as Array<{ externalId: string | null; id: string }>;
  // #160/#481(b) — drop suppressed grants from the count and (below) the
  // grouping so a hidden grant never lists or inflates the badge.
  const { suppressed, unsuppressedKeyCount: total } =
    await resolveActiveGrantSuppression(distinctRows, prisma);
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
    // #160/#481(b) — skip suppressed grant rows before grouping.
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
  type Sl = { cwid: string; preferredName: string; slug: string; roleCategory: string | null };
  const scholars =
    cwids.length === 0
      ? ([] as Sl[])
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: cwids } },
          select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
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
    };
  });

  return { hits, total, page, pageSize: GRANT_PAGE_SIZE };
}
