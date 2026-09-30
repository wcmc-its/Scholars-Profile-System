/**
 * #974 Phase 2 / #2537 / Unit Page v2 — one page of a DEPARTMENT/DIVISION
 * roster, filtered by ≥1 of the SELECTED public method families, a role-category
 * GROUP, a Division facet (department only), a name/title query, or any mix
 * (AND across facets), in the requested sort order. Backs the uncacheable
 * `/api/units/[kind]/[code]/members` route (the page itself stays CloudFront-
 * cacheable; only this `force-dynamic` route does per-request filtering).
 *
 * Every request ranks from the cached whole-roster index
 * (`loadUnitRosterIndex`, the #536/#2202-carved member scope, plus a
 * division's Cornell externals), so the order holds ACROSS page boundaries:
 *
 *   (1) Index — carved member entries (name, title, raw role, division, and
 *       pub/grant counts when a count sort is asked for).
 *   (2) Division facet (department only) — keep members in ≥1 selected
 *       division (`loadDivisionMemberCwids`, so a manual-roster division is
 *       honored). Intersecting with the dept's own index means a division code
 *       from another department can never widen the roster.
 *   (3) Methods facet — re-derive `(supercategory, familyLabel)` pairs from the
 *       `sc::label` keys and DROP any that are NOT public under the overlay gate
 *       (HARD CONSTRAINT A: never query a non-public family), then
 *       `scholarFamily.findMany` with an OR over the public pairs (OR within the
 *       facet), `distinct: ["cwid"]`. The carve (and a `roleGroup`) nests INSIDE
 *       the `scholar:` relation filter — NOT at the top level, which already owns
 *       `OR: publicPairs` (#2202 note below).
 *   (4) Name/title query (`matchesRosterQuery`), then the role group (in memory,
 *       against the RAW role column — a null role fails `includes` exactly as it
 *       fails SQL `IN`), then `rankRoster` + a 20-row slice.
 *   (5) Hydrate that slice with `buildHits` (which re-applies the carve and the
 *       role group itself, #2202/#2537) — it keeps the ranked order.
 *
 * Externals (division Cornell members) have no role category, division or
 * method families, so any of those facets excludes them; a sort/query-only
 * request keeps them, as the SSR roster does.
 *
 * Server-only (Prisma + server-only overlay/flag helpers); never import into a
 * client component.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { formatRoleCategory } from "@/lib/role-display";
import { groupToRawValues, type RoleGroupLabel } from "@/lib/role-groups";
import { publicRoleWhere } from "@/lib/eligibility";
import { loadDivisionMemberCwids, resolveDivisionChiefCwid } from "@/lib/api/divisions";
import { cachedRead } from "@/lib/api/swr-cache";
import type { DepartmentFacultyHit } from "@/lib/api/departments";
import {
  isFamilyPubliclyVisible,
  loadFamilyOverlayGate,
} from "@/lib/api/methods-overlay";
import {
  loadPublicFamiliesForMembers,
  ROSTER_ROW_METHODS_CAP,
} from "@/lib/api/methods-roster";
import { loadRosterCounts } from "@/lib/api/roster-counts";
import { loadTopMeshForMembers, withTopMesh } from "@/lib/api/roster-mesh";
import { loadUnitRosterIndex, type RosterIndexEntry } from "@/lib/api/unit-roster-index";
import {
  matchesRosterQuery,
  normalizeRosterQuery,
  pinDivisionChiefFirst,
  rankRoster,
  type RosterSort,
} from "@/lib/roster-sort";

const FACULTY_PAGE_SIZE = 20;

export type UnitMembersByMethodsResult = {
  hits: DepartmentFacultyHit[];
  total: number;
  /** 0-indexed, matching the uncacheable route's `?page=` convention. */
  page: number;
  pageSize: number;
  /** Unit Page v2 — role-label counts over the facet- and query-filtered set,
   *  BEFORE the role group narrows it, so the Appointment pills keep
   *  whole-set counts while a name query or sidebar facet is active. */
  roleCategoryCounts?: Record<string, number>;
};

/** #2537 / Unit Page v2 — any mix of facets, plus the toolbar's sort + query.
 *  All-empty is the plain ranked roster. */
