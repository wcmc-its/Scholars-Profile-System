/**
 * Browse-hub data assembly.
 *
 * Exports:
 *   - getDepartmentsList():   one BrowseDepartment per dept, with category,
 *                             division chip-row, and top topic chips.
 *   - getCentersList():       one BrowseCenter per row in `center`.
 *   - getAZBuckets():         A-Z directory buckets, capped at 10 names per
 *                             letter. Consumed by /search empty-People state
 *                             (relocated from /browse per docs/browse-vs-search.md).
 *   - getBrowseData():        composite for /browse — runs departments and
 *                             centers in parallel.
 *
 * All callers are Server Components / ISR pages. Public-data only — no auth.
 */
import { prisma } from "@/lib/db";
import type {
  DepartmentCategory,
} from "@/lib/department-categories";

export type BrowseDepartmentDivisionChip = {
  code: string;
  name: string;
  slug: string;
};

export type BrowseDepartmentTopicChip = {
  topicId: string;
  topicLabel: string;
  topicSlug: string;
};

export type BrowseDepartment = {
  code: string;
  name: string;
  slug: string;
  category: DepartmentCategory;
  scholarCount: number;
  chairName: string | null;
  chairSlug: string | null;
  divisions: BrowseDepartmentDivisionChip[];
  topResearchAreas: BrowseDepartmentTopicChip[];
};

export type BrowseCenter = {
  code: string;
  name: string;
  slug: string;
  description: string | null;
  directorName: string | null;
  directorSlug: string | null;
  scholarCount: number;
  sortOrder: number;
};

export type AZScholar = {
  /** "{Last}, {First}" — last token of preferredName treated as surname. */
  name: string;
  slug: string;
  department: string;
};

export type AZBucket = {
  letter: string;
  count: number;
  scholars: AZScholar[];
};

export type BrowseData = {
  departments: BrowseDepartment[];
  centers: BrowseCenter[];
};

type DeptRow = {
  code: string;
  name: string;
  slug: string;
  category: string;
  scholarCount: number;
  chairCwid: string | null;
};

type ChairRow = {
  cwid: string;
  preferredName: string;
  slug: string;
};

type ScholarAZRow = {
  preferredName: string;
  slug: string;
  primaryDepartment: string | null;
};

const TOPIC_CHIP_LIMIT = 2;

