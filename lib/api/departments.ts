/**
 * Department-page data assembly.
 *
 * Surfaces:
 *   - getDepartment(slug)              D-01/D-03 — dept row, chair, top research areas, divisions, stats
 *   - getDepartmentFaculty(code, opts) D-12      — paginated faculty list with optional division filter
 *
 * See also: lib/api/topics.ts — getDistinctScholarCountForTopic (D-10 affordance lives there
 * for semantic correctness, since it operates on Topic data).
 *
 * Ordering: chief-of-division first when filtering by division; remaining faculty
 * sorted by preferredName ASC (pub-count DESC would require raw SQL — see note below).
 *
 * Eligibility: NO role carve on department faculty list per UI-SPEC §6.10 — all 11
 * role values shown. Only deletedAt IS NULL + status = active apply.
 *
 * See:
 *   - .planning/phases/03-topic-and-department-detail-pages/03-UI-SPEC.md §6.5–§6.10
 *   - .planning/phases/03-topic-and-department-detail-pages/03-CONTEXT.md (D-01, D-03, D-10, D-12)
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { formatRoleCategory } from "@/lib/role-display";

export type DepartmentChair = {
  cwid: string;
  preferredName: string;
  slug: string;
  /** From appointment.title, e.g. "Chairman and Stephen and Suzanne Weiss Professor" */
  chairTitle: string;
  /** Scholar's primary academic title, e.g. "Professor of Medicine" */
  primaryTitle: string | null;
  identityImageEndpoint: string;
};

export type DepartmentTopicArea = {
  topicId: string;
  topicLabel: string;
  topicSlug: string;
  pubCount: number;
};

export type DepartmentDivisionSummary = {
  code: string;
  name: string;
  slug: string;
  description: string | null;
  chiefCwid: string | null;
  chiefName: string | null;
  chiefSlug: string | null;
  scholarCount: number;
};

export type DepartmentStats = {
  scholars: number;
  divisions: number;
  publications: number;
  activeGrants: number;
};

export type DepartmentDetail = {
  dept: { code: string; name: string; slug: string; description: string | null };
  chair: DepartmentChair | null;
  topResearchAreas: DepartmentTopicArea[];
  divisions: DepartmentDivisionSummary[];
  stats: DepartmentStats;
};

