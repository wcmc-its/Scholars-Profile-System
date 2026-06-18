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
import { toCsv } from "@/lib/csv";
import { formatRoleCategory } from "@/lib/role-display";
import type { EditRosterUnitFilter } from "@/lib/api/edit-roster";
import type { DataQualityScope } from "@/lib/edit/data-quality";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface this loader reads — a `db.read` client satisfies it. */
export type DataQualityClient = Pick<
  PrismaClient,
  | "scholar"
  | "department"
  | "division"
  | "center"
  | "grant"
  | "coiGapCandidate"
  | "fieldOverride"
  | "centerMembership"
  | "overviewProvenance"
>;

/** A single org-unit filter (department / division / center); reused from the
 *  Profiles roster so the encoding stays consistent. */
export type { EditRosterUnitFilter };

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

/**
 * Institutional-leadership sort tiers (lower number ranks higher), #1 v2 decision.
 * The Dean must rank #1 even though he is not a department chair. Tiers 0/1 are
 * derived from `primaryTitle` TEXT — no hand-maintained cwid map — so the set
 * stays current as titles change; chairs/chiefs (tier 2) keep their FK-based
 * prominence boost; everyone else is tier 3. Within a tier, prominence then name.
 *
 *   0 — THE Dean (an unmodified "Dean": not Associate/…, not school-specific)
 *   1 — the active deanery + named institutional officers (Provost/President/EVP)
 *   2 — department chairs / division chiefs (FK-identified)
 *   3 — everyone else
 *
 * Emeritus/Emerita titles are excluded from leadership entirely — a retired dean
 * ranks by prominence like everyone else (#1 v2 refinement).
 */
export const LEADERSHIP_TIER = { dean: 0, deanery: 1, chairChief: 2, none: 3 } as const;

const TITLE_EMERITUS = /\bemerit(?:us|a|i)\b/i;
const HAS_DEAN = /\bdean\b/i;
/** Modifiers that demote a "Dean" title out of tier 0 (it's a sub-dean). */
const SUBDEAN_MODIFIER = /\b(?:associate|assistant|affiliate|senior|interim|deputy|vice)\b/i;
/** A school/college-specific deanship (Graduate School, WCM-Qatar) is not THE dean. */
const SCHOOL_SPECIFIC_DEAN = /\b(?:graduate school|qatar)\b/i;

/** A concise label for an active (non-Emeritus) deanery / institutional-officer title. */
function deaneryLabel(title: string): string | null {
  if (/\bsenior associate dean\b/i.test(title)) return "Senior Associate Dean";
  if (/\bassociate dean\b/i.test(title)) return "Associate Dean";
  if (/\bassistant dean\b/i.test(title)) return "Assistant Dean";
  if (/\baffiliate dean\b/i.test(title)) return "Affiliate Dean";
  if (/\b(?:vice|deputy) dean\b/i.test(title)) return "Vice Dean";
  if (/\binterim dean\b/i.test(title)) return "Interim Dean";
  if (HAS_DEAN.test(title)) return "Dean"; // school-specific dean (Graduate School / Qatar)
  if (/\bprovost\b/i.test(title)) return "Provost";
  if (/\bpresident\b/i.test(title)) return "President";
  if (/\bexecutive vice (?:president|dean)\b|\bevp\b/i.test(title)) return "EVP";
  return null;
}

/**
 * Classify a scholar's leadership tier + display label from their title + the
 * chair/chief FK flags. THE Dean (tier 0) sorts above the active deanery (tier 1),
 * which sorts above FK chairs/chiefs (tier 2), which sort above everyone (tier 3).
 */
