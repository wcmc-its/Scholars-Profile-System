/**
 * #974 Phase 2 — one page of DEPARTMENT/DIVISION roster members filtered to those
 * with ≥1 of the SELECTED public method families. Backs the uncacheable
 * `/api/units/[kind]/[code]/members` route (the page itself stays CloudFront-
 * cacheable; only this `force-dynamic` route does per-request filtering).
 *
 * Steps:
 *   (1) Resolve the unit's FULL active member CWIDs — department via a cheap
 *       `scholar.findMany`; division via `loadDivisionMemberCwids` (which also
 *       unions the manual `DivisionMembership` roster + re-gates on active).
 *   (2) Re-derive `(supercategory, familyLabel)` pairs from the `sc::label` keys
 *       and DROP any that are NOT public under the overlay gate — a tampered
 *       `?method=` for a suppressed/#801-sensitive family can never select a
 *       non-public family (HARD CONSTRAINT A: never query a non-public family).
 *   (3) `scholarFamily.findMany` with an OR over the public pairs (OR within the
 *       facet), `distinct: ["cwid"]` → the filtered member set.
 *   (4) Paginate that set (20/page) and assemble the same `DepartmentFacultyHit[]`
 *       shape the SSR roster returns, including the public-gated `topMethods` chips
 *       (reusing `loadPublicFamiliesForMembers`, the Phase-1 chip loader).
 *
 * Server-only (Prisma + server-only overlay/flag helpers); never import into a
 * client component.
 */
import { prisma } from "@/lib/db";
import { identityImageEndpoint } from "@/lib/headshot";
import { formatRoleCategory } from "@/lib/role-display";
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
  page: number;
  pageSize: number;
};

export async function getUnitMembersByMethods(
  kind: "department" | "division",
  code: string,
  methodKeys: string[],
  page: number,
): Promise<UnitMembersByMethodsResult> {
  const safePage = Math.max(0, page);
  const empty: UnitMembersByMethodsResult = {
    hits: [],
    total: 0,
    page: safePage,
    pageSize: FACULTY_PAGE_SIZE,
  };

  // (1) Full active member cwids for the unit.
  const memberCwids =
    kind === "division"
      ? await loadDivisionMemberCwids(code)
      : (
          await prisma.scholar.findMany({
            where: { deptCode: code, deletedAt: null, status: "active" },
            select: { cwid: true },
          })
        ).map((r) => r.cwid);
  if (memberCwids.length === 0) return empty;

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
  const matchRows = (await prisma.scholarFamily.findMany({
    where: {
      cwid: { in: memberCwids },
      OR: publicPairs,
      scholar: { deletedAt: null, status: "active" },
    },
    select: { cwid: true },
    distinct: ["cwid"],
  })) as Array<{ cwid: string }>;
  const filteredCwids = matchRows.map((r) => r.cwid);
  const total = filteredCwids.length;
  if (total === 0) return empty;

  // (4) Paginate the filtered cwid set (preferredName-ASC parity is restored after
  // the row fetch; sort cwids here only for a stable page slice), assemble hits.
  const orderedCwids = [...filteredCwids].sort((a, b) => a.localeCompare(b));
  const pageCwids = orderedCwids.slice(
    safePage * FACULTY_PAGE_SIZE,
    (safePage + 1) * FACULTY_PAGE_SIZE,
  );
  if (pageCwids.length === 0) {
    return { hits: [], total, page: safePage, pageSize: FACULTY_PAGE_SIZE };
  }

  const hits = await buildHits(pageCwids);
  return { hits, total, page: safePage, pageSize: FACULTY_PAGE_SIZE };
}

/**
 * Assemble `DepartmentFacultyHit[]` for a fixed cwid set — the same shape both
 * `getDepartmentFaculty` and `getDivisionFaculty` return (name, title, dept/div
 * names, role, overview snippet, pub/grant counts, public-gated `topMethods`),
 * sorted preferredName ASC to match the SSR roster ordering.
 */
async function buildHits(cwids: string[]): Promise<DepartmentFacultyHit[]> {
  const includeClause = {
    department: { select: { name: true } },
    division: { select: { name: true } },
  } as const;

  const rows = (await prisma.scholar.findMany({
    where: { cwid: { in: cwids }, deletedAt: null, status: "active" },
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
          where: { cwid: { in: rowCwids }, endDate: { gte: now } },
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