export async function getDepartment(slug: string): Promise<DepartmentDetail | null> {
  const dept = await prisma.department.findUnique({ where: { slug } });
  if (!dept) return null;

  // --- Chair ---
  let chair: DepartmentChair | null = null;
  if (dept.chairCwid) {
    const chairScholar = await prisma.scholar.findUnique({
      where: { cwid: dept.chairCwid },
      select: { cwid: true, preferredName: true, slug: true, primaryTitle: true },
    });
    if (chairScholar) {
      // Find the chair's most-recent active appointment with a title starting "Chair" or "Chairman".
      const chairAppt = await prisma.appointment.findFirst({
        where: {
          cwid: dept.chairCwid,
          endDate: null,
          OR: [
            { title: { startsWith: "Chair" } },
            { title: { startsWith: "Professor and Chair" } },
          ],
        },
        orderBy: [{ isPrimary: "desc" }, { startDate: "desc" }],
        select: { title: true },
      });
      chair = {
        cwid: chairScholar.cwid,
        preferredName: chairScholar.preferredName,
        slug: chairScholar.slug,
        chairTitle: chairAppt?.title ?? "Chair",
        primaryTitle: chairScholar.primaryTitle ?? null,
        identityImageEndpoint: identityImageEndpoint(chairScholar.cwid),
      };
    }
  }

  // --- Top research areas: top 10 parent topics by distinct pub count for dept scholars ---
  const topicCounts = await prisma.publicationTopic.groupBy({
    by: ["parentTopicId"],
    where: {
      scholar: { deptCode: dept.code, deletedAt: null, status: "active" },
    },
    _count: { pmid: true },
    orderBy: { _count: { pmid: "desc" } },
    take: 10,
  });
  const topicIds = topicCounts.map((t: { parentTopicId: string }) => t.parentTopicId);
  const topicMeta =
    topicIds.length > 0
      ? await prisma.topic.findMany({
          where: { id: { in: topicIds } },
          select: { id: true, label: true },
        })
      : ([] as Array<{ id: string; label: string }>);
  const labelMap = new Map<string, string>(
    topicMeta.map((t: { id: string; label: string }) => [t.id, t.label]),
  );
  const topResearchAreas: DepartmentTopicArea[] = topicCounts.map(
    (t: { parentTopicId: string; _count: { pmid: number } }) => ({
      topicId: t.parentTopicId,
      topicLabel: labelMap.get(t.parentTopicId) ?? t.parentTopicId,
      topicSlug: t.parentTopicId, // Topic.id IS the slug per 02-SCHEMA-DECISION.md
      pubCount: t._count.pmid,
    }),
  );

  // --- Divisions for this dept, sorted by scholarCount DESC ---
  const rawDivisions = await prisma.division.findMany({
    where: { deptCode: dept.code },
    orderBy: { scholarCount: "desc" },
  });
  type DivisionRow = Awaited<typeof rawDivisions>[number];
  const chiefCwids: string[] = rawDivisions
    .map((d: DivisionRow) => d.chiefCwid)
    .filter((c: string | null): c is string => !!c);
  const chiefScholars =
    chiefCwids.length > 0
      ? await prisma.scholar.findMany({
          where: { cwid: { in: chiefCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })
      : ([] as Array<{ cwid: string; preferredName: string; slug: string }>);
  type ChiefRow = { cwid: string; preferredName: string; slug: string };
  const chiefMap = new Map<string, ChiefRow>(
    chiefScholars.map((s: ChiefRow) => [s.cwid, s]),
  );
  const divisions: DepartmentDivisionSummary[] = rawDivisions.map((d: DivisionRow) => {
    const chief = d.chiefCwid ? (chiefMap.get(d.chiefCwid) ?? null) : null;
    return {
      code: d.code,
      name: d.name,
      slug: d.slug,
      description: d.description,
      chiefCwid: d.chiefCwid,
      chiefName: chief?.preferredName ?? null,
      chiefSlug: chief?.slug ?? null,
      scholarCount: d.scholarCount,
    };
  });

  // --- Stats ---
  const now = new Date();
  const [scholarsCount, pubCount, grantCount] = await Promise.all([
    prisma.scholar.count({ where: { deptCode: dept.code, deletedAt: null, status: "active" } }),
    prisma.publicationTopic.count({
      where: { scholar: { deptCode: dept.code, deletedAt: null, status: "active" } },
    }),
    prisma.grant.count({
      where: {
        scholar: { deptCode: dept.code, deletedAt: null, status: "active" },
        endDate: { gte: now },
      },
    }),
  ]);

  const stats: DepartmentStats = {
    scholars: scholarsCount,
    divisions: divisions.length,
    publications: pubCount,
    activeGrants: grantCount,
  };

  return {
    dept: { code: dept.code, name: dept.name, slug: dept.slug, description: dept.description },
    chair,
    topResearchAreas,
    divisions,
    stats,
  };
}

export type DepartmentFacultyHit = {
  cwid: string;
  preferredName: string;
  slug: string;
  primaryTitle: string | null;
  /** Division name for the "Division · Department of Name" line */
  divisionName: string | null;
  departmentName: string;
  identityImageEndpoint: string;
  /** Role tag — Full-time faculty / Postdoc / etc. */
  roleCategory: string | null;
  /** First ~120 chars of the scholar's research overview for the person-row snippet */
  overview: string | null;
  pubCount: number;
  grantCount: number;
};

export type DepartmentFacultyResult = {
  hits: DepartmentFacultyHit[];
  total: number;
  page: number;
  pageSize: number;
};

const FACULTY_PAGE_SIZE = 20;

const normalizeRoleCategory = formatRoleCategory;

/**
 * Returns paginated faculty for a department, optionally filtered by division.
 *
 * Ordering: chief-of-division first (when divCode is set and chief is on page 0),
 * then remaining faculty sorted by preferredName ASC.
 *
 * NOTE: pub-count DESC ordering would require a subquery or raw SQL in Prisma.
 * preferredName ASC is used as the deterministic fallback for Phase 3 first pass.
 * If pub-count ordering becomes a hard requirement, add a prisma.$queryRaw variant.
 *
 * No eligibility carve — all roles shown per UI-SPEC §6.10.
 */
export async function getDepartmentFaculty(
  deptCode: string,
  opts: { divCode?: string; page?: number },
): Promise<DepartmentFacultyResult> {
  const page = Math.max(0, opts.page ?? 0);
  const baseWhere = {
    deptCode,
    deletedAt: null,
    status: "active" as const,
    ...(opts.divCode ? { divCode: opts.divCode } : {}),
  };

  const total = await prisma.scholar.count({ where: baseWhere });
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: FACULTY_PAGE_SIZE };
  }

  // Chief-first ordering when divCode is provided.
  let chiefCwid: string | null = null;
  if (opts.divCode) {
    const div = await prisma.division.findFirst({
      where: { code: opts.divCode },
      select: { chiefCwid: true },
    });
    chiefCwid = div?.chiefCwid ?? null;
  }

  // Scholar rows include department and division names.
  const includeClause = {
    department: { select: { name: true } },
    division: { select: { name: true } },
  } as const;

  // Fetch chief separately on page 0 if one exists.
  let chiefRow: Awaited<ReturnType<typeof prisma.scholar.findFirst>> | null = null;
  if (chiefCwid && page === 0) {
    chiefRow = await prisma.scholar.findFirst({
      where: { cwid: chiefCwid, ...baseWhere },
      include: includeClause,
    });
  }

  // Fetch remaining scholars (excluding chief if present on page 0).
  const restWhere = chiefRow ? { ...baseWhere, NOT: { cwid: chiefRow.cwid } } : baseWhere;
  // If chief occupies a slot on page 0, rest gets PAGE_SIZE - 1 rows from offset 0.
  // For page > 0, offset adjusts by -1 to account for chief consuming slot 0.
  const restTake = chiefRow ? FACULTY_PAGE_SIZE - 1 : FACULTY_PAGE_SIZE;
  const restSkip = chiefRow && page > 0 ? page * FACULTY_PAGE_SIZE - 1 : page * FACULTY_PAGE_SIZE;

  const rest = await prisma.scholar.findMany({
    where: restWhere,
    skip: Math.max(0, restSkip),
    take: restTake,
    orderBy: [{ preferredName: "asc" }],
    include: includeClause,
  });

  const allRows = chiefRow ? [chiefRow, ...rest] : rest;

  type ScholarRow = (typeof allRows)[number];

  // Batch-fetch pub + grant counts.
  const cwids = allRows.map((s: ScholarRow) => s.cwid);
  const now = new Date();

  type PubGroupRow = { cwid: string; _count: { pmid: number } };
  type GrantGroupRow = { cwid: string; _count: { _all: number } };

  let pubCounts: PubGroupRow[] = [];
  let grantCounts: GrantGroupRow[] = [];

  if (cwids.length > 0) {
    const [pc, gc] = await Promise.all([
      prisma.publicationTopic.groupBy({
        by: ["cwid"],
        where: { cwid: { in: cwids } },
        _count: { pmid: true },
        orderBy: { cwid: "asc" },
      }) as unknown as Promise<PubGroupRow[]>,
      prisma.grant.groupBy({
        by: ["cwid"],
        where: { cwid: { in: cwids }, endDate: { gte: now } },
        _count: { _all: true },
        orderBy: { cwid: "asc" },
      }) as unknown as Promise<GrantGroupRow[]>,
    ]);
    pubCounts = pc;
    grantCounts = gc;
  }

  const pubMap = new Map<string, number>(pubCounts.map((r: PubGroupRow) => [r.cwid, r._count.pmid]));
  const grantMap = new Map<string, number>(grantCounts.map((r: GrantGroupRow) => [r.cwid, r._count._all]));

  const hits: DepartmentFacultyHit[] = allRows.map((s: ScholarRow) => ({
    cwid: s.cwid,
    preferredName: s.preferredName,
    slug: s.slug,
    primaryTitle: s.primaryTitle,
    divisionName: (s as ScholarRow & { division?: { name: string } | null }).division?.name ?? null,
    departmentName:
      (s as ScholarRow & { department?: { name: string } | null }).department?.name ??
      s.primaryDepartment ??
      "",
    identityImageEndpoint: identityImageEndpoint(s.cwid),
    roleCategory: normalizeRoleCategory(s.roleCategory),
    overview: s.overview ? s.overview.slice(0, 120).trimEnd() + (s.overview.length > 120 ? "…" : "") : null,
    pubCount: pubMap.get(s.cwid) ?? 0,
    grantCount: grantMap.get(s.cwid) ?? 0,
  }));

  return { hits, total, page, pageSize: FACULTY_PAGE_SIZE };
}
