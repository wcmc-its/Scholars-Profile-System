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
import { extractLastNameSort } from "@/lib/name-sort";
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
import {
  isAuthorHidden,
  isUnitSuppressed,
  loadPublicationSuppressions,
  resolveActiveGrantSuppression,
  resolveDarkPmids,
} from "@/lib/api/manual-layer";
import {
  loadPublicFamiliesForMembers,
  ROSTER_ROW_METHODS_CAP,
  type MemberMethodFamily,
} from "@/lib/api/methods-roster";
import { isCenterMethodsFacetEnabled } from "@/lib/profile/methods-lens-flags";

/**
 * #552 § 3.3 — the load-bearing membership active predicate. A membership is
 * active when today falls within `[startDate, endDate]`, both ends inclusive,
 * with a null bound treated as open. This mirrors the editor's `statusOf`
 * (`components/edit/center-roster-card.tsx`) exactly: `today` is a `YYYY-MM-DD`
 * string and the `@db.Date` bounds are compared as their UTC date strings, so
 * the date-only columns never get mis-compared against a time-carrying instant.
 */
export function isCenterMembershipActive(
  startDate: Date | null,
  endDate: Date | null,
  today: string,
): boolean {
  const start = startDate ? startDate.toISOString().slice(0, 10) : null;
  const end = endDate ? endDate.toISOString().slice(0, 10) : null;
  if (start && start > today) return false; // pending
  if (end && end < today) return false; // inactive
  return true;
}

/** UTC date string for "now", matching the editor's `todayIso`. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Active CWID set for a center's public surfaces. Reads the membership rows,
 * keeps only those active per § 3.3 (a center's roster is small, so the
 * date filter is an in-memory scan), then filters the survivors through
 * `Scholar` (non-deleted + `status='active'`) so a dormant or soft-deleted
 * scholar never surfaces — edge 10, and the same `Scholar` gate Phase 8's
 * `loadDivisionMemberCwids` applies. Every public center read funnels through
 * this so the page, stats, highlights, topics, publications, grants and
 * spotlight all agree on who counts.
 */
export async function loadActiveCenterMemberCwids(
  centerCode: string,
): Promise<string[]> {
  const today = todayIso();
  const rows = (await prisma.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true, startDate: true, endDate: true },
  })) as Array<{ cwid: string; startDate: Date | null; endDate: Date | null }>;
  const activeCwids = rows
    .filter((r) => isCenterMembershipActive(r.startDate, r.endDate, today))
    .map((r) => r.cwid);
  if (activeCwids.length === 0) return [];
  const scholars = await prisma.scholar.findMany({
    where: { cwid: { in: activeCwids }, deletedAt: null, status: "active" },
    select: { cwid: true },
  });
  return scholars.map((s) => s.cwid);
}

export type CenterDetail = {
  code: string;
  name: string;
  slug: string;
  description: string | null;
  /** #1021 — curated outbound website URL, or null. Rendered beside the name. */
  url: string | null;
  director: {
    cwid: string;
    preferredName: string;
    primaryTitle: string | null;
    slug: string;
    identityImageEndpoint: string;
    /** Interim/acting qualifier — the in-row `Center.leaderInterim` column
     *  (centers edit fields in-row; no `field_override` merge). #540 / ADR-005
     *  Amendment 1 § A1.1. */
    isInterim: boolean;
  } | null;
  scholarCount: number;
};

/** Research vs clinical membership flavor (#552). Null on legacy/unclassified
 *  rows and on members of centers without a program taxonomy. */
export type CenterMembershipType = "research" | "clinical";

/**
 * @deprecated #962 alias — the type was hoisted to `lib/api/methods-roster` as
 * `MemberMethodFamily` (#974, now shared with the dept/division rosters). Kept as
 * a re-export so existing `@/lib/api/centers` importers keep resolving.
 */
export type CenterMemberFamily = MemberMethodFamily;

/** A center member — a department faculty hit plus the center-specific
 *  classification (#552) the facet sidebar + per-row badge consume. */
