/**
 * The Data Quality roster query (`docs/data-quality-dashboard-spec.md`).
 *
 * Loads the scholars in the viewer's scope, computes each one's data-quality gaps
 * (headshot / overview / pending COI suggestions) and a rolled-our-own
 * "prominence" score, then sorts by prominence and paginates. Read-only; the page
 * deep-links each row into the existing per-scholar edit surface.
 *
 * Authorization/scope is the page's responsibility to *resolve* (via
 * `loadDataQualityScope`), but the scope MUST live in the query (so the UI is
 * never the boundary) — `opts.scope` does exactly that.
 *
 * Aggregates (chairs, chiefs, PI-grant counts, COI counts, overview overrides) are
 * read GROUPED BY cwid across the whole table and joined to the candidate set
 * in-app, rather than with an `in: [thousands of cwids]` clause — the candidate
 * set can be every active scholar for a superuser, and the grouped aggregates are
 * each one bounded query.
 *
 * Server-only by construction (uses Prisma) — no `server-only` import so it loads
 * under vitest with a fake client, matching `edit-roster.ts`.
 */
import type { DataQualityScope } from "@/lib/edit/data-quality";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface this loader reads — a `db.read` client satisfies it. */
export type DataQualityClient = Pick<
  PrismaClient,
  | "scholar"
  | "department"
  | "division"
  | "grant"
  | "coiGapCandidate"
  | "fieldOverride"
  | "centerMembership"
>;

/** Grant `role` values that count as a principal-investigator role ("times as PI").
 *  PI-Subaward is still PI (on a subaward); Co-PI is a shared principal role.
 *  Co-I / Key Personnel are NOT PI. (Source: `Grant.role`, #78.) */
export const PI_ROLES = ["PI", "PI-Subaward", "Co-PI"] as const;

/** #536 hidden identity classes — not publicly displayed; mirrors
 *  `HIDDEN_DISPLAY_ROLES` in `lib/eligibility.ts`. Excluded when the viewer turns
 *  the hidden-scholars filter off (the dashboard defaults to including them). */
const HIDDEN_ROLES = ["doctoral_student", "affiliate_alumni"] as const;

/** Prominence weights — kept here so they're easy to tune in one place.
 *  Leadership weights mirror the people-search #532 constants (chair > chief). */
const W_HINDEX = 0.5;
const W_PI = 0.5;
const W_NIH_PI = 0.5;
const W_CHAIR = 3.0;
const W_CHIEF = 1.5;
const W_FACULTY = 1.0;

export type HeadshotState = "present" | "missing" | "unknown";

export type DataQualityGapFilter = "all" | "no-headshot" | "no-overview" | "has-coi";

/** One row in the dashboard table. Plain-serializable (crosses to a client UI). */
export type DataQualityEntry = {
  cwid: string;
  slug: string;
  name: string;
  title: string | null;
  /** Department name, falling back to division; null when neither is set. */
  unit: string | null;
  roleCategory: string | null;
  isChair: boolean;
  isChief: boolean;
  /** "present" | "missing" | "unknown" (not yet probed by etl:headshot). */
  headshot: HeadshotState;
  hasOverview: boolean;
  pendingCoiHigh: number;
  pendingCoiMedium: number;
  prominence: number;
  /** Deep link into the scholar's edit surface (the edit page enforces authz). */
  editHref: string;
};

export type DataQualityOptions = {
  /** Resolved viewer scope (`loadDataQualityScope`). */
  scope: DataQualityScope;
  /** Role-category (person-type) filter; raw DB value. Empty = no filter. */
  roleCategory?: string;
  /** Department-code filter. Empty = no filter. */
  deptCode?: string;
  /** Gap-type filter; defaults to "all". */
  gap?: DataQualityGapFilter;
  /** Include #536 hidden identity classes (doctoral students / alumni). Default
   *  true; ignored when a specific `roleCategory` is chosen. */
  includeHidden?: boolean;
  /** Page size (default 50, capped at 200). */
  limit?: number;
  /** Page offset (default 0). */
  offset?: number;
};

/** Gap counts across the in-scope, filtered (pre-gap-filter) set — for summary chips. */
export type DataQualityCounts = {
  /** Scholars in scope after person-type/department/hidden filters (pre gap filter). */
  inScope: number;
  missingHeadshot: number;
  missingOverview: number;
  withCoi: number;
};

