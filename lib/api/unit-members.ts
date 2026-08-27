/**
 * #974 Phase 2 / #2537 — one page of DEPARTMENT/DIVISION roster members filtered
 * by ≥1 of the SELECTED public method families, by a role-category GROUP, or
 * both (AND across the two facets). Backs the uncacheable
 * `/api/units/[kind]/[code]/members` route (the page itself stays CloudFront-
 * cacheable; only this `force-dynamic` route does per-request filtering).
 *
 * Two independent filter paths, chosen by whether `methodKeys` is non-empty:
 *
 *   TYPE-ONLY (#2537, `filter.roleGroup` set, no methods): filters the unit's
 *   member cwids directly by `roleCategory: { in: groupToRawValues(roleGroup) }`
 *   AND `publicRoleWhere()`. Paginated/ordered by the SAME cwid-sort-then-
 *   preferredName-resort convention as the methods path below (see (4)), so the
 *   two filter modes agree on pagination semantics.
 *
 *   METHODS (methods-only, or methods+type combined) — steps:
 *   (1) Resolve the unit's FULL active member CWIDs — department via a cheap
 *       `scholar.findMany`; division via `loadDivisionMemberCwids` (which also
 *       unions the manual `DivisionMembership` roster + re-gates on active).
 *   (2) Re-derive `(supercategory, familyLabel)` pairs from the `sc::label` keys
 *       and DROP any that are NOT public under the overlay gate — a tampered
 *       `?method=` for a suppressed/#801-sensitive family can never select a
 *       non-public family (HARD CONSTRAINT A: never query a non-public family).
 *   (3) `scholarFamily.findMany` with an OR over the public pairs (OR within the
 *       facet), `distinct: ["cwid"]` → the filtered member set. A `roleGroup`
 *       (combined filter) nests its `roleCategory: { in }` condition INSIDE the
 *       `scholar:` relation filter alongside `publicRoleWhere()` — NOT at the top
 *       level, which already owns `OR: publicPairs` (#2202 note below).
 *   (4) Paginate that set (20/page) and assemble the same `DepartmentFacultyHit[]`
 *       shape the SSR roster returns, including the public-gated `topMethods` chips
 *       (reusing `loadPublicFamiliesForMembers`, the Phase-1 chip loader). A
 *       `roleGroup` is re-applied inside `buildHits`' own row query too (#2537 —
 *       same "carry the guard itself" posture as the #2202 carve below it: rows
 *       must agree with `total` even if they only trusted the caller's cwid list).
 *
 * Server-only (Prisma + server-only overlay/flag helpers); never import into a
 * client component.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { formatRoleCategory } from "@/lib/role-display";
import { groupToRawValues, type RoleGroupLabel } from "@/lib/role-groups";
import { publicRoleWhere } from "@/lib/eligibility";
import { loadDivisionMemberCwids } from "@/lib/api/divisions";
import type { DepartmentFacultyHit } from "@/lib/api/departments";
import {
  isFamilyPubliclyVisible,
  loadFamilyOverlayGate,
} from "@/lib/api/methods-overlay";
import {
  loadPublicFamiliesForMembers,
  ROSTER_ROW_METHODS_CAP,
} from "@/lib/api/methods-roster";

const FACULTY_PAGE_SIZE = 20;

export type UnitMembersByMethodsResult = {
  hits: DepartmentFacultyHit[];
  total: number;
  /** 0-indexed, matching the uncacheable route's `?page=` convention. */
  page: number;
  pageSize: number;
};

/** #2537 — one or both facets. `methodKeys` empty + `roleGroup` set is the
 *  type-only path; `methodKeys` non-empty + `roleGroup` set is the combined
 *  path; `methodKeys` non-empty alone is the original #974 methods-only path. */
export type UnitMemberFilter = {
  methodKeys?: string[];
  roleGroup?: RoleGroupLabel;
};

/** @deprecated #2537 — sibling of `getUnitMembersFiltered({ methodKeys }, page)`,
 *  kept so existing callers/tests of the methods-only path keep resolving. */
export async function getUnitMembersByMethods(
  kind: "department" | "division",
  code: string,
  methodKeys: string[],
  page: number,
): Promise<UnitMembersByMethodsResult> {
  return getUnitMembersFiltered(kind, code, { methodKeys }, page);
}

