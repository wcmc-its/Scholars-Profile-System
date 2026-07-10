/**
 * The Profiles roster query for `/edit/scholars` (#160 UI follow-up,
 * `self-edit-launch-spec.md` § The Profiles roster).
 *
 * The roster is the admin entry point — the searchable scholar index used to
 * *find* a profile before editing it (the superuser today deep-links by CWID;
 * there is no such screen). This is the server read behind that page; the
 * Apollo-styled table is a separate (UI) deliverable.
 *
 * Authorization is the *page's* responsibility, not this query's — the page is
 * superuser-gated (and, later, org-unit-admin-gated). The one scope concern
 * that MUST live in the query (so the UI is never the boundary) is the
 * org-unit-admin's unit scope: pass `unitCodeScope` and the query returns only
 * in-scope scholars. A superuser omits it and sees everyone. That scope source
 * (`managedUnits`) and its wiring are the separate B3 workstream; this query
 * provides the inert seam (an optional param), nothing more.
 *
 * Server-only by construction (uses Prisma) — no `server-only` import so it
 * loads under vitest with a fake client, matching `edit-context.ts`.
 */
import { formatRoleCategory } from "@/lib/role-display";
import { buildScholarNameClauses } from "@/lib/api/scholar-name-search";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface the roster query needs — a client or tx satisfies it.
 *  `centerMembership` is read only for the center org-unit filter. */
type EditRosterClient = Pick<PrismaClient, "scholar" | "centerMembership">;

/** The Prisma surface the facet loader needs (the filter dropdown option lists). */
type RosterFacetClient = Pick<PrismaClient, "scholar" | "department" | "division" | "center">;

/** One row in the roster table. */
export type EditRosterEntry = {
  cwid: string;
  slug: string;
  /** Display name (`preferredName`); CWID is shown alongside it in the table. */
  name: string;
  /** The SOR title (`primaryTitle`); null when the scholar has none on file. */
  title: string | null;
  /** Department name, falling back to division; null when neither is set. */
  unit: string | null;
  /** Role category (person type), raw DB value, e.g. "full_time_faculty"; null
   *  when unset. The table formats it via `formatRoleCategory`. */
  roleCategory: string | null;
  /** True when the profile is publicly visible (`status === 'active'`); false
   *  when it is suppressed (self or admin). Drives the Visible / Hidden chip. */
  isVisible: boolean;
};

export type EditRosterStatusFilter = "all" | "visible" | "hidden";

/** A single org-unit filter — one department, division, or center. */
export type EditRosterUnitFilter =
  | { kind: "department"; code: string }
  | { kind: "division"; code: string }
  | { kind: "center"; code: string };

export type EditRosterOptions = {
  /** Name / CWID substring search; trimmed, empty = no filter. */
  query?: string;
  /** Visibility filter; defaults to "all". */
  status?: EditRosterStatusFilter;
  /** Role-category (person-type) filter; raw DB value. Empty = no filter. */
  roleCategory?: string;
  /** Org-unit filter — a single department, division, or center. */
  unit?: EditRosterUnitFilter;
  /**
   * Org-unit-admin scope (B3): dept/div codes the admin manages. When provided,
   * only scholars in one of those units are returned; an empty array returns
   * nothing (an admin managing no units). Omit for a superuser (sees all).
   * Center-membership scope is a B3 detail handled where `managedUnits` is
   * resolved — this column-based filter covers dept + division.
   */
  unitCodeScope?: readonly string[];
  /** Page size (default 50, capped at 200). */
  limit?: number;
  /** Page offset (default 0). */
  offset?: number;
};