export function classifyLeadership(
  title: string | null,
  isChair: boolean,
  isChief: boolean,
): { tier: number; label: string | null } {
  const t = (title ?? "").trim();
  if (t && !TITLE_EMERITUS.test(t)) {
    if (HAS_DEAN.test(t) && !SUBDEAN_MODIFIER.test(t) && !SCHOOL_SPECIFIC_DEAN.test(t)) {
      return { tier: LEADERSHIP_TIER.dean, label: "Dean" };
    }
    const label = deaneryLabel(t);
    if (label) return { tier: LEADERSHIP_TIER.deanery, label };
  }
  if (isChair) return { tier: LEADERSHIP_TIER.chairChief, label: "Chair" };
  if (isChief) return { tier: LEADERSHIP_TIER.chairChief, label: "Chief" };
  return { tier: LEADERSHIP_TIER.none, label: null };
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Classify an overview's freshness (#6), agreeing with the #1077 edit surface:
 *  - "never"    — no overview at all
 *  - "imported" — a bio exists but has NO OverviewProvenance row (still the VIVO
 *                 seed, never edited in /edit) → no genuine last-edited date
 *  - "lt1yr"/"1to2yr"/"gt2yr" — edited in /edit; bucketed by the provenance date
 * `Scholar.overviewUpdatedAt` is dormant (never written) so it is NOT used.
 */
function classifyOverview(
  hasOverview: boolean,
  updatedAt: Date | string | null | undefined,
  now: number,
): { overviewState: OverviewState; overviewUpdatedAt: string | null } {
  if (!hasOverview) return { overviewState: "never", overviewUpdatedAt: null };
  if (!updatedAt) return { overviewState: "imported", overviewUpdatedAt: null };
  const d = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(d.getTime())) return { overviewState: "imported", overviewUpdatedAt: null };
  const ageYears = (now - d.getTime()) / MS_PER_YEAR;
  const state: OverviewState = ageYears < 1 ? "lt1yr" : ageYears < 2 ? "1to2yr" : "gt2yr";
  return { overviewState: state, overviewUpdatedAt: d.toISOString() };
}

export type HeadshotState = "present" | "missing" | "unknown";

export type DataQualityGapFilter = "all" | "no-headshot" | "no-overview" | "has-coi";

/** Overview-freshness bucket (#6); see `classifyOverview`. */
export type OverviewState = "never" | "imported" | "lt1yr" | "1to2yr" | "gt2yr";
/** The "overview last updated" filter — "all" plus the freshness buckets. */
export type OverviewAgeFilter = "all" | OverviewState;

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
  /** Leadership display label for the row/CSV ("Dean", "Associate Dean",
   *  "Provost", "Chair", "Chief", …) or null. */
  leadership: string | null;
  /** Leadership sort tier (0 Dean · 1 deanery · 2 chair/chief · 3 none). */
  leadershipTier: number;
  /** "present" | "missing" | "unknown" (not yet probed by etl:headshot). */
  headshot: HeadshotState;
  hasOverview: boolean;
  /** ISO date the overview was last edited in /edit; null when imported/never. */
  overviewUpdatedAt: string | null;
  /** Overview freshness bucket (#1077 parity). */
  overviewState: OverviewState;
  pendingCoiHigh: number;
  pendingCoiMedium: number;
  prominence: number;
  /** Deep link into the scholar's edit surface (the edit page enforces authz). */
  editHref: string;
};