export type CenterMemberHit = DepartmentFacultyHit & {
  membershipType: CenterMembershipType | null;
  /** #962 — ALL public method families for this member, pmidCount desc. Facet
   *  membership reads this set. Present only when CENTER_METHODS_FACET is on AND
   *  the member has ≥1 public family; undefined otherwise (so the OFF-path payload
   *  carries nothing — no SEO leak). */
  methodFamilies?: CenterMemberFamily[];
  /** #962 — top-N (≤3) of `methodFamilies` for the compact per-row chips. */
  topMethods?: CenterMemberFamily[];
};

/** A program section on the public roster (#552 § 6.2). */
export type CenterMemberGroup = {
  label: string;
  members: CenterMemberHit[];
};

/**
 * #552 Phase 4 — the public roster is either a flat, paginated list (centers
 * with no program taxonomy, today's behavior) or a single page of all active
 * members grouped under program-label headers (programmed centers). The two
 * shapes are discriminated by `mode` so the page renders each correctly.
 */
export type CenterMembersResult =
  | {
      mode: "flat";
      hits: CenterMemberHit[];
      total: number;
      page: number;
      pageSize: number;
    }
  | {
      mode: "grouped";
      groups: CenterMemberGroup[];
      total: number;
    };

const MEMBERS_PAGE_SIZE = 20;

type CenterRow = {
  code: string;
  name: string;
  slug: string;
  description: string | null;
  url: string | null;
  directorCwid: string | null;
  leaderInterim: boolean;
};

export async function getCenter(slug: string): Promise<CenterDetail | null> {
  const center = (await prisma.center.findUnique({
    where: { slug },
    select: {
      code: true,
      name: true,
      slug: true,
      description: true,
      url: true,
      directorCwid: true,
      leaderInterim: true,
    },
  })) as CenterRow | null;
  if (!center) return null;

  // #540 — a retired (whole-unit-suppressed) center is a 404. Centers edit
  // their fields in-row, so no `field_override` merge happens here.
  if (await isUnitSuppressed("center", center.code, prisma)) return null;

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
        isInterim: center.leaderInterim,
      };
    }
  }

  // #552 Phase 4 — the header/tab "scholars" count reflects the active roster
  // (§ 3.3), not the denormalized `center.scholar_count` seed column, so a
  // lapsed member drops out of the count just as they drop off the roster.
  const scholarCount = (await loadActiveCenterMemberCwids(center.code)).length;

  return {
    code: center.code,
    name: center.name,
    slug: center.slug,
    description: center.description,
    url: center.url,
    director,
    scholarCount,
  };
}

type CenterScholarRow = {
  cwid: string;
  preferredName: string;
  slug: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  roleCategory: string | null;
  overview: string | null;
  department: { name: string } | null;
  division: { name: string } | null;
};

