/**
 * Unit Page v2 — the cached, whole-roster INDEX a department / division roster
 * is sorted, name-filtered and paginated from ("Last name A–Z" / "Most
 * publications" / "Most grants" + "Filter by name or title").
 *
 * One entry per public member: the carved member scope the SSR roster already
 * renders (`deptCode` / `loadDivisionMemberCwids`, active, not deleted,
 * `publicRoleWhere()` — the #536/#2202 carve), plus a division's Cornell
 * (Ithaca) external members (#2519) with their pre-built hit. Every later
 * request — any sort, query or page — is an in-memory filter/sort/slice plus
 * ONE page hydration of ≤20 rows.
 *
 * Two cached reads, so the default surname sort never pays for the counts:
 *   - `<kind>:roster-base:<code>`   — names, titles, role, division (1-3 queries)
 *   - `<kind>:roster-counts:<code>` — pub/grant counts (`loadRosterCounts`), only
 *     loaded for a count sort.
 * Keys sit under the `department:` / `division:` prefixes so the existing
 * unit-edit busts (`reflectUnitChange`) clear them with the rest of the unit.
 *
 * Surname key: `extractLastNameSort(preferredName)` — the same key People
 * search's `lastNameSort` and the center rosters use. `Scholar` stores no
 * surname column (LDAP `sn` only feeds `preferredName`).
 *
 * Server-only (Prisma).
 */
import { prisma } from "@/lib/db";
import { cachedRead } from "@/lib/api/swr-cache";
import { publicRoleWhere } from "@/lib/eligibility";
import { extractLastNameSort } from "@/lib/name-sort";
import { loadDivisionMemberCwids } from "@/lib/api/divisions";
import { loadRosterCounts } from "@/lib/api/roster-counts";
import { isCornellDirectoryMembersEnabled } from "@/lib/edit/cornell-directory-flag";
import {
  buildExternalMemberHit,
  loadExternalMembersByCuid,
} from "@/lib/api/external-members";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

export type RosterIndexEntry = {
  cwid: string;
  preferredName: string;
  primaryTitle: string | null;
  /** RAW `scholar.role_category` (never the display label). Null on externals. */
  roleCategory: string | null;
  /** LDAP division code (department rosters' `divCode` filter). */
  divCode: string | null;
  /** `extractLastNameSort(preferredName)`. */
  lastKey: string;
  /** 0 unless the index was loaded `withCounts`. */
  pubCount: number;
  grantCount: number;
  /** Present only for a Cornell (Ithaca) external member — the finished hit,
   *  since an external has no `Scholar` row to hydrate from. */
  externalHit?: DepartmentFacultyHit;
};

type UnitKind = "department" | "division";

type BaseRow = {
  cwid: string;
  preferredName?: string | null;
  primaryTitle?: string | null;
  roleCategory?: string | null;
  divCode?: string | null;
};

const toEntry = (r: BaseRow): RosterIndexEntry => {
  const preferredName = r.preferredName ?? "";
  return {
    cwid: r.cwid,
    preferredName,
    primaryTitle: r.primaryTitle ?? null,
    roleCategory: r.roleCategory ?? null,
    divCode: r.divCode ?? null,
    lastKey: extractLastNameSort(preferredName),
    pubCount: 0,
    grantCount: 0,
  };
};

const BASE_SELECT = {
  cwid: true,
  preferredName: true,
  primaryTitle: true,
  roleCategory: true,
  divCode: true,
} as const;

async function loadRosterBaseUncached(kind: UnitKind, code: string): Promise<RosterIndexEntry[]> {
  if (kind === "department") {
    const rows = (await prisma.scholar.findMany({
      where: { deptCode: code, deletedAt: null, status: "active", ...publicRoleWhere() },
      select: BASE_SELECT,
    })) as BaseRow[];
    return rows.map(toEntry);
  }

  // Division: the LDAP + manual-roster union, re-carved here (the `cache()`d
  // `loadDivisionMemberCwids` deliberately carries no role carve — #718).
  const allCwids = await loadDivisionMemberCwids(code);
  const rows =
    allCwids.length === 0
      ? []
      : ((await prisma.scholar.findMany({
          where: { cwid: { in: allCwids }, deletedAt: null, status: "active", ...publicRoleWhere() },
          select: BASE_SELECT,
        })) as BaseRow[]);
  const entries = rows.map(toEntry);

  // #2519 — Cornell (Ithaca) externals, same gate as `getDivisionFaculty`: the
  // flag, and a manual division (the only kind the roster route writes them to).
  if (isCornellDirectoryMembersEnabled()) {
    const div = await prisma.division.findFirst({
      where: { code },
      select: { source: true },
    });
    if (div?.source === "manual") {
      const cornellRows = await prisma.divisionMembership.findMany({
        where: { divisionCode: code, source: "cornell-ithaca" },
        select: { cwid: true },
      });
      if (cornellRows.length > 0) {
        const byCuid = await loadExternalMembersByCuid(cornellRows.map((r) => r.cwid));
        for (const r of cornellRows) {
          const m = byCuid.get(r.cwid);
          if (!m) continue;
          const hit = buildExternalMemberHit(m);
          entries.push({
            ...toEntry({ cwid: hit.cwid, preferredName: hit.preferredName, primaryTitle: hit.primaryTitle }),
            externalHit: hit,
          });
        }
      }
    }
  }
  return entries;
}

async function loadRosterCountsCached(
  kind: UnitKind,
  code: string,
  cwids: string[],
): Promise<Array<[string, number, number]>> {
  return cachedRead(`${kind}:roster-counts:${code}`, async () => {
    const { pubs, grants } = await loadRosterCounts(kind, cwids);
    return cwids.map((c): [string, number, number] => [c, pubs.get(c) ?? 0, grants.get(c) ?? 0]);
  });
}

/**
 * The roster index for one department or division. `withCounts` fills
 * `pubCount` / `grantCount` (needed only by the count sorts). Returns a fresh
 * array each call; entries themselves are shared cache objects — never mutate.
 */
export async function loadUnitRosterIndex(
  kind: UnitKind,
  code: string,
  opts: { withCounts?: boolean } = {},
): Promise<RosterIndexEntry[]> {
  const base = await cachedRead(`${kind}:roster-base:${code}`, () =>
    loadRosterBaseUncached(kind, code),
  );
  if (!opts.withCounts) return [...base];
  const wcmCwids = base.filter((e) => !e.externalHit).map((e) => e.cwid);
  const counts = new Map(
    (await loadRosterCountsCached(kind, code, wcmCwids)).map(([c, p, g]) => [c, { p, g }]),
  );
  return base.map((e) => {
    const c = counts.get(e.cwid);
    return c ? { ...e, pubCount: c.p, grantCount: c.g } : e;
  });
}