export type DataQualityResult = {
  entries: DataQualityEntry[];
  /** Total matching ALL filters incl. the gap filter (drives pagination). */
  total: number;
  counts: DataQualityCounts;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Build the candidate `where`: in-scope, active, non-deleted scholars, with the
 * optional person-type / department / hidden-roles filters applied.
 */
function buildWhere(
  opts: DataQualityOptions,
  centerCwids: readonly string[],
): Prisma.ScholarWhereInput {
  const and: Prisma.ScholarWhereInput[] = [];
  const where: Prisma.ScholarWhereInput = { deletedAt: null, status: "active" };

  if (opts.roleCategory) {
    // An explicit person-type filter governs; the hidden-roles toggle is moot.
    where.roleCategory = opts.roleCategory;
  } else if (opts.includeHidden === false) {
    // Exclude hidden identity classes but KEEP nulls (fail-open display, #536).
    and.push({ OR: [{ roleCategory: null }, { roleCategory: { notIn: [...HIDDEN_ROLES] } }] });
  }

  if (opts.deptCode) where.deptCode = opts.deptCode;

  if (opts.scope.all === false) {
    const scopeOr: Prisma.ScholarWhereInput[] = [];
    if (opts.scope.unitCodes.length > 0) {
      scopeOr.push({ deptCode: { in: opts.scope.unitCodes } });
      scopeOr.push({ divCode: { in: opts.scope.unitCodes } });
    }
    if (centerCwids.length > 0) scopeOr.push({ cwid: { in: [...centerCwids] } });
    // Empty scope → match nothing (the route forbids this case before we get here,
    // but be safe rather than returning everyone).
    and.push(scopeOr.length > 0 ? { OR: scopeOr } : { cwid: { in: [] } });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

export async function loadDataQualityRoster(
  opts: DataQualityOptions,
  client: DataQualityClient,
): Promise<DataQualityResult> {
  // Center-scope expands to member cwids (a center scopes by membership, not a
  // scholar column). Only needed for a non-global viewer with center grants.
  let centerCwids: string[] = [];
  if (opts.scope.all === false && opts.scope.centerCodes.length > 0) {
    const rows = await client.centerMembership.findMany({
      where: { centerCode: { in: opts.scope.centerCodes } },
      select: { cwid: true },
    });
    centerCwids = [...new Set(rows.map((r) => r.cwid))];
  }

  const where = buildWhere(opts, centerCwids);

  // Candidate identities + prominence inputs. The whole in-scope set loads (the
  // prominence sort is computed in-app over all of it, then paginated).
  const [candidates, chairRows, chiefRows, piRows, nihPiRows, coiRows, overrideRows] =
    await Promise.all([
      client.scholar.findMany({
        where,
        select: {
          cwid: true,
          slug: true,
          preferredName: true,
          primaryTitle: true,
          roleCategory: true,
          overview: true,
          hIndex: true,
          scoredPubCount: true,
          hasHeadshot: true,
          department: { select: { name: true } },
          division: { select: { name: true } },
        },
      }),
      client.department.findMany({ select: { chairCwid: true } }),
      client.division.findMany({ select: { chiefCwid: true } }),
      client.grant.groupBy({
        by: ["cwid"],
        where: { role: { in: [...PI_ROLES] } },
        _count: { _all: true },
      }),
      client.grant.groupBy({
        by: ["cwid"],
        where: { role: { in: [...PI_ROLES] }, nihIc: { not: null } },
        _count: { _all: true },
      }),
      client.coiGapCandidate.groupBy({
        by: ["cwid", "tier"],
        where: { status: "new" },
        _count: { _all: true },
      }),
      client.fieldOverride.findMany({
        where: { entityType: "scholar", fieldName: "overview" },
        select: { entityId: true, value: true },
      }),
    ]);

  const chairs = new Set(chairRows.map((r) => r.chairCwid).filter((c): c is string => !!c));
  const chiefs = new Set(chiefRows.map((r) => r.chiefCwid).filter((c): c is string => !!c));
  const piCount = new Map(piRows.map((r) => [r.cwid, r._count._all]));
  const nihPiCount = new Map(nihPiRows.map((r) => [r.cwid, r._count._all]));
  const overviewOverride = new Set(
    overrideRows.filter((r) => nonEmpty(r.value)).map((r) => r.entityId),
  );
  const coiHigh = new Map<string, number>();
  const coiMedium = new Map<string, number>();
  for (const r of coiRows) {
    if (r.tier === "High") coiHigh.set(r.cwid, r._count._all);
    else if (r.tier === "Medium") coiMedium.set(r.cwid, r._count._all);
  }

  let entries: DataQualityEntry[] = candidates.map((s) => {
    const isChair = chairs.has(s.cwid);
    const isChief = chiefs.has(s.cwid);
    const pi = piCount.get(s.cwid) ?? 0;
    const nihPi = nihPiCount.get(s.cwid) ?? 0;
    const prominence =
      Math.log1p(s.scoredPubCount ?? 0) +
      W_HINDEX * Math.log1p(s.hIndex ?? 0) +
      Math.max(isChair ? W_CHAIR : 0, isChief ? W_CHIEF : 0) +
      W_PI * Math.log1p(pi) +
      W_NIH_PI * Math.log1p(nihPi) +
      (s.roleCategory === "full_time_faculty" ? W_FACULTY : 0);

    const headshot: HeadshotState =
      s.hasHeadshot === true ? "present" : s.hasHeadshot === false ? "missing" : "unknown";

    return {
      cwid: s.cwid,
      slug: s.slug,
      name: s.preferredName,
      title: s.primaryTitle ?? null,
      unit: s.department?.name ?? s.division?.name ?? null,
      roleCategory: s.roleCategory ?? null,
      isChair,
      isChief,
      headshot,
      hasOverview: nonEmpty(s.overview) || overviewOverride.has(s.cwid),
      pendingCoiHigh: coiHigh.get(s.cwid) ?? 0,
      pendingCoiMedium: coiMedium.get(s.cwid) ?? 0,
      prominence,
      editHref: `/edit/scholar/${encodeURIComponent(s.cwid)}`,
    };
  });

  // Summary counts across the in-scope, filtered set (before the gap filter).
  const counts: DataQualityCounts = {
    inScope: entries.length,
    missingHeadshot: entries.filter((e) => e.headshot === "missing").length,
    missingOverview: entries.filter((e) => !e.hasOverview).length,
    withCoi: entries.filter((e) => e.pendingCoiHigh > 0).length,
  };

  // Gap filter.
  if (opts.gap === "no-headshot") entries = entries.filter((e) => e.headshot === "missing");
  else if (opts.gap === "no-overview") entries = entries.filter((e) => !e.hasOverview);
  else if (opts.gap === "has-coi") entries = entries.filter((e) => e.pendingCoiHigh > 0);

  // Prominence desc, then name asc for a stable page boundary.
  entries.sort((a, b) => b.prominence - a.prominence || a.name.localeCompare(b.name));

  const total = entries.length;
  const take = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const skip = Math.max(opts.offset ?? 0, 0);

  return { entries: entries.slice(skip, skip + take), total, counts };
}