export type DataQualityOptions = {
  /** Resolved viewer scope (`loadDataQualityScope`). */
  scope: DataQualityScope;
  /** Name / CWID substring search (#3); trimmed, empty = no filter. */
  query?: string;
  /** Person-type (roleCategory) multi-select (#4); raw DB values. Empty = no filter. */
  roleCategories?: readonly string[];
  /** Org-unit multi-select (#5): departments / divisions / centers, OR'd together. */
  units?: readonly EditRosterUnitFilter[];
  /** Gap-type filter; defaults to "all". */
  gap?: DataQualityGapFilter;
  /** Overview-freshness filter (#6); defaults to "all". */
  overviewAge?: OverviewAgeFilter;
  /** Include #536 hidden identity classes (doctoral students / alumni). Default
   *  true; ignored when a specific person-type is chosen. */
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

/** A center membership active by date today (pending / expired excluded). Mirrors
 *  `isCenterMembershipActive` (`lib/api/centers.ts`) — duplicated here so this
 *  module keeps its light, vitest-loadable import graph (no `server-only` /
 *  `lib/db`), exactly as `lib/api/edit-roster.ts` does. */
function isMembershipActive(
  startDate: Date | null,
  endDate: Date | null,
  today: string,
): boolean {
  const start = startDate ? startDate.toISOString().slice(0, 10) : null;
  const end = endDate ? endDate.toISOString().slice(0, 10) : null;
  if (start && start > today) return false; // pending
  if (end && end < today) return false; // expired
  return true;
}

/**
 * Build the candidate `where`: in-scope, active, non-deleted scholars, with the
 * optional name/CWID search, person-type, org-unit, and hidden-roles filters
 * applied. Each independent OR-group is pushed as its own element of `AND` so the
 * groups compose without clobbering one another.
 *
 * `filterCenterCwids` = members of the SELECTED center units (#5 filter);
 * `scopeCenterCwids` = members of the viewer's GRANTED center units (scope).
 */
function buildWhere(
  opts: DataQualityOptions,
  scopeCenterCwids: readonly string[],
  filterCenterCwids: readonly string[],
): Prisma.ScholarWhereInput {
  const and: Prisma.ScholarWhereInput[] = [];
  const where: Prisma.ScholarWhereInput = { deletedAt: null, status: "active" };

  // Name / CWID free-text search (#3) — its own AND clause so it never clobbers
  // the scope / unit / hidden-roles OR groups.
  const q = opts.query?.trim();
  if (q) {
    and.push({
      OR: [
        { preferredName: { contains: q } },
        { fullName: { contains: q } },
        { cwid: { contains: q } },
      ],
    });
  }

  // Person-type multi-select (#4). An explicit selection governs; the hidden-roles
  // toggle is then moot (the viewer asked for exactly these types).
  const roles = (opts.roleCategories ?? []).filter(Boolean);
  if (roles.length > 0) {
    where.roleCategory = { in: [...roles] };
  } else if (opts.includeHidden === false) {
    // Exclude hidden identity classes but KEEP nulls (fail-open display, #536).
    and.push({ OR: [{ roleCategory: null }, { roleCategory: { notIn: [...HIDDEN_ROLES] } }] });
  }

  // Org-unit multi-select (#5): selected departments / divisions / centers OR
  // together. Centers were pre-resolved to member cwids by the caller.
  const units = opts.units ?? [];
  if (units.length > 0) {
    const deptCodes = units.filter((u) => u.kind === "department").map((u) => u.code);
    const divCodes = units.filter((u) => u.kind === "division").map((u) => u.code);
    const unitOr: Prisma.ScholarWhereInput[] = [];
    if (deptCodes.length > 0) unitOr.push({ deptCode: { in: deptCodes } });
    if (divCodes.length > 0) unitOr.push({ divCode: { in: divCodes } });
    if (filterCenterCwids.length > 0) unitOr.push({ cwid: { in: [...filterCenterCwids] } });
    // Units selected but nothing resolves (e.g. an empty center) → match nothing
    // rather than silently dropping the filter.
    and.push(unitOr.length > 0 ? { OR: unitOr } : { cwid: { in: [] } });
  }

  if (opts.scope.all === false) {
    const scopeOr: Prisma.ScholarWhereInput[] = [];
    if (opts.scope.unitCodes.length > 0) {
      scopeOr.push({ deptCode: { in: opts.scope.unitCodes } });
      scopeOr.push({ divCode: { in: opts.scope.unitCodes } });
    }
    if (scopeCenterCwids.length > 0) scopeOr.push({ cwid: { in: [...scopeCenterCwids] } });
    // Empty scope → match nothing (the route forbids this case before we get here,
    // but be safe rather than returning everyone).
    and.push(scopeOr.length > 0 ? { OR: scopeOr } : { cwid: { in: [] } });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

/**
 * Compute the FULL, filtered, prominence-sorted entry set + summary counts —
 * shared by the paginated page loader and the (unpaginated) CSV export. Honors
 * everything in `opts` except `limit`/`offset`, which only the page loader applies.
 */
async function computeDataQualityEntries(
  opts: DataQualityOptions,
  client: DataQualityClient,
): Promise<{ entries: DataQualityEntry[]; counts: DataQualityCounts }> {
  // Center membership expands to member cwids (a center scopes by membership, not
  // a scholar column) for BOTH the viewer's granted scope and a selected center
  // *filter* (#5) — read in one query, partitioned in-app.
  const scopeCenterCodes =
    opts.scope.all === false ? opts.scope.centerCodes : [];
  const filterCenterCodes = (opts.units ?? [])
    .filter((u) => u.kind === "center")
    .map((u) => u.code);
  const allCenterCodes = [...new Set([...scopeCenterCodes, ...filterCenterCodes])];

  let scopeCenterCwids: string[] = [];
  let filterCenterCwids: string[] = [];
  if (allCenterCodes.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await client.centerMembership.findMany({
      where: { centerCode: { in: allCenterCodes } },
      select: { cwid: true, centerCode: true, startDate: true, endDate: true },
    });
    const scopeSet = new Set(scopeCenterCodes);
    const filterSet = new Set(filterCenterCodes);
    const scope = new Set<string>();
    const filter = new Set<string>();
    for (const r of rows) {
      // Exclude pending / expired memberships (consistent with every other center
      // surface) — a still-active scholar who rotated off a center must not appear
      // when that center is filtered or scoped.
      if (!isMembershipActive(r.startDate, r.endDate, today)) continue;
      if (scopeSet.has(r.centerCode)) scope.add(r.cwid);
      if (filterSet.has(r.centerCode)) filter.add(r.cwid);
    }
    scopeCenterCwids = [...scope];
    filterCenterCwids = [...filter];
  }

  const where = buildWhere(opts, scopeCenterCwids, filterCenterCwids);

  // Candidate identities + prominence inputs. The whole in-scope set loads (the
  // prominence sort is computed in-app over all of it, then paginated).
  const [candidates, chairRows, chiefRows, piRows, nihPiRows, coiRows, overrideRows, provRows] =
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
      // #1077 parity — the last-edited-in-/edit date; absence ⇒ imported VIVO seed.
      client.overviewProvenance.findMany({ select: { cwid: true, updatedAt: true } }),
    ]);

  const chairs = new Set(chairRows.map((r) => r.chairCwid).filter((c): c is string => !!c));
  const chiefs = new Set(chiefRows.map((r) => r.chiefCwid).filter((c): c is string => !!c));
  const piCount = new Map(piRows.map((r) => [r.cwid, r._count._all]));
  const nihPiCount = new Map(nihPiRows.map((r) => [r.cwid, r._count._all]));
  const overviewOverride = new Set(
    overrideRows.filter((r) => nonEmpty(r.value)).map((r) => r.entityId),
  );
  const provByCwid = new Map(provRows.map((r) => [r.cwid, r.updatedAt]));
  const coiHigh = new Map<string, number>();
  const coiMedium = new Map<string, number>();
  for (const r of coiRows) {
    if (r.tier === "High") coiHigh.set(r.cwid, r._count._all);
    else if (r.tier === "Medium") coiMedium.set(r.cwid, r._count._all);
  }

  const now = Date.now();

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

    const { tier, label } = classifyLeadership(s.primaryTitle ?? null, isChair, isChief);

    const headshot: HeadshotState =
      s.hasHeadshot === true ? "present" : s.hasHeadshot === false ? "missing" : "unknown";

    const hasOverview = nonEmpty(s.overview) || overviewOverride.has(s.cwid);
    const { overviewState, overviewUpdatedAt } = classifyOverview(
      hasOverview,
      provByCwid.get(s.cwid),
      now,
    );

    return {
      cwid: s.cwid,
      slug: s.slug,
      name: s.preferredName,
      title: s.primaryTitle ?? null,
      unit: s.department?.name ?? s.division?.name ?? null,
      roleCategory: s.roleCategory ?? null,
      isChair,
      isChief,
      leadership: label,
      leadershipTier: tier,
      headshot,
      hasOverview,
      overviewUpdatedAt,
      overviewState,
      pendingCoiHigh: coiHigh.get(s.cwid) ?? 0,
      pendingCoiMedium: coiMedium.get(s.cwid) ?? 0,
      prominence,
      editHref: `/edit/scholar/${encodeURIComponent(s.cwid)}`,
    };
  });

  // Summary counts across the in-scope, filtered set (before the gap/age filters).
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

  // Overview-age filter (#6) — independent of the gap filter above.
  if (opts.overviewAge && opts.overviewAge !== "all") {
    entries = entries.filter((e) => e.overviewState === opts.overviewAge);
  }

  // Leadership tier first (Dean #1), then prominence desc, then name asc for a
  // stable page boundary.
  entries.sort(
    (a, b) =>
      a.leadershipTier - b.leadershipTier ||
      b.prominence - a.prominence ||
      a.name.localeCompare(b.name),
  );

  return { entries, counts };
}