export async function getUnitMembersFiltered(
  kind: "department" | "division",
  code: string,
  filter: UnitMemberFilter,
  page: number,
): Promise<UnitMembersByMethodsResult> {
  const safePage = Math.max(0, page);
  const empty: UnitMembersByMethodsResult = {
    hits: [],
    total: 0,
    page: safePage,
    pageSize: FACULTY_PAGE_SIZE,
  };
  const methodKeys = filter.methodKeys ?? [];
  const roleRawValues = filter.roleGroup ? groupToRawValues(filter.roleGroup) : undefined;
  // A `roleGroup` that resolves to no raw values (e.g. "All", or a future
  // unrecognized label) can never match anything — the route validates against
  // `FILTERABLE_ROLE_GROUPS` before calling in, but fail safe here too rather
  // than silently falling through to an unfiltered query.
  if (filter.roleGroup && (!roleRawValues || roleRawValues.length === 0)) return empty;
  // Nothing to filter on at all — the route always supplies ≥1 of methods/type,
  // but fail safe rather than issue an unfiltered `roleCategory: { in: undefined }`.
  if (methodKeys.length === 0 && !filter.roleGroup) return empty;

  // (1) Full active member cwids for the unit.
  // #2202 edit 1 of 3 — the department branch carves here. The division branch
  // CANNOT: `loadDivisionMemberCwids` is `cache()`d and shared with the pubs /
  // grants / topics loaders, which must keep counting student-authored output
  // (#718). Step (3) below re-gates BOTH kinds through the `scholar:` relation
  // filter, so a division's hidden members are dropped there instead.
  const memberCwids =
    kind === "division"
      ? await loadDivisionMemberCwids(code)
      : (
          await prisma.scholar.findMany({
            where: {
              deptCode: code,
              deletedAt: null,
              status: "active",
              ...publicRoleWhere(),
            },
            select: { cwid: true },
          })
        ).map((r) => r.cwid);
  if (memberCwids.length === 0) return empty;

  if (methodKeys.length === 0) {
    // #2537 TYPE-ONLY path: filter the member cwids directly by role-category
    // group. `roleRawValues` is guaranteed non-empty here (checked above).
    const matchRows = (await prisma.scholar.findMany({
      where: {
        cwid: { in: memberCwids },
        deletedAt: null,
        status: "active",
        roleCategory: { in: roleRawValues },
        ...publicRoleWhere(),
      },
      select: { cwid: true },
    })) as Array<{ cwid: string }>;
    return paginateAndBuild(matchRows.map((r) => r.cwid), safePage, roleRawValues);
  }

  // (2) Re-derive (sc, label) pairs, then DROP any that are NOT public — never
  // select a suppressed/#801-sensitive family even if the client tampered the URL.
  const gate = await loadFamilyOverlayGate();
  const publicPairs: Array<{ supercategory: string; familyLabel: string }> = [];
  for (const key of methodKeys) {
    const idx = key.indexOf("::");
    if (idx <= 0) continue;
    const supercategory = key.slice(0, idx);
    const familyLabel = key.slice(idx + 2);
    if (!familyLabel) continue;
    if (isFamilyPubliclyVisible(supercategory, familyLabel, gate)) {
      publicPairs.push({ supercategory, familyLabel });
    }
  }
  if (publicPairs.length === 0) return empty;

  // (3) Members having ≥1 of the selected public families (OR within facet).
  // #2202 edit 2 of 3 — THIS query produces `total`. Carving only the page-rows
  // query in `buildHits` would leave `total` counting hidden members while the
  // rows omit them, so the last page would render short (or empty). The carve
  // goes inside the `scholar:` relation filter, NOT at the top level: the outer
  // where already owns `OR: publicPairs` (the method facet), and
  // `publicRoleWhere()` also carries an `OR` — spreading it here would clobber
  // the facet and match every family. #2537 — a combined `roleGroup` filter
  // nests the SAME way, alongside `publicRoleWhere()`, for the same reason.
  const matchRows = (await prisma.scholarFamily.findMany({
    where: {
      cwid: { in: memberCwids },
      OR: publicPairs,
      scholar: {
        deletedAt: null,
        status: "active",
        ...(roleRawValues ? { roleCategory: { in: roleRawValues } } : {}),
        ...publicRoleWhere(),
      },
    },
    select: { cwid: true },
    distinct: ["cwid"],
  })) as Array<{ cwid: string }>;
  return paginateAndBuild(
    matchRows.map((r) => r.cwid),
    safePage,
    roleRawValues,
  );
}

/**
 * Shared pagination + hit-assembly tail for both filter paths: sort the
 * filtered cwid set alphabetically for a stable page slice, take one page, and
 * assemble hits (which re-sorts that page preferredName ASC — the SSR roster's
 * name ordering). `roleRawValues`, when set, is re-applied inside `buildHits`'
 * own row query so a page's rows can never disagree with `total`.
 */
