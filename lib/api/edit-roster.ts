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
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface the roster needs — a client or tx satisfies it. */
type EditRosterClient = Pick<PrismaClient, "scholar">;

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
  /** True when the profile is publicly visible (`status === 'active'`); false
   *  when it is suppressed (self or admin). Drives the Visible / Hidden chip. */
  isVisible: boolean;
};

export type EditRosterStatusFilter = "all" | "visible" | "hidden";

export type EditRosterOptions = {
  /** Name / CWID substring search; trimmed, empty = no filter. */
  query?: string;
  /** Visibility filter; defaults to "all". */
  status?: EditRosterStatusFilter;
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

  if (opts.status === "visible") {
    where.status = "active";
  } else if (opts.status === "hidden") {
    // "Hidden" mirrors the public profile's `status: "active"` gate — anything
    // not active (i.e. suppressed) is not publicly visible.
    where.status = { not: "active" };
  }

  const q = opts.query?.trim();
  if (q) {
    where.OR = [
      { preferredName: { contains: q } },
      { fullName: { contains: q } },
      { cwid: { contains: q } },
    ];
  }

  if (opts.unitCodeScope) {
    // AND'd with the search OR-group above: in-scope iff the scholar's dept or
    // division is one the admin manages. An empty scope → `in: []` → no rows.
    where.AND = [
      { OR: [{ deptCode: { in: [...opts.unitCodeScope] } }, { divCode: { in: [...opts.unitCodeScope] } }] },
    ];
  }

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
    isVisible: s.status === "active",
  }));

  return { entries, total };
}
