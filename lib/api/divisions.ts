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
import { cache } from "react";
import { prisma } from "@/lib/db";
import { cachedRead } from "@/lib/api/swr-cache";
import { identityImageEndpoint } from "@/lib/headshot";
import {
  buildUnitGrantCards,
  loadUnitGrantProjects,
} from "@/lib/api/unit-grant-projects";
import type { DepartmentTopicArea } from "@/lib/api/departments";
import type { DeptPublicationCard } from "@/lib/api/dept-highlights";
import type {
  DeptListPubResult,
  DeptListGrantResult,
  PubSort,
  GrantSort,
} from "@/lib/api/dept-lists";
import type { AuthorChip } from "@/components/publication/author-chip-row";
import type { LeaderRole } from "@/components/scholar/leader-card";
import { formatRoleCategory } from "@/lib/role-display";
import { publicRoleWhere } from "@/lib/eligibility";
import { DIVISION_CHIEF_ROLE_KEY } from "@/lib/org-unit-roles";
import { resolveUnitLeader } from "@/lib/api/unit-leader";
import {
  isAuthorHidden,
  isUnitSuppressed,
  loadAllPublicationSuppressions,
  loadHiddenAuthorshipCounts,
  loadUnitFieldOverrides,
  mergeUnitFields,
  resolveUnitDarkPmids,
} from "@/lib/api/manual-layer";
import {
  aggregatePublicFamiliesForUnit,
  loadPublicFamiliesForMembers,
  ROSTER_ROW_METHODS_CAP,
  type MemberMethodFamily,
} from "@/lib/api/methods-roster";
import type { FacetOption } from "@/components/center/center-roster-facets";
import {
  isOrgUnitMethodsChipsEnabled,
  isOrgUnitMethodsFacetEnabled,
} from "@/lib/profile/methods-lens-flags";
import { extractLastNameSort } from "@/lib/name-sort";
import { isCornellDirectoryMembersEnabled } from "@/lib/edit/cornell-directory-flag";
import {
  buildExternalMemberHit,
  loadExternalMembersByCuid,
  type ExternalMemberHit,
} from "@/lib/api/external-members";

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
 *
 * DO NOT apply the #536 / #2202 role carve here. This loader is `cache()`d and
 * shared by six call sites — division stats, top research areas, the roster, the
 * publications list, the grants list and `lib/api/unit-members.ts`. Carving here
 * would silently drop student-authored publications and grants out of the
 * division's totals, which #718 explicitly retains. The carve belongs at the
 * PEOPLE-facing call sites: `getDivisionFacultyUncached` (roster) and the
 * `stats.scholars` count in `getDivisionUncached`.
 */
export const loadDivisionMemberCwids = cache(async (
  divCode: string,
  opts: { source?: string } = {},
): Promise<string[]> => {
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
});

export type DivisionChief = {
  cwid: string;
  preferredName: string;
  slug: string;
  chiefTitle: string;
  primaryTitle: string | null;
  identityImageEndpoint: string;
  /** Display label for the leader card — vocabulary-resolved (#2542 Phase D),
   *  so a steward rename of "Chief" shows up without a code change. Defaults
   *  to "Chief". */
  role: LeaderRole;
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
    /** #1021 — curated outbound website URL, or null. Rendered beside the name. */
    url: string | null;
  };
  parentDept: { code: string; name: string; slug: string };
  chief: DivisionChief | null;
  topResearchAreas: DepartmentTopicArea[];
  siblingDivisions: SiblingDivision[];
  stats: DivisionStats;
};