/** Hydrate scholar rows into `DepartmentFacultyHit`s with pub/grant counts. */
async function buildCenterMemberHits(
  rows: CenterScholarRow[],
): Promise<DepartmentFacultyHit[]> {
  const cwids = rows.map((s) => s.cwid);
  const now = new Date();
  const [pubCounts, grantRows] = cwids.length > 0
    ? await Promise.all([
        prisma.publicationTopic.groupBy({
          by: ["cwid"],
          where: { cwid: { in: cwids } },
          _count: { pmid: true },
        }) as unknown as Promise<Array<{ cwid: string; _count: { pmid: number } }>>,
        prisma.grant.findMany({
          where: { cwid: { in: cwids }, endDate: { gte: now } },
          select: { cwid: true, externalId: true, id: true },
        }) as Promise<
          Array<{ cwid: string; externalId: string | null; id: string }>
        >,
      ])
    : [[], []];

  const pubMap = new Map(pubCounts.map((p) => [p.cwid, p._count.pmid]));

  // #481(b) — exclude #160-suppressed grants from the per-faculty badge so a
  // hidden grant never inflates the count, keeping the roster badge in agreement
  // with getCenterGrantsList and its total (which already drop suppressed rows).
  // Same per-investigator `externalId` keying as resolveActiveGrantSuppression.
  const suppressed =
    grantRows.length > 0
      ? (await resolveActiveGrantSuppression(grantRows, prisma)).suppressed
      : new Set<string>();
  const grantMap = new Map<string, number>();
  for (const g of grantRows) {
    if (g.externalId !== null && suppressed.has(g.externalId)) continue;
    grantMap.set(g.cwid, (grantMap.get(g.cwid) ?? 0) + 1);
  }

  return rows.map((s) => ({
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
}

/**
 * Returns the active members of a center (§ 3.3), shaped as
 * `DepartmentFacultyHit` so `PersonRow` / `RoleChipRow` work unchanged.
 * `divisionName` is null on center members; `departmentName` falls back to the
 * scholar's `primaryDepartment` text when no FK department is resolved
 * (auto-promoted departments may have null deptCode for unmatched names). A
 * center with a program taxonomy and ≥1 programmed active member returns a
 * grouped, single-page shape (§ 6.2); otherwise a flat paginated list.
 */
export async function getCenterMembers(
  centerCode: string,
  opts: { page?: number } = {},
): Promise<CenterMembersResult> {
  const page = Math.max(0, opts.page ?? 0);
  const today = todayIso();
  const emptyFlat = {
    mode: "flat" as const,
    hits: [] as CenterMemberHit[],
    total: 0,
    page,
    pageSize: MEMBERS_PAGE_SIZE,
  };

  // §3.3 active filter — read every membership, keep the active ones, and
  // remember each one's program (grouping) + membership type (facet/badge).
  const memberships = (await prisma.centerMembership.findMany({
    where: { centerCode },
    select: {
      cwid: true,
      membershipType: true,
      programCode: true,
      startDate: true,
      endDate: true,
    },
  })) as Array<{
    cwid: string;
    membershipType: CenterMembershipType | null;
    programCode: string | null;
    startDate: Date | null;
    endDate: Date | null;
  }>;
  const activeMemberships = memberships.filter((m) =>
    isCenterMembershipActive(m.startDate, m.endDate, today),
  );
  const activeCwids = activeMemberships.map((m) => m.cwid);
  if (activeCwids.length === 0) return emptyFlat;

  // Per-cwid membership type, attached to each hit so the facet sidebar +
  // row badge don't need a second query.
  const membershipTypeByCwid = new Map<string, CenterMembershipType | null>();
  for (const m of activeMemberships) {
    membershipTypeByCwid.set(m.cwid, m.membershipType);
  }
  const attachType = (hs: DepartmentFacultyHit[]): CenterMemberHit[] =>
    hs.map((h) => ({
      ...h,
      membershipType: membershipTypeByCwid.get(h.cwid) ?? null,
    }));

  // #962 — layer PUBLIC method families onto already-built hits (GROUPED path
  // only). The surface flag is passed to the (hoisted) loader: when off the fetch
  // is a no-op (empty map) and the hits pass through byte-identical to today, so
  // no `if (flag)` branch is needed at the call site.
  const attachMethods = async (hits: CenterMemberHit[]): Promise<CenterMemberHit[]> => {
    const famByCwid = await loadPublicFamiliesForMembers(hits.map((h) => h.cwid), {
      enabled: isCenterMethodsFacetEnabled(),
    });
    if (famByCwid.size === 0) return hits; // flag off OR no public families
    return hits.map((h) => {
      const families = famByCwid.get(h.cwid);
      if (!families || families.length === 0) return h;
      return {
        ...h,
        methodFamilies: families,
        topMethods: families.slice(0, ROSTER_ROW_METHODS_CAP),
      };
    });
  };

  // edge 10 — drop dormant / soft-deleted scholars from the public roster.
  const scholars = (await prisma.scholar.findMany({
    where: { cwid: { in: activeCwids }, deletedAt: null, status: "active" },
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
  })) as CenterScholarRow[];
  // Order by surname, then full name (last-name-first), matching the People
  // search "Last name (A–Z)" sort. `preferredName` is "Given … Last", so the
  // DB's name sort would order by first name; re-sort by the extracted surname.
  scholars.sort(
    (a, b) =>
      extractLastNameSort(a.preferredName).localeCompare(
        extractLastNameSort(b.preferredName),
      ) || a.preferredName.localeCompare(b.preferredName),
  );
  const total = scholars.length;
  if (total === 0) return emptyFlat;

  // Is this a programmed center with at least one active programmed member?
  // (§6.2 / edge 9 — zero programmed actives renders flat, never an empty
  //  taxonomy.) Only then do we group.
  const programByCwid = new Map<string, string | null>();
  for (const m of activeMemberships) programByCwid.set(m.cwid, m.programCode);
  const programs = (await prisma.centerProgram.findMany({
    where: { centerCode },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    select: { code: true, label: true },
  })) as Array<{ code: string; label: string }>;
  const programmed =
    programs.length > 0 &&
    scholars.some((s) => programByCwid.get(s.cwid) != null);

  if (!programmed) {
    // Flat, paginated list — today's behavior for unprogrammed centers.
    const pageRows = scholars.slice(
      page * MEMBERS_PAGE_SIZE,
      (page + 1) * MEMBERS_PAGE_SIZE,
    );
    const hits = attachType(await buildCenterMemberHits(pageRows));
    return { mode: "flat", hits, total, page, pageSize: MEMBERS_PAGE_SIZE };
  }

  // Grouped: all active members on one page (#552 §6.2; decision: grouped =
  // single page). Members bucket under their program in (sortOrder, label)
  // order; anything not placed in a program (null program, or a stale code)
  // falls into an "Other" group rendered last, header only if non-empty
  // (edge 8).
  // #962 — GROUPED path only: attach public method families for the facet +
  // chips. (The flat path above is left untouched, scope constraint C.)
  const hits = await attachMethods(attachType(await buildCenterMemberHits(scholars)));
  const hitByCwid = new Map(hits.map((h) => [h.cwid, h]));
  const placed = new Set<string>();
  const groups: CenterMemberGroup[] = [];
  for (const p of programs) {
    const members = scholars
      .filter((s) => programByCwid.get(s.cwid) === p.code)
      .map((s) => hitByCwid.get(s.cwid))
      .filter((h): h is CenterMemberHit => Boolean(h));
    if (members.length > 0) {
      members.forEach((h) => placed.add(h.cwid));
      groups.push({ label: p.label, members });
    }
  }
  const other = hits.filter((h) => !placed.has(h.cwid));
  if (other.length > 0) groups.push({ label: "Other", members: other });

  return { mode: "grouped", groups, total };
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

  const memberCwids = await loadActiveCenterMemberCwids(centerCode);
  if (memberCwids.length === 0) {
    return { hits: [], total: 0, page, pageSize: PUB_PAGE_SIZE };
  }

  const pmidRows = (await prisma.publicationAuthor.findMany({
    where: { isConfirmed: true, cwid: { in: memberCwids } },
    select: { pmid: true },
    distinct: ["pmid"],
  })) as Array<{ pmid: string }>;
  const poolPmids = pmidRows.map((r) => r.pmid);
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

const GRANT_PAGE_SIZE = 20;

/**
 * Top research areas computed from the center's member-authored work.
 * Returns up to 3 topic chips ranked by distinct PMID count.
 */
export async function getCenterTopResearchAreas(
  centerCode: string,
): Promise<DepartmentTopicArea[]> {
  const memberCwids = await loadActiveCenterMemberCwids(centerCode);
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
  const memberCwids = await loadActiveCenterMemberCwids(centerCode);
  if (memberCwids.length === 0) {
    return { publications: [], grants: [] };
  }

  // Top 3 publications by citation × recency among member-authored work.
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

  type Sl = { cwid: string; preferredName: string; slug: string; roleCategory: string | null };
  const allCwids = Array.from(
    new Set(pubs.flatMap((p) => p.authors.map((a) => a.cwid!))),
  );
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
          select: { cwid: true, preferredName: true, slug: true, roleCategory: true },
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

export async function getCenterGrantsList(
  centerCode: string,
  opts: { page?: number; sort?: GrantSort } = {},
): Promise<DeptListGrantResult> {
  const page = Math.max(0, opts.page ?? 0);
  const sort: GrantSort = opts.sort ?? "most_recent";
  const memberCwids = await loadActiveCenterMemberCwids(centerCode);
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

  type Sl = { cwid: string; preferredName: string; slug: string; roleCategory: string | null };
  const cwids = Array.from(new Set(pageSlice.flatMap((g) => g.cwids)));
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