async function paginateAndBuild(
  filteredCwids: string[],
  safePage: number,
  roleRawValues?: string[],
): Promise<UnitMembersByMethodsResult> {
  const total = filteredCwids.length;
  if (total === 0) {
    return { hits: [], total: 0, page: safePage, pageSize: FACULTY_PAGE_SIZE };
  }
  const orderedCwids = [...filteredCwids].sort((a, b) => a.localeCompare(b));
  const pageCwids = orderedCwids.slice(
    safePage * FACULTY_PAGE_SIZE,
    (safePage + 1) * FACULTY_PAGE_SIZE,
  );
  if (pageCwids.length === 0) {
    return { hits: [], total, page: safePage, pageSize: FACULTY_PAGE_SIZE };
  }
  const hits = await buildHits(pageCwids, roleRawValues);
  return { hits, total, page: safePage, pageSize: FACULTY_PAGE_SIZE };
}

/**
 * Assemble `DepartmentFacultyHit[]` for a fixed cwid set — the same shape both
 * `getDepartmentFaculty` and `getDivisionFaculty` return (name, title, dept/div
 * names, role, overview snippet, pub/grant counts, public-gated `topMethods`),
 * sorted preferredName ASC to match the SSR roster ordering. `roleRawValues`
 * (#2537), when set, re-applies the role-group filter here too — see the
 * `getUnitMembersFiltered` doc comment.
 */
async function buildHits(
  cwids: string[],
  roleRawValues?: string[],
): Promise<DepartmentFacultyHit[]> {
  const includeClause = {
    department: { select: { name: true } },
    division: { select: { name: true } },
  } as const;

  // #2202 edit 3 of 3 — the page-rows query. Redundant with the carve in step
  // (3), and deliberately so: this is the query that actually emits names, so it
  // carries the guard itself rather than trusting its caller's cwid list.
  const rows = (await prisma.scholar.findMany({
    where: {
      cwid: { in: cwids },
      deletedAt: null,
      status: "active",
      ...(roleRawValues ? { roleCategory: { in: roleRawValues } } : {}),
      ...publicRoleWhere(),
    },
    orderBy: [{ preferredName: "asc" }],
    include: includeClause,
  })) as Array<{
    cwid: string;
    preferredName: string;
    slug: string;
    primaryTitle: string | null;
    roleCategory: string | null;
    overview: string | null;
    primaryDepartment: string | null;
    department: { name: string } | null;
    division: { name: string } | null;
  }>;

  const rowCwids = rows.map((r) => r.cwid);
  const now = new Date();

  type PubGroupRow = { cwid: string; _count: { pmid: number } };
  type GrantGroupRow = { cwid: string; _count: { _all: number } };
  const [pubCounts, grantCounts, famByCwid] = await Promise.all([
    rowCwids.length === 0
      ? Promise.resolve([] as PubGroupRow[])
      : (prisma.publicationTopic.groupBy({
          by: ["cwid"],
          where: { cwid: { in: rowCwids } },
          _count: { pmid: true },
          orderBy: { cwid: "asc" },
        }) as unknown as Promise<PubGroupRow[]>),
    rowCwids.length === 0
      ? Promise.resolve([] as GrantGroupRow[])
      : (prisma.grant.groupBy({
          by: ["cwid"],
          where: { cwid: { in: rowCwids }, endDate: { gte: now }, source: { not: "RePORTER" } },
          _count: { _all: true },
          orderBy: { cwid: "asc" },
        }) as unknown as Promise<GrantGroupRow[]>),
    // PUBLIC-only chips, same loader/gate as the Phase-1 roster chips. Always
    // enabled here: this route only runs when the facet flag is on (route-gated).
    loadPublicFamiliesForMembers(rowCwids, { enabled: true }),
  ]);

  const pubMap = new Map<string, number>(pubCounts.map((r) => [r.cwid, r._count.pmid]));
  const grantMap = new Map<string, number>(grantCounts.map((r) => [r.cwid, r._count._all]));

  return rows.map((s) => {
    const fams = famByCwid.get(s.cwid);
    const hit: DepartmentFacultyHit = {
      cwid: s.cwid,
      preferredName: s.preferredName,
      slug: s.slug,
      primaryTitle: s.primaryTitle,
      divisionName: s.division?.name ?? null,
      departmentName: s.department?.name ?? s.primaryDepartment ?? "",
      identityImageEndpoint: identityImageEndpoint(s.cwid),
      roleCategory: formatRoleCategory(s.roleCategory),
      roleCategoryRaw: s.roleCategory,
      overview: s.overview
        ? s.overview.slice(0, 120).trimEnd() + (s.overview.length > 120 ? "…" : "")
        : null,
      pubCount: pubMap.get(s.cwid) ?? 0,
      grantCount: grantMap.get(s.cwid) ?? 0,
    };
    return fams && fams.length > 0
      ? { ...hit, topMethods: fams.slice(0, ROSTER_ROW_METHODS_CAP) }
      : hit;
  });
}