async function getDivisionUncached(
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

  // #540 — field-override merge over `description`, `url` (ADR-005 Amendment 1
  // § A1.1). `slug` is consumed by `etl/ed`, not merged here.
  // `leaderCwid`/`leaderInterim` are NOT merged into this object any more —
  // `resolveUnitLeader` below reads `overrides` directly, same rationale as
  // `lib/api/departments.ts` (#2542 Phase D).
  const overrides = await loadUnitFieldOverrides("division", division.code, prisma);
  const merged = mergeUnitFields(
    { description: division.description, url: division.url, leaderCwid: division.chiefCwid },
    overrides,
  );

  // Chief — three-state (#540 SPEC § 1): null = no row, "" = explicit vacancy,
  // non-empty = the curated CWID. The label comes from the vocabulary
  // (`OrgUnitRole.label`), falling back to "Chief" only if that row is
  // missing — see `resolveUnitLeader`.
  let chief: DivisionChief | null = null;
  const resolvedLeader = await resolveUnitLeader({
    entityType: "division",
    entityId: division.code,
    roleKey: DIVISION_CHIEF_ROLE_KEY,
    legacyLeaderCwid: division.chiefCwid,
    overrides,
    fallbackLabel: "Chief",
    client: prisma,
  });
  if (resolvedLeader) {
    const chiefScholar = await prisma.scholar.findUnique({
      where: { cwid: resolvedLeader.cwid },
      select: { cwid: true, preferredName: true, slug: true, primaryTitle: true },
    });
    if (chiefScholar) {
      const chiefAppt = await prisma.appointment.findFirst({
        where: {
          cwid: resolvedLeader.cwid,
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
        chiefTitle: chiefAppt?.title ?? resolvedLeader.roleLabel,
        primaryTitle: chiefScholar.primaryTitle,
        identityImageEndpoint: identityImageEndpoint(chiefScholar.cwid),
        role: resolvedLeader.roleLabel,
        isInterim: resolvedLeader.interim,
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

  const [pubCount, grantCount, visibleScholarCount] = await Promise.all([
    memberCwids.length === 0
      ? Promise.resolve(0)
      : (async () => {
          // #1505/#2119 — push membership into `publication.count` via an
          // `authors: { some }` relation filter instead of materializing every
          // distinct member pmid; invert suppression (see resolveUnitDarkPmids).
          // #356 — count only publications still visible (not taken down or
          // derived-dark).
          const membership = { cwid: { in: memberCwids } };
          const suppressions = await loadAllPublicationSuppressions(prisma);
          const unitDarkPmids = await resolveUnitDarkPmids(suppressions, membership, prisma);
          return prisma.publication.count({
            where: {
              authors: { some: { isConfirmed: true, ...membership } },
              ...(unitDarkPmids.length > 0 ? { pmid: { notIn: unitDarkPmids } } : {}),
            },
          });
        })(),
    // #2066 — count funding PROJECTS, not investigator-award rows, via the SAME
    // call `getDivisionGrantsList` paginates. Not "two implementations that
    // agree": one call, one number. #481(b) suppression is applied inside it.
    memberCwids.length === 0
      ? Promise.resolve(0)
      : loadUnitGrantProjects(
          {
            endDate: { gte: new Date() },
            cwid: { in: memberCwids },
            source: { not: "RePORTER" }, // exclude individual RePORTER history
          },
          "most_recent",
        ).then((projects) => projects.length),
    // #2202 — the hero "N scholars" and the Scholars tab label sit on the SAME
    // page as the roster, whose `total` now carries the #536 carve. `memberCwids`
    // is deliberately left uncarved above (it feeds the publication/grant totals,
    // which #718 retains), so the people count needs its own carved query rather
    // than `memberCwids.length`.
    memberCwids.length === 0
      ? Promise.resolve(0)
      : prisma.scholar.count({
          where: {
            cwid: { in: memberCwids },
            deletedAt: null,
            status: "active",
            ...publicRoleWhere(),
          },
        }),
  ]);

  // #2519 — Cornell members carry no `Scholar` row, so `visibleScholarCount`
  // above never sees them (no double-count risk). Add them to the headline
  // total so it agrees with the roster's rendered length (`getDivisionFaculty`).
  // Cornell adds are manual-division-only (the roster route's own gate), and
  // `DivisionMembership` has no active-window columns — every row counts.
  const cornellScholarCount =
    isCornellDirectoryMembersEnabled() && division.source === "manual"
      ? await prisma.divisionMembership.count({
          where: { divisionCode: division.code, source: "cornell-ithaca" },
        })
      : 0;

  return {
    division: {
      code: division.code,
      name: division.name,
      slug: division.slug,
      description: merged.description,
      // #1021 — empty-string override (curator cleared the link) reads as null.
      url: merged.url && merged.url !== "" ? merged.url : null,
    },
    parentDept: { code: dept.code, name: dept.name, slug: dept.slug },
    chief,
    topResearchAreas,
    siblingDivisions,
    stats: {
      scholars: visibleScholarCount + cornellScholarCount,
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
    /** Display LABEL (see DepartmentFacultyHit) — never feed it to a predicate. */
    roleCategory: string | null;
    /** Raw `scholar.role_category` for `isPubliclyDisplayed` (#2202). */
    roleCategoryRaw?: string | null;
    overview: string | null;
    pubCount: number;
    grantCount: number;
    /** #974 — top ≤3 PUBLIC method families for the per-row chips. Present only
     *  when ORG_UNIT_METHODS_CHIPS (+ METHODS_LENS_ENABLED) is on AND the member
     *  has ≥1 public family; undefined otherwise. */
    topMethods?: MemberMethodFamily[];
    /** #2519 — true only for a Cornell (Ithaca) external member. See
     *  `DepartmentFacultyHit.isExternal`. */
    isExternal?: true;
    /** #2519 — present only when `isExternal` is true. */
    externalProfileUrl?: string;
  }>;
  total: number;
  /** Whole-scope role-category counts for the role-chip-row. (#17) */
  roleCategoryCounts: Record<string, number>;
  page: number;
  pageSize: number;
  /** #974 Phase 2 — unit-wide PUBLIC method-family facet buckets (count-desc).
   *  Present (possibly empty) only when ORG_UNIT_METHODS_FACET (+
   *  METHODS_LENS_ENABLED) is on; undefined otherwise. */
  methodFacet?: FacetOption[];
};

async function getDivisionFacultyUncached(
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

  // #2519 — Cornell (Ithaca) render union. `DivisionMembership` has no
  // active-window columns (unlike `CenterMembership`) — every row is active
  // by presence — so this is a plain source-filtered read, no date filter.
  // Cornell adds are only ever written to a `source: 'manual'` division (the
  // roster route's own gate), so an ETL division never issues this query.
  // Flag off, or no cornell rows for this division ⇒ `cornellHits` is `[]`
  // and every branch below is byte-identical to today.
  let cornellHits: ExternalMemberHit[] = [];
  if (isCornellDirectoryMembersEnabled() && div?.source === "manual") {
    const cornellRows = await prisma.divisionMembership.findMany({
      where: { divisionCode: divCode, source: "cornell-ithaca" },
      select: { cwid: true },
    });
    if (cornellRows.length > 0) {
      const netids = cornellRows.map((r) => r.cwid);
      const externalByCuid = await loadExternalMembersByCuid(netids);
      cornellHits = netids
        .map((netid) => externalByCuid.get(netid))
        .filter((m): m is NonNullable<typeof m> => m !== undefined)
        .map((m) => buildExternalMemberHit(m));
    }
  }

  const allMemberCwids = await loadDivisionMemberCwids(divCode, {
    source: div?.source,
  });
  if (allMemberCwids.length === 0 && cornellHits.length === 0) {
    return { hits: [], total: 0, roleCategoryCounts: {}, page, pageSize: FACULTY_PAGE_SIZE };
  }

  // #2202 — apply the #536 carve HERE, at the roster call site, not inside the
  // `cache()`d `loadDivisionMemberCwids` (see its docstring: six call sites, four
  // of which must keep counting student-authored pubs/grants).
  //
  // Carving only `where` below would NOT be enough: `total` is derived from this
  // list, and so is the `methodFacet` member set. Leaving them on the uncarved
  // list would overcount the total and render phantom trailing pages — a
  // "Showing 481–500 of 590" that resolves to an empty list.
  const memberCwids = (
    await prisma.scholar.findMany({
      where: {
        cwid: { in: allMemberCwids },
        deletedAt: null,
        status: "active",
        ...publicRoleWhere(),
      },
      select: { cwid: true },
    })
  ).map((r) => r.cwid);
  const total = memberCwids.length;
  if (total === 0 && cornellHits.length === 0) {
    return { hits: [], total: 0, roleCategoryCounts: {}, page, pageSize: FACULTY_PAGE_SIZE };
  }
  const memberCwidSet = new Set(memberCwids);
  const where = {
    cwid: { in: memberCwids },
    deletedAt: null,
    status: "active" as const,
    // Redundant with the carved `memberCwids` above, and deliberately so: if a
    // future refactor re-widens that list, the row query still cannot load a
    // hidden identity class.
    ...publicRoleWhere(),
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
      // #2202 — `memberCwidSet` is already carved, so this can only match a
      // displayable chief; the carve is repeated so the query is self-describing
      // and survives a refactor of the set above.
      where: { cwid: chiefCwid, deletedAt: null, status: "active", ...publicRoleWhere() },
      include: includeClause,
    });
  }

  const restWhere = chiefRow ? { ...where, NOT: { cwid: chiefRow.cwid } } : where;
  const restTake = chiefRow ? FACULTY_PAGE_SIZE - 1 : FACULTY_PAGE_SIZE;
  const restSkip =
    chiefRow && page > 0 ? page * FACULTY_PAGE_SIZE - 1 : page * FACULTY_PAGE_SIZE;

  // The minimal shape `buildWcmHits` reads. A `scholar.findFirst`/`findMany`
  // call's inferred TS return type does not carry the `include`d relations
  // (a known Prisma/TS limitation when `where`/`include` are pre-declared
  // variables rather than inline literals) even though they ARE present at
  // runtime — hence the `(typeof rows)[number] & RowFields` cast at each call
  // site below, mirroring the pre-#2519 `RowWithRelations` pattern.
  type RowFields = {
    cwid: string;
    preferredName: string;
    slug: string;
    primaryTitle: string | null;
    overview: string | null;
    roleCategory: string | null;
    department: { name: string } | null;
    division: { name: string } | null;
  };

  /**
   * Pub/grant counts + top-method-family chips for a set of scholar rows.
   * Factored out (#2519) so the Cornell-merge branch below — which needs the
   * FULL matching set, not just the current DB page, to interleave correctly
   * — and the original page-window path share one implementation.
   */
  async function buildWcmHits<R extends RowFields>(rows: R[]) {
    const rowCwids = rows.map((r) => r.cwid);
    const [pubCounts, grantCounts] = await Promise.all([
      rowCwids.length === 0
        ? Promise.resolve([] as Array<{ cwid: string; _count: { _all: number } }>)
        : (prisma.publicationAuthor.groupBy as unknown as (
            args: unknown,
          ) => Promise<Array<{ cwid: string; _count: { _all: number } }>>)({
            by: ["cwid"],
            where: { isConfirmed: true, cwid: { in: rowCwids } },
            _count: { _all: true },
            orderBy: { cwid: "asc" },
          }),
      rowCwids.length === 0
        ? Promise.resolve([] as Array<{ cwid: string; _count: { _all: number } }>)
        : (prisma.grant.groupBy as unknown as (
            args: unknown,
          ) => Promise<Array<{ cwid: string; _count: { _all: number } }>>)({
            by: ["cwid"],
            where: { cwid: { in: rowCwids }, source: { not: "RePORTER" } },
            _count: { _all: true },
            orderBy: { cwid: "asc" },
          }),
    ]);
    // #356 — subtract each scholar's per-author hides from their pub count.
    const hiddenCounts = await loadHiddenAuthorshipCounts(rowCwids, prisma);
    const pubByCwid = new Map(
      pubCounts.map((r) => [
        r.cwid,
        Math.max(0, r._count._all - (hiddenCounts.get(r.cwid) ?? 0)),
      ]),
    );
    const grantByCwid = new Map(grantCounts.map((r) => [r.cwid, r._count._all]));

    const rowHits = rows.map((r) => ({
      cwid: r.cwid,
      preferredName: r.preferredName,
      slug: r.slug,
      primaryTitle: r.primaryTitle,
      divisionName: r.division?.name ?? null,
      departmentName: r.department?.name ?? "",
      identityImageEndpoint: identityImageEndpoint(r.cwid),
      // #974 Phase 2 — normalize to the display label (mirrors departments.ts L480 +
      // the filtered API in unit-members.ts) so the Role chip actually matches on the
      // division SSR view, not just after a method is selected. (roleCategoryCounts at
      // L386 already normalizes; the hit was the lone raw outlier.)
      roleCategory: formatRoleCategory(r.roleCategory),
      // #2202 — the label above is display-only; the #536 carve reads this.
      roleCategoryRaw: r.roleCategory,
      overview: r.overview ? r.overview.slice(0, 120) : null,
      pubCount: pubByCwid.get(r.cwid) ?? 0,
      grantCount: grantByCwid.get(r.cwid) ?? 0,
    }));

    // #974 — attach top-≤3 PUBLIC method families for the per-row chips. The
    // loader self-gates on the flag, so off → empty map → hits pass through
    // byte-identical.
    const famByCwid = await loadPublicFamiliesForMembers(rowCwids, {
      enabled: isOrgUnitMethodsChipsEnabled(),
    });
    return famByCwid.size === 0
      ? rowHits
      : rowHits.map((h) => {
          const fams = famByCwid.get(h.cwid);
          return fams && fams.length > 0
            ? { ...h, topMethods: fams.slice(0, ROSTER_ROW_METHODS_CAP) }
            : h;
        });
  }

  // #974 Phase 2 — unit-wide "Methods & tools" facet buckets over the FULL active
  // member set. `memberCwids` is already in hand (loaded above for the roster), so
  // this path is cheaper than the dept path — no extra cwid query. Flag-gated:
  // off → `aggregatePublicFamiliesForUnit` short-circuits, `methodFacet` undefined
  // → off-path payload byte-identical, page stays CloudFront-cacheable.
  const methodFacet = isOrgUnitMethodsFacetEnabled()
    ? await aggregatePublicFamiliesForUnit(memberCwids, { enabled: true })
    : undefined;

  if (cornellHits.length === 0) {
    // Byte-identical to pre-#2519 behavior: DB-level skip/take pagination,
    // preferredName-asc DB order, no merge/re-sort.
    const rest = await prisma.scholar.findMany({
      where: restWhere,
      skip: Math.max(0, restSkip),
      take: restTake,
      orderBy: [{ preferredName: "asc" }],
      include: includeClause,
    });
    const allRows = chiefRow ? [chiefRow, ...rest] : rest;
    const finalHits = await buildWcmHits(
      allRows as ((typeof allRows)[number] & RowFields)[],
    );
    return {
      hits: finalHits,
      total,
      roleCategoryCounts,
      page,
      pageSize: FACULTY_PAGE_SIZE,
      methodFacet,
    };
  }

  // #2519 — Cornell present: fetch every matching WCM row (not just this DB
  // page) so the two sources interleave correctly by surname across page
  // boundaries, matching the public-roster convention (`extractLastNameSort`,
  // same helper `lib/api/centers.ts`'s flat roster uses). Only this
  // flag-gated, Cornell-populated path pays the extra cost — every other
  // division keeps the cheap skip/take query above untouched.
  const allRest = await prisma.scholar.findMany({
    where: restWhere,
    orderBy: [{ preferredName: "asc" }],
    include: includeClause,
  });
  const allRowsFull = chiefRow ? [chiefRow, ...allRest] : allRest;
  const wcmHitsFull = await buildWcmHits(
    allRowsFull as ((typeof allRowsFull)[number] & RowFields)[],
  );

  const chiefHit = chiefRow
    ? wcmHitsFull.find((h) => h.cwid === chiefRow!.cwid)
    : undefined;
  const restHits = chiefRow
    ? wcmHitsFull.filter((h) => h.cwid !== chiefRow!.cwid)
    : wcmHitsFull;
  const mergedRest = [...restHits, ...cornellHits].sort(
    (a, b) =>
      extractLastNameSort(a.preferredName).localeCompare(
        extractLastNameSort(b.preferredName),
      ) || a.preferredName.localeCompare(b.preferredName),
  );
  const mergedAll = chiefHit ? [chiefHit, ...mergedRest] : mergedRest;
  const mergedTotal = mergedAll.length;
  const pageHits = mergedAll.slice(
    page * FACULTY_PAGE_SIZE,
    (page + 1) * FACULTY_PAGE_SIZE,
  );

  return {
    hits: pageHits,
    total: mergedTotal,
    roleCategoryCounts,
    page,
    pageSize: FACULTY_PAGE_SIZE,
    methodFacet,
  };
}

async function getDivisionPublicationsListUncached(
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

  // #1505/#2119 — push division membership into the page query/count via an
  // `authors: { some }` relation filter instead of materializing every distinct
  // member pmid; invert suppression (see resolveUnitDarkPmids). #356 — total
  // and the page window are both computed over this visible set.
  const membership = { cwid: { in: memberCwids } };
  const suppressions = await loadAllPublicationSuppressions(prisma);
  const unitDarkPmids = await resolveUnitDarkPmids(suppressions, membership, prisma);
  const visibleWhere = {
    authors: { some: { isConfirmed: true, ...membership } },
    ...(unitDarkPmids.length > 0 ? { pmid: { notIn: unitDarkPmids } } : {}),
  };
  const total = await prisma.publication.count({ where: visibleWhere });
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: PUB_PAGE_SIZE };
  }

  const orderBy =
    sort === "most_cited"
      ? [{ citationCount: "desc" as const }, { pmid: "asc" as const }]
      : [{ dateAddedToEntrez: "desc" as const }, { pmid: "asc" as const }];

  const pubs = await prisma.publication.findMany({
    where: visibleWhere,
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

async function getDivisionGrantsListUncached(
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
    source: { not: "RePORTER" }, // exclude individual RePORTER history
  };

  // #2066 — ONE card per funding PROJECT via the SAME call the division hero stat
  // makes, so `total` here and "N active grants" there cannot disagree. (They
  // already could before: this loader returned a ROW count from
  // `resolveActiveGrantSuppression` while the dept twin returned a GROUP count.)
  // #160/#481(b) suppression is applied inside, before grouping.
  const sortedGroups = await loadUnitGrantProjects(baseWhere, sort);
  const total = sortedGroups.length;
  if (total === 0) {
    return { hits: [], total: 0, page, pageSize: GRANT_PAGE_SIZE };
  }
  const pageSlice = sortedGroups.slice(
    page * GRANT_PAGE_SIZE,
    (page + 1) * GRANT_PAGE_SIZE,
  );

  // #2066 — the SAME card assembly the department tab uses. This tail used to be
  // a near-verbatim copy of `lib/api/dept-lists.ts` that had already drifted:
  // the chip fallback listed EVERY cwid where the dept listed one (harmless
  // while the key embedded the cwid, N chips once cards group by project), and
  // the scholar lookup omitted `deletedAt: null`. Nothing is passed per-surface:
  // this tab and the department's render the same `GrantCard`.
  const hits = await buildUnitGrantCards(pageSlice);

  return { hits, total, page, pageSize: GRANT_PAGE_SIZE };
}

// --- Cached public wrappers (viewer-independent reads via lib/api/swr-cache;
//     mirrors the center-page caching in lib/api/centers.ts). The cache() on
//     loadDivisionMemberCwids above dedups its ~6 calls within one render. ---
export const getDivision = (deptSlug: string, divSlug: string) =>
  cachedRead(`division:detail:${deptSlug}:${divSlug}`, () =>
    getDivisionUncached(deptSlug, divSlug),
  );

export const getDivisionFaculty = (divCode: string, opts: { page?: number }) =>
  cachedRead(`division:faculty:${divCode}:${Math.max(0, opts.page ?? 0)}`, () =>
    getDivisionFacultyUncached(divCode, opts),
  );

export const getDivisionPublicationsList = (
  divCode: string,
  opts: { page?: number; sort?: PubSort } = {},
) =>
  cachedRead(
    `division:pubs:${divCode}:${Math.max(0, opts.page ?? 0)}:${opts.sort ?? "newest"}`,
    () => getDivisionPublicationsListUncached(divCode, opts),
  );

export const getDivisionGrantsList = (
  divCode: string,
  opts: { page?: number; sort?: GrantSort } = {},
) =>
  cachedRead(
    `division:grants:${divCode}:${Math.max(0, opts.page ?? 0)}:${opts.sort ?? "most_recent"}`,
    () => getDivisionGrantsListUncached(divCode, opts),
  );