/** Load one page of the dashboard — the prominence-sorted slice + total + counts. */
export async function loadDataQualityRoster(
  opts: DataQualityOptions,
  client: DataQualityClient,
): Promise<DataQualityResult> {
  const { entries, counts } = await computeDataQualityEntries(opts, client);
  const total = entries.length;
  const take = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const skip = Math.max(opts.offset ?? 0, 0);
  return { entries: entries.slice(skip, skip + take), total, counts };
}

/** Upper bound on rows in one CSV export — keeps a steward's "export everything"
 *  bounded; the export route logs when it truncates. */
export const DATA_QUALITY_EXPORT_CAP = 5000;

export type DataQualityExport = {
  /** The top rows (prominence-sorted), capped at DATA_QUALITY_EXPORT_CAP. */
  rows: DataQualityEntry[];
  /** Total matching the filters, before the cap. */
  total: number;
  /** True when `total` exceeded the cap and `rows` was truncated. */
  truncated: boolean;
};

/**
 * The full (capped) filtered + prominence-sorted set for CSV export — same scope
 * and filters as the page, just unpaginated.
 */
export async function loadDataQualityExport(
  opts: DataQualityOptions,
  client: DataQualityClient,
): Promise<DataQualityExport> {
  const { entries } = await computeDataQualityEntries(opts, client);
  const total = entries.length;
  return {
    rows: entries.slice(0, DATA_QUALITY_EXPORT_CAP),
    total,
    truncated: total > DATA_QUALITY_EXPORT_CAP,
  };
}

