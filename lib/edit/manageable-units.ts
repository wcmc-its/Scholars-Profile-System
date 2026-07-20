/**
 * "Units you manage" — enumerate the org units an actor may curate (#753).
 *
 * The unit-curation editor pages (`/edit/{department,division,center}/[code]`,
 * #540) shipped without an entry point: the only way in was a deep link with a
 * known code. This module is the listing behind the new entry points — the
 * summary card on the `/edit` Home panel and the `/edit/units` index.
 *
 * What it lists are the actor's **direct** `unit_admin` grants, resolved to a
 * name + edit href and grouped by kind. It deliberately does NOT flatten the
 * dept→division cascade (Amendment 1 § A1.2): a department Owner manages "the
 * Department of Medicine" as one entry, then reaches its divisions from that
 * page's sibling rail — listing every child division here would bury the signal.
 * The cascade still governs page-level authorization (`lib/edit/authz.ts`); it
 * just isn't how this navigation enumerates.
 *
 * A grant whose unit row no longer exists (retired and pruned) is dropped from
 * the listing — the link would only 404/403. Superusers are not enumerated here
 * (they would match every unit); the index page gives them a finder instead
 * (`loadAllUnitsForFinder`).
 *
 * Server-only by construction (reads Prisma) but with no `server-only` import,
 * so the unit tests can load it with a fake client — matching the convention in
 * `administrators.ts` / `impersonation-display.ts`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { countActiveCenterMembersByCode } from "@/lib/api/center-member-count";
import { EXTERNAL_LEADERS } from "@/lib/external-leaders";
import { compactUnitName, officialUnitName } from "@/lib/org-unit-names";

/** The three org-unit `EntityType`s a `unit_admin` grant can target. */
export type ManageableUnitKind = "department" | "division" | "center";

/** The two `UnitRole`s a grant carries. */
export type ManageableUnitRole = "owner" | "curator";

/** One unit the actor may curate, resolved for display + linking. */
export type ManageableUnit = {
  kind: ManageableUnitKind;
  code: string;
  name: string;
  role: ManageableUnitRole;
  /** The unit's editor route, e.g. `/edit/division/N1234`. */
  href: string;
};

/** The actor's directly-granted units, grouped by kind (each group name-sorted). */
export type ManageableUnits = {
  departments: ManageableUnit[];
  divisions: ManageableUnit[];
  centers: ManageableUnit[];
  /** Total across all three groups — drives the "self-hide when zero" gate. */
  total: number;
};

/** One entry in the superuser unit finder — every unit, name-sorted. */
export type UnitFinderEntry = {
  kind: ManageableUnitKind;
  code: string;
  name: string;
  href: string;
};

/** The narrow Prisma surface these helpers read — a `db.read` client satisfies it. */
export type ManageableUnitsClient = Pick<
  PrismaClient,
  "unitAdmin" | "department" | "division" | "center"
>;

function isManageableKind(value: string): value is ManageableUnitKind {
  return value === "department" || value === "division" || value === "center";
}

/** The unit's editor route. `code` is URL-encoded — LDAP N-codes are safe, but
 *  synthetic center codes are minted and should never break the path. */
export function unitEditHref(kind: ManageableUnitKind, code: string): string {
  return `/edit/${kind}/${encodeURIComponent(code)}`;
}

const KIND_LABEL: Record<ManageableUnitKind, string> = {
  department: "Department",
  division: "Division",
  center: "Center",
};