export type EditRosterResult = {
  entries: EditRosterEntry[];
  /** Total matching the filters (before limit/offset) — drives pagination. */
  total: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function buildWhere(opts: EditRosterOptions): Prisma.ScholarWhereInput {
  const where: Prisma.ScholarWhereInput = { deletedAt: null };
  // Independent OR-groups compose here so none clobbers another (the name search
  // and the unit scope are both OR-groups AND'd together).
  const and: Prisma.ScholarWhereInput[] = [];

  if (opts.status === "visible") {
    where.status = "active";
  } else if (opts.status === "hidden") {
    // "Hidden" mirrors the public profile's `status: "active"` gate — anything
    // not active (i.e. suppressed) is not publicly visible.
    where.status = { not: "active" };
  }

  const q = opts.query?.trim();
  if (q) and.push(...buildScholarNameClauses(q));

  if (opts.roleCategory) {
    where.roleCategory = opts.roleCategory;
  }

  // Org-unit filter. Department/division are scholar columns; a center filter
  // needs an async membership read, so it is applied in `loadEditRoster`.
  const unit = opts.unit;
  if (unit?.kind === "department") {
    where.deptCode = unit.code;
  } else if (unit?.kind === "division") {
    where.divCode = unit.code;
  }

  if (opts.unitCodeScope) {
    // In-scope iff the scholar's dept or division is one the admin manages. An
    // empty scope → `in: []` → no rows.
    and.push({
      OR: [{ deptCode: { in: [...opts.unitCodeScope] } }, { divCode: { in: [...opts.unitCodeScope] } }],
    });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

/**
 * Load one page of the Profiles roster. Excludes soft-deleted (departed)
 * scholars — they have nothing to edit, consistent with `loadEditContext`
 * returning null for them.
 */
export async function loadEditRoster(
  opts: EditRosterOptions,
  client: EditRosterClient,
): Promise<EditRosterResult> {
  const where = buildWhere(opts);

  // Center org-unit filter: restrict to CWIDs whose membership is active *by
  // date* today. The visibility / search / role filters from `buildWhere` still
  // apply on top, so — unlike the public `loadActiveCenterMemberCwids` — this
  // does NOT pre-gate on `status='active'`.
  if (opts.unit?.kind === "center") {
    where.cwid = { in: await activeCenterMemberCwids(opts.unit.code, client) };
  }

  const take = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const skip = Math.max(opts.offset ?? 0, 0);

  const [rows, total] = await Promise.all([
    client.scholar.findMany({
      where,
      select: {
        cwid: true,
        slug: true,
        preferredName: true,
        primaryTitle: true,
        status: true,
        roleCategory: true,
        department: { select: { name: true } },
        division: { select: { name: true } },
      },
      orderBy: [{ preferredName: "asc" }, { cwid: "asc" }],
      take,
      skip,
    }),
    client.scholar.count({ where }),
  ]);

  const entries: EditRosterEntry[] = rows.map((s) => ({
    cwid: s.cwid,
    slug: s.slug,
    name: s.preferredName,
    title: s.primaryTitle ?? null,
    unit: s.department?.name ?? s.division?.name ?? null,
    roleCategory: s.roleCategory ?? null,
    isVisible: s.status === "active",
  }));

  return { entries, total };
}

/**
 * CWIDs whose membership in `centerCode` is active by date today (pending and
 * expired excluded). The date predicate mirrors `isCenterMembershipActive`
 * (`lib/api/centers.ts`) — duplicated here deliberately so this module keeps
 * its light, vitest-loadable import graph (no `server-only`, no `lib/db`).
 */
async function activeCenterMemberCwids(
  centerCode: string,
  client: EditRosterClient,
): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await client.centerMembership.findMany({
    where: { centerCode },
    select: { cwid: true, startDate: true, endDate: true },
  });
  return rows
    .filter((r) => {
      const start = r.startDate ? r.startDate.toISOString().slice(0, 10) : null;
      const end = r.endDate ? r.endDate.toISOString().slice(0, 10) : null;
      if (start && start > today) return false; // pending
      if (end && end < today) return false; // expired
      return true;
    })
    .map((r) => r.cwid);
}

/** The filter dropdown option lists for the roster. */
export type RosterFacets = {
  departments: { code: string; name: string }[];
  divisions: { code: string; name: string }[];
  centers: { code: string; name: string }[];
  /** Present role categories (person types) with display labels. */
  roleCategories: { value: string; label: string }[];
};

/**
 * Load the org-unit + person-type filter options. Units are listed in full (the
 * catalog is small); person types are the role categories actually present on
 * non-deleted scholars, labelled via `formatRoleCategory`.
 */
export async function loadRosterFacets(client: RosterFacetClient): Promise<RosterFacets> {
  const [departments, divisions, centers, roleRows] = await Promise.all([
    client.department.findMany({ select: { code: true, name: true }, orderBy: { name: "asc" } }),
    client.division.findMany({ select: { code: true, name: true }, orderBy: { name: "asc" } }),
    client.center.findMany({ select: { code: true, name: true }, orderBy: { name: "asc" } }),
    client.scholar.findMany({
      where: { deletedAt: null, roleCategory: { not: null } },
      select: { roleCategory: true },
      distinct: ["roleCategory"],
    }),
  ]);

  const roleCategories = roleRows
    .map((r) => r.roleCategory)
    .filter((v): v is string => Boolean(v))
    .map((value) => ({ value, label: formatRoleCategory(value) ?? value }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { departments, divisions, centers, roleCategories };
}