const CSV_HEADERS = [
  "rank",
  "cwid",
  "name",
  "title",
  "unit",
  "person_type",
  "leadership",
  "headshot",
  "has_overview",
  "overview_updated",
  "pending_coi_high",
  "pending_coi_medium",
  "prominence",
] as const;

/** The CSV "overview_updated" cell: the edit date (YYYY-MM-DD) when known,
 *  "imported" for the un-edited VIVO seed, "" when there's no overview. */
function overviewUpdatedCell(e: DataQualityEntry): string {
  if (e.overviewUpdatedAt) return e.overviewUpdatedAt.slice(0, 10);
  return e.overviewState === "imported" ? "imported" : "";
}

/** Serialize export rows to a CSV string. `rank` is the 1-based position in the
 *  prominence-sorted set the rows arrive in. */
export function buildDataQualityCsv(rows: readonly DataQualityEntry[]): string {
  const body = rows.map((e, i) => [
    i + 1,
    e.cwid,
    e.name,
    e.title ?? "",
    e.unit ?? "",
    formatRoleCategory(e.roleCategory) ?? e.roleCategory ?? "",
    e.leadership ?? "",
    e.headshot,
    e.hasOverview ? "yes" : "no",
    overviewUpdatedCell(e),
    e.pendingCoiHigh,
    e.pendingCoiMedium,
    e.prominence.toFixed(2),
  ]);
  return toCsv(CSV_HEADERS, body);
}

