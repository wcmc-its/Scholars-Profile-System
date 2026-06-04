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