export type UnitMemberFilter = {
  methodKeys?: string[];
  roleGroup?: RoleGroupLabel;
  /** Unit Page v2 — division codes (department rosters only; OR within). */
  divisionCodes?: string[];
  /** Unit Page v2 roster toolbar — defaults to "last" (surname A–Z). */
  sort?: RosterSort;
  /** Unit Page v2 roster toolbar — name/title substring (case/accent-blind). */
  q?: string;
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
  const divisionCodes = kind === "department" ? (filter.divisionCodes ?? []) : [];
  const sort: RosterSort = filter.sort ?? "last";
  const q = normalizeRosterQuery(filter.q);
  const roleRawValues = filter.roleGroup ? groupToRawValues(filter.roleGroup) : undefined;
  // A `roleGroup` that resolves to no raw values (e.g. "All", or a future
  // unrecognized label) can never match anything — the route validates against
  // `FILTERABLE_ROLE_GROUPS` before calling in, but fail safe here too rather
  // than silently falling through to an unfiltered query.
  if (filter.roleGroup && (!roleRawValues || roleRawValues.length === 0)) return empty;

  // (1) The carved whole-roster index (counts only for a count sort).
  const index = await loadUnitRosterIndex(kind, code, { withCounts: sort !== "last" });
  if (index.length === 0) return empty;

  // (2) Division facet.
  let allowed: Set<string> | null = null;
  if (divisionCodes.length > 0) {
    allowed = new Set(
      (await Promise.all(divisionCodes.map((c) => loadDivisionMemberCwids(c)))).flat(),
    );
  }

  // (3) Methods facet.
  if (methodKeys.length > 0) {
    // Re-derive (sc, label) pairs, then DROP any that are NOT public — never
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

    const candidates = index
      .filter((e) => !e.externalHit && (!allowed || allowed.has(e.cwid)))
      .map((e) => e.cwid);
    if (candidates.length === 0) return empty;

    // #2202 — THIS query decides membership (and so `total`). The carve goes
    // inside the `scholar:` relation filter, NOT at the top level: the outer
    // where already owns `OR: publicPairs` (the method facet), and
    // `publicRoleWhere()` also carries an `OR` — spreading it here would clobber
    // the facet and match every family. #2537 — a combined `roleGroup` filter
    // nests the SAME way, alongside `publicRoleWhere()`, for the same reason.
    const matchRows = (await prisma.scholarFamily.findMany({
      where: {
        cwid: { in: candidates },
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
    allowed = new Set(matchRows.map((r) => r.cwid));
  }

  // (4) Query, role group, rank.
  const scoped = index.filter(
    (e) => (!allowed || allowed.has(e.cwid)) && matchesRosterQuery(e, q),
  );
  const roleCategoryCounts: Record<string, number> = {};
  for (const e of scoped) {
    if (e.externalHit) continue;
    const label = formatRoleCategory(e.roleCategory);
    if (label === null) continue;
    roleCategoryCounts[label] = (roleCategoryCounts[label] ?? 0) + 1;
  }
  const filtered = roleRawValues
    ? scoped.filter(
        (e) => !e.externalHit && e.roleCategory !== null && roleRawValues.includes(e.roleCategory),
      )
    : scoped;
  // The division chief is pinned first under the surname sort, exactly as the
  // SSR rosters do (`getDivisionFaculty`, and `getDepartmentFaculty` with a
  // divCode), so the same sort orders rows the same way on both paths.
  const chiefDivCode =
    sort !== "last"
      ? null
      : kind === "division"
        ? code
        : divisionCodes.length === 1
          ? divisionCodes[0]
          : null;
  const chiefCwid = chiefDivCode ? await resolveDivisionChiefCwid(chiefDivCode) : null;
  const ranked = pinDivisionChiefFirst(rankRoster(filtered, { sort }), chiefCwid, sort);

  const result = await paginateAndBuild(kind, ranked, safePage, roleRawValues);
  return { ...result, roleCategoryCounts };
}

/**
 * Shared pagination + hit-assembly tail: take one 20-row page of the RANKED
 * entries and hydrate it in that order. (Before Unit Page v2 this sliced the
 * filtered set in cwid order and re-sorted by name only WITHIN each page.)
 * `roleRawValues`, when set, is re-applied inside `buildHits`' own row query so
 * a page's rows can never disagree with `total`.
 */
async function paginateAndBuild(
  kind: "department" | "division",
  ranked: RosterIndexEntry[],
  safePage: number,
  roleRawValues?: string[],
): Promise<UnitMembersByMethodsResult> {
  const total = ranked.length;
  const slice = ranked.slice(safePage * FACULTY_PAGE_SIZE, (safePage + 1) * FACULTY_PAGE_SIZE);
  if (slice.length === 0) {
    return { hits: [], total, page: safePage, pageSize: FACULTY_PAGE_SIZE };
  }
  // TOPICS chips: one people-index lookup for the page's WCM rows, in parallel
  // with hydration. Attached here (the uncached route path), NOT in `buildHits`,
  // because the SSR roster hydrates inside its cached read and attaches its own
  // chips outside it (lib/api/roster-mesh.ts).
  const [hits, mesh] = await Promise.all([
    hydrateRosterPage(kind, slice, {
      roleRawValues,
      // This route has always carried chips (it predates the per-surface flag
      // split); the SSR roster passes its own chips flag.
      chipsEnabled: true,
    }),
    loadTopMeshForMembers(slice.filter((e) => !e.externalHit).map((e) => e.cwid)),
  ]);
  return { hits: withTopMesh(hits, mesh), total, page: safePage, pageSize: FACULTY_PAGE_SIZE };
}

/**
 * Hydrate one ranked page of index entries into hits, in the given order: WCM
 * members through `buildHits`, externals from their pre-built hit.
 */
export async function hydrateRosterPage(
  kind: "department" | "division",
  entries: RosterIndexEntry[],
  opts: { roleRawValues?: string[]; chipsEnabled: boolean },
): Promise<DepartmentFacultyHit[]> {
  const wcmCwids = entries.filter((e) => !e.externalHit).map((e) => e.cwid);
  const hits = await buildHits(wcmCwids, { kind, ...opts });
  const byCwid = new Map(hits.map((h) => [h.cwid, h]));
  return entries
    .map((e) => e.externalHit ?? byCwid.get(e.cwid))
    .filter((h): h is DepartmentFacultyHit => h !== undefined);
}

/**
 * Assemble `DepartmentFacultyHit[]` for a fixed cwid list — the shape both
 * `getDepartmentFaculty` and the filtered route return (name, title, dept/div
 * names, role, overview snippet, pub/grant counts, public-gated `topMethods`),
 * in the ORDER OF `cwids` (the caller ranked them). Counts come from
 * `loadRosterCounts(kind)`, so they match the number the sort ranked on.
 * `roleRawValues` (#2537), when set, re-applies the role-group filter here too —
 * see the `getUnitMembersFiltered` doc comment.
 */
export async function buildHits(
  cwids: string[],
  opts: {
    kind: "department" | "division";
    roleRawValues?: string[];
    chipsEnabled: boolean;
  },
): Promise<DepartmentFacultyHit[]> {
  if (cwids.length === 0) return [];
  const { roleRawValues } = opts;
  const includeClause = {
    department: { select: { name: true } },
    division: { select: { name: true } },
  } as const;

  // #2202 edit 3 of 3 — the page-rows query. Redundant with the carve in the
  // index and step (3), and deliberately so: this is the query that actually
  // emits names, so it carries the guard itself rather than trusting its
  // caller's cwid list.
  const rows = (await prisma.scholar.findMany({
    where: {
      cwid: { in: cwids },
      deletedAt: null,
      status: "active",
      ...(roleRawValues ? { roleCategory: { in: roleRawValues } } : {}),
      ...publicRoleWhere(),
    },
    include: includeClause,
  })) as Array<{
    cwid: string;
    preferredName: string;
    slug: string;
    primaryTitle: string | null;
    roleCategory: string | null;
    overview: string | null;
    primaryDepartment: string | null;
    primaryOrgCode: string | null;
    department: { name: string } | null;
    division: { name: string } | null;
  }>;
  // Keep the caller's (ranked) order; drop anything the guard filtered out.
  const rowByCwid = new Map(rows.map((r) => [r.cwid, r]));
  const ordered = cwids
    .map((c) => rowByCwid.get(c))
    .filter((r): r is (typeof rows)[number] => r !== undefined);

  const rowCwids = ordered.map((r) => r.cwid);
  const [{ pubs, grants }, famByCwid] = await Promise.all([
    loadRosterCounts(opts.kind, rowCwids),
    // PUBLIC-only chips, same loader/gate as the Phase-1 roster chips.
    loadPublicFamiliesForMembers(rowCwids, { enabled: opts.chipsEnabled }),
  ]);

  return ordered.map((s) => {
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
      pubCount: pubs.get(s.cwid) ?? 0,
      grantCount: grants.get(s.cwid) ?? 0,
      primaryOrgCode: s.primaryOrgCode ?? null,
    };
    return fams && fams.length > 0
      ? { ...hit, topMethods: fams.slice(0, ROSTER_ROW_METHODS_CAP) }
      : hit;
  });
}

/**
 * Unit Page v2 — public per-division member counts for a DEPARTMENT page (hero
 * division chips + the roster's Division facet). Counts with the SAME predicate
 * the Division facet filter applies in `getUnitMembersFiltered`: the dept's
 * public members (`deptCode`, active, `publicRoleWhere()`) ∩ the division's
 * `loadDivisionMemberCwids` set (LDAP `divCode`, unioned with the manual
 * `DivisionMembership` roster when `Division.source = "manual"`). The ETL's
 * `Division.scholarCount` is NOT used: it counts every active scholar with the
 * divCode, with no role carve and no manual-roster members, so it disagrees
 * with the filtered roster.
 *
 * Batched (≤3 queries) rather than one `loadDivisionMemberCwids` per division:
 * because the result is intersected with the dept's members (already active),
 * a member's LDAP division is just their own `divCode`, and a manual-roster
 * division adds its `DivisionMembership` cwids. Keep this in step with
 * `loadDivisionMemberCwids` (lib/api/divisions.ts) if its union rule changes.
 *
 * Returns division code → count; a division with no public members is absent.
 */
async function getDepartmentDivisionMemberCountsUncached(
  deptCode: string,
): Promise<Map<string, number>> {
  const [members, divisions] = await Promise.all([
    prisma.scholar.findMany({
      where: { deptCode, deletedAt: null, status: "active", ...publicRoleWhere() },
      select: { cwid: true, divCode: true },
    }),
    prisma.division.findMany({
      where: { deptCode },
      select: { code: true, source: true },
    }),
  ]);
  const counts = new Map<string, number>();
  if (members.length === 0 || divisions.length === 0) return counts;

  const divisionCodes = new Set(divisions.map((d) => d.code));
  const manualCodes = divisions.filter((d) => d.source === "manual").map((d) => d.code);
  const manualRows =
    manualCodes.length > 0
      ? await prisma.divisionMembership.findMany({
          where: { divisionCode: { in: manualCodes }, cwid: { in: members.map((m) => m.cwid) } },
          select: { divisionCode: true, cwid: true },
        })
      : [];

  // division code → member cwids (a Set, so an LDAP + manual double-listing
  // counts once — same as loadDivisionMemberCwids' union).
  const byDivision = new Map<string, Set<string>>();
  const add = (code: string, cwid: string) => {
    let set = byDivision.get(code);
    if (!set) byDivision.set(code, (set = new Set()));
    set.add(cwid);
  };
  for (const m of members) {
    if (m.divCode && divisionCodes.has(m.divCode)) add(m.divCode, m.cwid);
  }
  for (const r of manualRows) add(r.divisionCode, r.cwid);
  for (const [code, set] of byDivision) counts.set(code, set.size);
  return counts;
}

export const getDepartmentDivisionMemberCounts = async (
  deptCode: string,
): Promise<Map<string, number>> =>
  new Map(
    await cachedRead(`department:division-counts:${deptCode}`, async () => [
      ...(await getDepartmentDivisionMemberCountsUncached(deptCode)),
    ]),
  );