/** Display label for a unit kind ("Department" | "Division" | "Center"). */
export function unitKindLabel(kind: ManageableUnitKind): string {
  return KIND_LABEL[kind];
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/**
 * Load the units `cwid` may curate from their direct `unit_admin` grants.
 *
 * Dedupes a unit granted twice to the same person (keeps the higher role —
 * owner subsumes curator), resolves each unit's name in one batched query per
 * kind, drops grants whose unit row is gone, and returns the three groups
 * name-sorted. Returns all-empty (`total: 0`) for an actor with no grants —
 * the callers self-hide on that.
 */
export async function loadManageableUnits(
  cwid: string,
  db: ManageableUnitsClient,
): Promise<ManageableUnits> {
  const grants = await db.unitAdmin.findMany({
    where: { cwid },
    select: { entityType: true, entityId: true, role: true },
  });

  // Dedupe (kind, code) → highest role. owner wins over curator.
  const best = new Map<
    string,
    { kind: ManageableUnitKind; code: string; role: ManageableUnitRole }
  >();
  for (const g of grants) {
    if (!isManageableKind(g.entityType)) continue;
    const key = `${g.entityType}:${g.entityId}`;
    const existing = best.get(key);
    if (!existing || (existing.role === "curator" && g.role === "owner")) {
      best.set(key, { kind: g.entityType, code: g.entityId, role: g.role });
    }
  }
  if (best.size === 0) {
    return { departments: [], divisions: [], centers: [], total: 0 };
  }

  // Collect codes per kind for one batched name lookup each.
  const codes: Record<ManageableUnitKind, string[]> = { department: [], division: [], center: [] };
  for (const u of best.values()) codes[u.kind].push(u.code);

  const [deptRows, divRows, ctrRows] = await Promise.all([
    codes.department.length
      ? db.department.findMany({
          where: { code: { in: codes.department } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
    codes.division.length
      ? db.division.findMany({
          where: { code: { in: codes.division } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
    codes.center.length
      ? db.center.findMany({
          where: { code: { in: codes.center } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const names: Record<ManageableUnitKind, Map<string, string>> = {
    department: new Map(deptRows.map((r) => [r.code, r.name])),
    division: new Map(divRows.map((r) => [r.code, r.name])),
    center: new Map(ctrRows.map((r) => [r.code, r.name])),
  };

  const groups: Record<ManageableUnitKind, ManageableUnit[]> = {
    department: [],
    division: [],
    center: [],
  };
  for (const u of best.values()) {
    const name = names[u.kind].get(u.code);
    if (name === undefined) continue; // grant points at a unit that no longer exists — skip
    groups[u.kind].push({
      kind: u.kind,
      code: u.code,
      name,
      role: u.role,
      href: unitEditHref(u.kind, u.code),
    });
  }
  groups.department.sort(byName);
  groups.division.sort(byName);
  groups.center.sort(byName);

  return {
    departments: groups.department,
    divisions: groups.division,
    centers: groups.center,
    total: groups.department.length + groups.division.length + groups.center.length,
  };
}

/**
 * Every unit, name-sorted, for the superuser "jump to any unit" finder on the
 * `/edit/units` index. The org chart is bounded (departments + divisions +
 * centers number in the hundreds), so — like `DepartmentPicker` — the full set
 * loads once and filters in-memory. Only called for superusers.
 */
export async function loadAllUnitsForFinder(db: ManageableUnitsClient): Promise<UnitFinderEntry[]> {
  const [depts, divs, ctrs] = await Promise.all([
    db.department.findMany({ select: { code: true, name: true } }),
    db.division.findMany({ select: { code: true, name: true } }),
    db.center.findMany({ select: { code: true, name: true } }),
  ]);
  const entries: UnitFinderEntry[] = [
    ...depts.map((r) => ({
      kind: "department" as const,
      code: r.code,
      name: r.name,
      href: unitEditHref("department", r.code),
    })),
    ...divs.map((r) => ({
      kind: "division" as const,
      code: r.code,
      name: r.name,
      href: unitEditHref("division", r.code),
    })),
    ...ctrs.map((r) => ({
      kind: "center" as const,
      code: r.code,
      name: r.name,
      href: unitEditHref("center", r.code),
    })),
  ];
  return entries.sort(byName);
}

/**
 * One unit in the complete org-unit directory (#971) — the info-rich,
 * superuser/comms-steward-only listing of EVERY department, division, and
 * center on `/edit/units`. Far richer than `UnitFinderEntry` (which is just a
 * jump target): it carries the curated names, leadership, counts, provenance,
 * and curation-gap signals the directory surfaces and flags.
 *
 * Plain-serializable by construction (only strings / numbers / booleans / null
 * — no Date, no Prisma model instance) so it crosses the server→client boundary
 * into the `AllUnitsDirectory` client component without a server-action wrapper.
 */
export type UnitDirectoryEntry = {
  kind: ManageableUnitKind;
  code: string;
  /** Canonical `name` — the heading fallback when no official override exists. */
  name: string;
  /** Resolved full / official name (officialName ?? name). The row heading. */
  officialName: string;
  /** Resolved short / compact name (compactName ?? officialName ?? name). */
  compactName: string;
  description: string | null;
  slug: string;
  kindLabel: string;
  /** Department-only browse bucket (clinical|basic|mixed|administrative); null otherwise. */
  category: string | null;
  /** Center-only presentation kind; null for departments + divisions. */
  centerType: "center" | "institute" | null;
  /** The raw leader column value (chair/chief/director) — for reference even when unresolved. */
  leaderCwid: string | null;
  /**
   * The leader's display name, resolved from the external-leader overlay then
   * the scholar table. NULL when the unit has no leader, or has a leaderCwid
   * that resolves to neither — the null IS the curation-gap signal the UI flags
   * (we deliberately do NOT fall back to the bare cwid, which would mask it).
   */
  leaderName: string | null;
  /** Center-only interim qualifier (dept/div interim lives in a field_override row, not read here). */
  leaderInterim: boolean;
  scholarCount: number;
  source: string;
  /** Division-only parent department (via the `deptCode` FK); null otherwise. */
  parentDeptCode: string | null;
  parentDeptName: string | null;
  /** Center-only ordering hint; null for departments + divisions. */
  sortOrder: number | null;
  /** Retired = a live Suppression row (revokedAt IS NULL); there is no column. */
  retired: boolean;
  href: string;
};

/** The narrow Prisma surface `loadAllUnitsDirectory` reads — `db.read` satisfies it. */
export type AllUnitsDirectoryClient = Pick<
  PrismaClient,
  "department" | "division" | "center" | "suppression" | "scholar" | "centerMembership"
>;

/**
 * The complete org-unit directory (#971) — every department, division, and
 * center resolved to a display-rich `UnitDirectoryEntry`, kind-then-name sorted.
 *
 * Bounded work: the org chart is ~50 units (≈30-40 depts + a few divisions +
 * ~8-11 centers), so this issues exactly five batched queries regardless of
 * size — three `findMany` (one per kind) in parallel, ONE `suppression.findMany`
 * for the retired set (not findFirst-per-unit), and ONE `scholar.findMany` for
 * every leader name at once (mirroring `resolveScholarNames` in
 * `lib/api/unit-edit-context.ts`).
 *
 * Field degradation (only columns present on this checkout are read):
 *   - Division has NO officialName/compactName/category/centerType/sortOrder/
 *     leaderInterim columns → official = compact = name, category/centerType/
 *     sortOrder = null, leaderInterim = false.
 *   - Center has NO parent-dept FK → parentDeptCode/parentDeptName always null.
 *   - No active/retired/deletedAt column on any unit → `retired` is derived from
 *     a Suppression row with revokedAt IS NULL.
 *
 * Leadership resolution: the external-leader overlay (`EXTERNAL_LEADERS`, keyed
 * by UNIT code) wins, then the scholar table, then null. Departments and
 * divisions carry their leader/interim qualifier in a per-unit `field_override`
 * row, which this directory deliberately does NOT read (that path is N queries).
 * So a PENDING dept/div leader override or interim flag won't show here — only
 * the row column (chairCwid/chiefCwid/directorCwid) is read. Acceptable for a
 * low-stakes, read-only audit view; centers (leader + interim in-row) are
 * faithful.
 *
 * Retired rows are hidden unless `opts.includeRetired` — the page passes
 * `session.isSuperuser`, so only superusers see retired units (comms stewards do
 * not), matching the retired gate in `unit-edit-context.ts`.
 */
export async function loadAllUnitsDirectory(
  db: AllUnitsDirectoryClient,
  opts?: { includeRetired?: boolean },
): Promise<UnitDirectoryEntry[]> {
  const [deptRows, divRows, ctrRows, suppressions] = await Promise.all([
    db.department.findMany({
      select: {
        code: true,
        name: true,
        slug: true,
        description: true,
        officialName: true,
        compactName: true,
        category: true,
        chairCwid: true,
        scholarCount: true,
        source: true,
      },
    }),
    db.division.findMany({
      select: {
        code: true,
        name: true,
        slug: true,
        description: true,
        chiefCwid: true,
        scholarCount: true,
        source: true,
        deptCode: true,
        department: { select: { name: true } },
      },
    }),
    db.center.findMany({
      select: {
        code: true,
        name: true,
        slug: true,
        description: true,
        officialName: true,
        compactName: true,
        centerType: true,
        directorCwid: true,
        leaderInterim: true,
        // NB: `scholarCount` is deliberately NOT selected — the column is never
        // maintained for centers. Counted live below.
        sortOrder: true,
        source: true,
      },
    }),
    db.suppression.findMany({
      where: {
        entityType: { in: ["department", "division", "center"] },
        revokedAt: null,
      },
      select: { entityType: true, entityId: true },
    }),
  ]);

  // One Set of `${kind}:${code}` for the retired flag — no per-unit lookup.
  const retiredSet = new Set(suppressions.map((s) => `${s.entityType}:${s.entityId}`));

  // Centers count live: `Center.scholarCount` is never maintained. Two
  // batched queries, so the directory stays O(1) in the number of centers.
  const centerCounts = await countActiveCenterMembersByCode(
    db,
    ctrRows.map((r) => r.code),
  );

  // One batched scholar name lookup for every leader cwid across all kinds.
  const leaderCwids = [
    ...deptRows.map((r) => r.chairCwid),
    ...divRows.map((r) => r.chiefCwid),
    ...ctrRows.map((r) => r.directorCwid),
  ].filter((c): c is string => !!c && c.length > 0);
  const uniqueLeaders = [...new Set(leaderCwids)];
  const nameMap = new Map<string, string>();
  if (uniqueLeaders.length > 0) {
    const rows = await db.scholar.findMany({
      where: { cwid: { in: uniqueLeaders } },
      select: { cwid: true, preferredName: true },
    });
    for (const row of rows) nameMap.set(row.cwid, row.preferredName);
  }

  // Resolve a leader's display name: external overlay (by unit code) → scholar
  // table → null. Null (never the bare cwid) is the curation-gap signal.
  function resolveLeader(code: string, leaderCwid: string | null): string | null {
    const external = EXTERNAL_LEADERS[code];
    if (external) return external.name;
    if (leaderCwid && nameMap.has(leaderCwid)) return nameMap.get(leaderCwid) ?? null;
    return null;
  }

  const entries: UnitDirectoryEntry[] = [
    ...deptRows.map(
      (r): UnitDirectoryEntry => ({
        kind: "department",
        code: r.code,
        name: r.name,
        officialName: officialUnitName(r),
        compactName: compactUnitName(r),
        description: r.description,
        slug: r.slug,
        kindLabel: unitKindLabel("department"),
        category: r.category,
        centerType: null,
        leaderCwid: r.chairCwid,
        leaderName: resolveLeader(r.code, r.chairCwid),
        leaderInterim: false,
        scholarCount: r.scholarCount,
        source: r.source,
        parentDeptCode: null,
        parentDeptName: null,
        sortOrder: null,
        retired: retiredSet.has(`department:${r.code}`),
        href: unitEditHref("department", r.code),
      }),
    ),
    ...divRows.map(
      (r): UnitDirectoryEntry => ({
        kind: "division",
        code: r.code,
        name: r.name,
        // Divisions have no official/compact columns — the resolvers see only
        // `name`, so both coalesce to it (graceful degradation).
        officialName: officialUnitName({ name: r.name }),
        compactName: compactUnitName({ name: r.name }),
        description: r.description,
        slug: r.slug,
        kindLabel: unitKindLabel("division"),
        category: null,
        centerType: null,
        leaderCwid: r.chiefCwid,
        leaderName: resolveLeader(r.code, r.chiefCwid),
        leaderInterim: false,
        scholarCount: r.scholarCount,
        source: r.source,
        parentDeptCode: r.deptCode,
        parentDeptName: r.department?.name ?? null,
        sortOrder: null,
        retired: retiredSet.has(`division:${r.code}`),
        href: unitEditHref("division", r.code),
      }),
    ),
    ...ctrRows.map(
      (r): UnitDirectoryEntry => ({
        kind: "center",
        code: r.code,
        name: r.name,
        officialName: officialUnitName(r),
        compactName: compactUnitName(r),
        description: r.description,
        slug: r.slug,
        kindLabel: unitKindLabel("center"),
        category: null,
        centerType: r.centerType === "institute" ? "institute" : "center",
        leaderCwid: r.directorCwid,
        leaderName: resolveLeader(r.code, r.directorCwid),
        leaderInterim: r.leaderInterim,
        scholarCount: centerCounts.get(r.code) ?? 0,
        source: r.source,
        // Centers are NOT modeled with a parent-dept FK — always null.
        parentDeptCode: null,
        parentDeptName: null,
        sortOrder: r.sortOrder,
        retired: retiredSet.has(`center:${r.code}`),
        href: unitEditHref("center", r.code),
      }),
    ),
  ];

  const visible = opts?.includeRetired ? entries : entries.filter((e) => !e.retired);

  // Kind-then-name order. The component regroups by kind, but a stable overall
  // sort keeps the data predictable for tests and any flat consumer.
  const KIND_ORDER: Record<ManageableUnitKind, number> = {
    department: 0,
    division: 1,
    center: 2,
  };
  return visible.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}