// ---------------------------------------------------------------------------
// Shared param parsing (#3/#4/#5/#6) — the page and the export route parse the
// SAME query string identically through this helper, so they can never drift.
// ---------------------------------------------------------------------------

function parseGap(v: string | undefined): DataQualityGapFilter {
  return v === "no-headshot" || v === "no-overview" || v === "has-coi" ? v : "all";
}

function parseOverviewAge(v: string | undefined): OverviewAgeFilter {
  return v === "imported" || v === "never" || v === "lt1yr" || v === "1to2yr" || v === "gt2yr"
    ? v
    : "all";
}

/** Decode a unit-filter value (`dept:CODE` / `div:CODE` / `center:CODE`). */
function parseUnitValue(v: string): EditRosterUnitFilter | null {
  const sep = v.indexOf(":");
  if (sep < 0) return null;
  const kind = v.slice(0, sep);
  const code = v.slice(sep + 1);
  if (!code) return null;
  if (kind === "dept") return { kind: "department", code };
  if (kind === "div") return { kind: "division", code };
  if (kind === "center") return { kind: "center", code };
  return null;
}

export type ParsedDataQualityParams = {
  q: string;
  roleCategories: string[];
  units: EditRosterUnitFilter[];
  /** The raw encoded unit values (`dept:CODE` …) — for href building + UI seeding. */
  unitValues: string[];
  gap: DataQualityGapFilter;
  overviewAge: OverviewAgeFilter;
  includeHidden: boolean;
  page: number;
};

/**
 * Parse the dashboard's filter/pagination query params from EITHER a Web
 * `URLSearchParams` (the export route) OR a Next.js searchParams object (the
 * page) — the dual-source idiom from `lib/api/search-flags.ts`. Multi-value
 * params (`type`, `unit`) arrive as repeated keys.
 */
export function parseDataQualityParams(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): ParsedDataQualityParams {
  const valuesOf = (key: string): string[] => {
    if (source instanceof URLSearchParams) return source.getAll(key);
    const raw = source[key];
    return Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  };
  const first = (key: string): string | undefined => valuesOf(key)[0];

  const q = (first("q") ?? "").trim();
  const roleCategories = valuesOf("type")
    .map((v) => v.trim())
    .filter(Boolean);
  const unitValues = valuesOf("unit")
    .map((v) => v.trim())
    .filter(Boolean);
  const units = unitValues
    .map(parseUnitValue)
    .filter((u): u is EditRosterUnitFilter => u !== null);
  const hidden = first("hidden");

  return {
    q,
    roleCategories,
    units,
    unitValues,
    gap: parseGap(first("gap")),
    overviewAge: parseOverviewAge(first("overviewAge")),
    includeHidden: !(hidden === "0" || hidden === "false"),
    page: Math.max(Number.parseInt(first("page") ?? "0", 10) || 0, 0),
  };
}

// ---------------------------------------------------------------------------
// Filter-bar facet options (#4/#5) — person types + the org-unit hierarchy
// (departments with their child divisions + a flat centers group), each with a
// static active-scholar count for the RosterFacet UI.
// ---------------------------------------------------------------------------

/** One selectable facet value with a count, matching the RosterFacet shape. */
export type DataQualityFacetOption = { value: string; label: string; count: number };

export type DataQualityFacets = {
  /** Person types present on active scholars, with counts. */
  roleCategories: DataQualityFacetOption[];
  /** Departments (value `dept:CODE`) each with their child divisions (`div:CODE`). */
  departments: Array<DataQualityFacetOption & { divisions: DataQualityFacetOption[] }>;
  /** Research centers (value `center:CODE`), with active-member counts. */
  centers: DataQualityFacetOption[];
};

const ACTIVE_WHERE = { deletedAt: null, status: "active" } as const;

