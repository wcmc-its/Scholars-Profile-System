/**
 * Browse-hub data assembly (Phase 4).
 *
 * Three exported functions:
 *   - getDepartmentsList(): department cards for the Browse hub 3-col grid
 *   - getAZBuckets():       A-Z directory buckets, capped at 10 names per letter
 *   - getBrowseData():      composite — calls both in parallel, plus empty centers
 *
 * Centers & Institutes data does not yet exist in the schema (no Center model
 * — see RESEARCH.md §Common Pitfalls 4 + STATE.md deferred PHASE2-08).
 * `getBrowseData().centers` is always `[]`; the UI renders an empty-state
 * placeholder per UI-SPEC §6.4 + §7.
 *
 * All callers are Server Components / ISR pages. Public-data only — no auth.
 */
import { prisma } from "@/lib/db";

export type BrowseDepartment = {
  code: string;
  name: string;
  slug: string;
  scholarCount: number;
  chairName: string | null;
  chairSlug: string | null;
};

export type AZScholar = {
  /** "{Last}, {First}" — last token of preferredName treated as surname. */
  name: string;
  slug: string;
  department: string;
};

export type AZBucket = {
  letter: string;
  /** Total scholars under this letter — may exceed scholars.length when capped. */
  count: number;
  /** Capped at 10 (UI-SPEC §6.5). Sorted alphabetically by surname. */
  scholars: AZScholar[];
};

export type BrowseData = {
  departments: BrowseDepartment[];
  /** No Center model in schema; always []. UI renders empty-state. */
  centers: never[];
  azBuckets: AZBucket[];
};

type DeptRow = {
  code: string;
  name: string;
  slug: string;
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

export async function getDepartmentsList(): Promise<BrowseDepartment[]> {
  const depts = (await prisma.department.findMany({
    orderBy: { name: "asc" },
    select: {
      code: true,
      name: true,
      slug: true,
      scholarCount: true,
      chairCwid: true,
    },
  })) as DeptRow[];

  // Batch-fetch chair scholars in one query — same pattern as
  // lib/api/departments.ts getDepartment(). Skip query entirely
  // when no department has a chair.
  const chairCwids = depts
    .map((d: DeptRow) => d.chairCwid)
    .filter((c: string | null): c is string => c !== null);

  const chairs: ChairRow[] =
    chairCwids.length > 0
      ? ((await prisma.scholar.findMany({
          where: { cwid: { in: chairCwids } },
          select: { cwid: true, preferredName: true, slug: true },
        })) as ChairRow[])
      : [];

  const chairMap = new Map<string, ChairRow>(chairs.map((c: ChairRow) => [c.cwid, c]));

  return depts.map((d: DeptRow) => ({
    code: d.code,
    name: d.name,
    slug: d.slug,
    scholarCount: d.scholarCount,
    chairName: d.chairCwid
      ? (chairMap.get(d.chairCwid)?.preferredName ?? null)
      : null,
    chairSlug: d.chairCwid
      ? (chairMap.get(d.chairCwid)?.slug ?? null)
      : null,
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

  // Group by last-name initial. preferredName is "Given Family"
  // (LDAP convention) — split on space and treat the LAST token
  // as the surname. Hyphenated/multi-word surnames bucket on the
  // last token's initial; acceptable per RESEARCH.md Pitfall 1.
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
      // Sort by the display key ("LastName, GivenName") so the top-10 cap
      // always takes the alphabetically first 10 scholars within each letter,
      // not the first 10 by Prisma's preferredName ordering. CR-02.
      const sorted = all.slice().sort((a, b) => a.name.localeCompare(b.name));
      return {
        letter,
        count: all.length,
        scholars: sorted.slice(0, 10),
      };
    });
}

export async function getBrowseData(): Promise<BrowseData> {
  const [departments, azBuckets] = await Promise.all([
    getDepartmentsList(),
    getAZBuckets(),
  ]);
  return { departments, centers: [], azBuckets };
}