export async function getDepartmentsList(): Promise<BrowseDepartment[]> {
  const depts = (await prisma.department.findMany({
    orderBy: { name: "asc" },
    select: {
      code: true,
      name: true,
      slug: true,
      category: true,
      scholarCount: true,
      chairCwid: true,
    },
  })) as DeptRow[];

  // --- Chairs ---
  const chairCwids = depts
    .map((d) => d.chairCwid)
    .filter((c): c is string => c !== null);
  const chairs: ChairRow[] =
    chairCwids.length > 0
      ? ((await prisma.scholar.findMany({
          where: { cwid: { in: chairCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })) as ChairRow[])
      : [];
  const chairMap = new Map(chairs.map((c) => [c.cwid, c]));

  // --- Divisions per dept ---
  const divisions = await prisma.division.findMany({
    where: { deptCode: { in: depts.map((d) => d.code) } },
    select: { code: true, deptCode: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });
  const divsByDept = new Map<string, BrowseDepartmentDivisionChip[]>();
  for (const d of divisions) {
    const list = divsByDept.get(d.deptCode) ?? [];
    list.push({ code: d.code, name: d.name, slug: d.slug });
    divsByDept.set(d.deptCode, list);
  }

  // --- Top research areas per dept ---
  // For each dept, find the top N parent topics by distinct PMID count among
  // dept-affiliated scholars. One raw query for all depts at once.
  type TopicRow = {
    dept_code: string;
    parent_topic_id: string;
    pub_count: number | bigint;
    rk: number | bigint;
  };
  const topicRows =
    depts.length === 0
      ? ([] as TopicRow[])
      : ((await prisma.$queryRawUnsafe(
          `SELECT * FROM (
             SELECT s.dept_code AS dept_code,
                    pt.parent_topic_id AS parent_topic_id,
                    COUNT(DISTINCT pt.pmid) AS pub_count,
                    ROW_NUMBER() OVER (
                      PARTITION BY s.dept_code
                      ORDER BY COUNT(DISTINCT pt.pmid) DESC
                    ) AS rk
               FROM publication_topic pt
               JOIN scholar s ON s.cwid = pt.cwid
              WHERE s.deleted_at IS NULL AND s.status = 'active'
                AND s.dept_code IS NOT NULL
              GROUP BY s.dept_code, pt.parent_topic_id
           ) ranked
           WHERE rk <= ${TOPIC_CHIP_LIMIT}`,
        )) as TopicRow[]);

  const topicIds = Array.from(
    new Set(topicRows.map((r) => r.parent_topic_id)),
  );
  const topicById =
    topicIds.length === 0
      ? new Map<string, { id: string; label: string }>()
      : new Map(
          (
            await prisma.topic.findMany({
              where: { id: { in: topicIds } },
              select: { id: true, label: true },
            })
          ).map((t) => [t.id, t]),
        );

  const topicsByDept = new Map<string, BrowseDepartmentTopicChip[]>();
  for (const r of topicRows) {
    const t = topicById.get(r.parent_topic_id);
    if (!t) continue;
    const list = topicsByDept.get(r.dept_code) ?? [];
    list.push({ topicId: t.id, topicLabel: t.label, topicSlug: t.id });
    topicsByDept.set(r.dept_code, list);
  }

  return depts.map<BrowseDepartment>((d) => {
    const cat = (d.category as DepartmentCategory) ?? "clinical";
    return {
      code: d.code,
      name: d.name,
      slug: d.slug,
      category: cat,
      scholarCount: d.scholarCount,
      chairName: d.chairCwid
        ? (chairMap.get(d.chairCwid)?.preferredName ?? null)
        : null,
      chairSlug: d.chairCwid
        ? (chairMap.get(d.chairCwid)?.slug ?? null)
        : null,
      // Administrative cards are lean: no division chips, no topic chips.
      divisions: cat === "administrative" ? [] : (divsByDept.get(d.code) ?? []),
      topResearchAreas:
        cat === "administrative" ? [] : (topicsByDept.get(d.code) ?? []),
    };
  });
}

export async function getCentersList(): Promise<BrowseCenter[]> {
  const centers = await prisma.center.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      code: true,
      name: true,
      slug: true,
      description: true,
      directorCwid: true,
      scholarCount: true,
      sortOrder: true,
    },
  });
  if (centers.length === 0) return [];

  const directorCwids = centers
    .map((c) => c.directorCwid)
    .filter((c): c is string => c !== null);
  const directors =
    directorCwids.length === 0
      ? ([] as ChairRow[])
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: directorCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })) as ChairRow[]);
  const directorMap = new Map(directors.map((d) => [d.cwid, d]));

  return centers.map((c) => ({
    code: c.code,
    name: c.name,
    slug: c.slug,
    description: c.description,
    directorName: c.directorCwid
      ? (directorMap.get(c.directorCwid)?.preferredName ?? null)
      : null,
    directorSlug: c.directorCwid
      ? (directorMap.get(c.directorCwid)?.slug ?? null)
      : null,
    scholarCount: c.scholarCount,
    sortOrder: c.sortOrder,
  }));
}

export async function getAZBuckets(): Promise<AZBucket[]> {
  const scholars = (await prisma.scholar.findMany({
    where: { deletedAt: null, status: "active" },
    select: {
      preferredName: true,
      slug: true,
      primaryDepartment: true,
    },
    orderBy: { preferredName: "asc" },
  })) as ScholarAZRow[];

  const bucketMap = new Map<string, AZScholar[]>();
  for (const s of scholars) {
    const tokens = s.preferredName.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const lastName = tokens[tokens.length - 1];
    const givenName = tokens.slice(0, -1).join(" ");
    const letter = lastName.charAt(0).toUpperCase();
    if (!letter || letter < "A" || letter > "Z") continue;
    if (!bucketMap.has(letter)) bucketMap.set(letter, []);
    bucketMap.get(letter)!.push({
      name: givenName ? `${lastName}, ${givenName}` : lastName,
      slug: s.slug,
      department: s.primaryDepartment ?? "",
    });
  }

  return Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, all]) => {
      const sorted = all.slice().sort((a, b) => a.name.localeCompare(b.name));
      return {
        letter,
        count: all.length,
        scholars: sorted.slice(0, 10),
      };
    });
}

export async function getBrowseData(): Promise<BrowseData> {
  const [departments, centers] = await Promise.all([
    getDepartmentsList(),
    getCentersList(),
  ]);
  return { departments, centers };
}