/**
 * Load the filter-bar facets. Counts are STATIC (independent of the other current
 * filters) — meaningful as a baseline and cheap (a handful of grouped aggregates).
 * The option set is the full catalog, matching v1's global dropdowns; the query
 * (not the option list) remains the scope boundary.
 *
 * Dept / division / role counts are active scholars (`ACTIVE_WHERE`). Center
 * counts are date-active MEMBERSHIPS (pending / expired excluded, matching the
 * center filter); note a center count can still slightly exceed the filtered row
 * count because a membership cannot be joined to the scholar's active status in a
 * `groupBy` — a few may point at since-inactivated scholars.
 */
export async function loadDataQualityFacets(client: DataQualityClient): Promise<DataQualityFacets> {
  const today = new Date();
  const [deptRows, divRows, ctrRows, roleAgg, deptAgg, divAgg, ctrAgg] = await Promise.all([
    client.department.findMany({ select: { code: true, name: true }, orderBy: { name: "asc" } }),
    client.division.findMany({
      select: { code: true, name: true, deptCode: true },
      orderBy: { name: "asc" },
    }),
    client.center.findMany({ select: { code: true, name: true }, orderBy: { name: "asc" } }),
    client.scholar.groupBy({ by: ["roleCategory"], where: ACTIVE_WHERE, _count: { _all: true } }),
    client.scholar.groupBy({ by: ["deptCode"], where: ACTIVE_WHERE, _count: { _all: true } }),
    client.scholar.groupBy({ by: ["divCode"], where: ACTIVE_WHERE, _count: { _all: true } }),
    client.centerMembership.groupBy({
      by: ["centerCode"],
      where: {
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: today } }] },
          { OR: [{ endDate: null }, { endDate: { gte: today } }] },
        ],
      },
      _count: { _all: true },
    }),
  ]);

  const roleCount = new Map(
    roleAgg.map((r) => [r.roleCategory ?? "", r._count._all] as const),
  );
  const deptCount = new Map(deptAgg.map((r) => [r.deptCode ?? "", r._count._all] as const));
  const divCount = new Map(divAgg.map((r) => [r.divCode ?? "", r._count._all] as const));
  const ctrCount = new Map(ctrAgg.map((r) => [r.centerCode, r._count._all] as const));

  const roleCategories: DataQualityFacetOption[] = roleAgg
    .map((r) => r.roleCategory)
    .filter((v): v is string => Boolean(v))
    .map((value) => ({
      value,
      label: formatRoleCategory(value) ?? value,
      count: roleCount.get(value) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Division names are unique only WITHIN a department (e.g. both Medicine and
  // Pediatrics have a "Cardiology"). Disambiguate a non-unique name with its parent
  // department so the rows aren't indistinguishable in the facet — especially under
  // search, where the parent dept may be filtered out and the indent loses meaning.
  const deptNameByCode = new Map(deptRows.map((d) => [d.code, d.name] as const));
  const divNameCounts = new Map<string, number>();
  for (const d of divRows) divNameCounts.set(d.name, (divNameCounts.get(d.name) ?? 0) + 1);

  const divByDept = new Map<string, DataQualityFacetOption[]>();
  for (const d of divRows) {
    const parent = deptNameByCode.get(d.deptCode);
    const ambiguous = (divNameCounts.get(d.name) ?? 0) > 1;
    const label = ambiguous && parent ? `${d.name} (${parent})` : d.name;
    const arr = divByDept.get(d.deptCode) ?? [];
    arr.push({ value: `div:${d.code}`, label, count: divCount.get(d.code) ?? 0 });
    divByDept.set(d.deptCode, arr);
  }

  const departments = deptRows.map((dep) => ({
    value: `dept:${dep.code}`,
    label: dep.name,
    count: deptCount.get(dep.code) ?? 0,
    divisions: divByDept.get(dep.code) ?? [],
  }));

  const centers: DataQualityFacetOption[] = ctrRows.map((c) => ({
    value: `center:${c.code}`,
    label: c.name,
    count: ctrCount.get(c.code) ?? 0,
  }));

  return { roleCategories, departments, centers };
}
