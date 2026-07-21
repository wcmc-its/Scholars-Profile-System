/**
 * The Administrators-tab roster query (#728 Phase B,
 * `ed-admin-org-unit-roles-spec.md` § 4.2): every `UnitAdmin` grant grouped by
 * person, each carrying the unit they manage (+ kind), the role, and the grant
 * provenance (`UnitAdmin.source`).
 *
 * Authorization is the *page's* responsibility, not this query's. The one scope
 * concern that MUST live in the query (so the UI is never the boundary) is the
 * Owner's unit-code scope (D5): pass `scope` and the query returns only grants on
 * those unit codes. A superuser passes `scope: undefined` and sees every grant.
 *
 * Unit display names come from the local `Department`/`Division`/`Center` tables
 * (fully available regardless of #443). Grantee display names resolve from the
 * local `Scholar` table; admin staff (DAs / IAMDELA) often have no Scholar row,
 * so a miss falls back to the bare CWID and flips `nameResolved=false`. We do NOT
 * call LDAP here — the directory is unreachable in deployed envs until #443 lands
 * (§ 4.2). When any grantee renders as a bare CWID the page shows a one-line note.
 *
 * Server-only by construction (reads Prisma) — no `server-only` import so it
 * loads under vitest with a fake client, matching `edit-roster.ts`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The Prisma surface this loader reads — a client or `db.read` satisfies it. */
export type AdminRosterClient = Pick<
  PrismaClient,
  "unitAdmin" | "department" | "division" | "center" | "scholar"
>;

/** One unit-scope grant a person holds. */
export type AdminRosterGrant = {
  entityType: "department" | "division" | "center";
  /** The unit code (`UnitAdmin.entityId`). */
  entityId: string;
  /** The unit display name, falling back to the bare code if the unit row is gone. */
  unitName: string;
  role: "owner" | "curator";
  /** `UnitAdmin.source` — "manual" | "ED:DA" | "ED:DivA" | "ED:IAMDELA" | "ED:DivA-IAMDELA". */
  source: string;
};

/** One person on the roster, with the set of unit grants they hold. */
export type AdminRosterEntry = {
  cwid: string;
  /** Display name: the Scholar `preferredName`, else the directory name captured at
   *  pull time (`UnitAdmin.granteeName`), else the bare CWID. */
  name: string;
  /** The SOR title (`primaryTitle`); null when none on file. */
  title: string | null;
  /** False when the name fell back to the bare CWID (no Scholar row AND no
   *  pull-time directory name) — drives the #443 note. */
  nameResolved: boolean;
  grants: AdminRosterGrant[];
};

export type AdminRosterResult = {
  entries: AdminRosterEntry[];
  /** True when ANY grantee resolved to a bare CWID (the #443 name-degradation note). */
  nameResolutionDegraded: boolean;
};

/**
 * Load the Administrators roster, grouped by person.
 *
 * `scope === undefined` ⇒ every grant (superuser). A `scope` array filters to
 * grants whose `entityId` is in the array; an **empty** array returns no entries
 * (an Owner who, after expansion, manages no units — though the page forbids that
 * case upstream, the query stays the boundary).
 */
export async function loadUnitAdministratorRoster(
  { scope }: { scope?: string[] },
  client: AdminRosterClient,
): Promise<AdminRosterResult> {
  // An empty scope authorizes nothing — short-circuit before any query.
  if (scope !== undefined && scope.length === 0) {
    return { entries: [], nameResolutionDegraded: false };
  }

  const rows = await client.unitAdmin.findMany({
    where: scope === undefined ? {} : { entityId: { in: scope } },
    select: {
      entityType: true,
      entityId: true,
      cwid: true,
      role: true,
      source: true,
      granteeName: true,
    },
  });

  if (rows.length === 0) {
    return { entries: [], nameResolutionDegraded: false };
  }

  // Batch-resolve unit names per kind (only the codes we actually saw).
  const deptCodes = new Set<string>();
  const divCodes = new Set<string>();
  const centerCodes = new Set<string>();
  for (const r of rows) {
    if (r.entityType === "department") deptCodes.add(r.entityId);
    else if (r.entityType === "division") divCodes.add(r.entityId);
    else centerCodes.add(r.entityId);
  }

  const [departments, divisions, centers] = await Promise.all([
    deptCodes.size
      ? client.department.findMany({
          where: { code: { in: [...deptCodes] } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
    divCodes.size
      ? client.division.findMany({
          where: { code: { in: [...divCodes] } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
    centerCodes.size
      ? client.center.findMany({
          where: { code: { in: [...centerCodes] } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const unitName = new Map<string, string>();
  for (const d of departments) unitName.set(`department:${d.code}`, d.name);
  for (const d of divisions) unitName.set(`division:${d.code}`, d.name);
  for (const c of centers) unitName.set(`center:${c.code}`, c.name);

  // Batch-resolve grantee display names from the local Scholar table.
  const cwids = [...new Set(rows.map((r) => r.cwid))];
  const scholars = await client.scholar.findMany({
    where: { cwid: { in: cwids } },
    select: { cwid: true, preferredName: true, primaryTitle: true },
  });
  const scholarName = new Map<string, { name: string; title: string | null }>();
  for (const s of scholars) {
    scholarName.set(s.cwid, { name: s.preferredName, title: s.primaryTitle });
  }

  // Group by cwid.
  const byCwid = new Map<string, AdminRosterEntry>();
  for (const r of rows) {
    let entry = byCwid.get(r.cwid);
    if (!entry) {
      const resolved = scholarName.get(r.cwid);
      // Prefer the Scholar profile name (curated) for a scholar admin; else the
      // directory name captured at pull time (`granteeName`) — the fix for
      // NON-Scholar admins that used to fall back to the bare CWID; else the CWID.
      entry = {
        cwid: r.cwid,
        name: resolved?.name ?? r.granteeName ?? r.cwid,
        title: resolved?.title ?? null,
        nameResolved: resolved !== undefined || r.granteeName != null,
        grants: [],
      };
      byCwid.set(r.cwid, entry);
    }
    // A `UnitAdmin` row is always unit-typed (department/division/center); the
    // generated `EntityType` enum is wider, so narrow here for the grant shape.
    const entityType = r.entityType as AdminRosterGrant["entityType"];
    entry.grants.push({
      entityType,
      entityId: r.entityId,
      unitName: unitName.get(`${entityType}:${r.entityId}`) ?? r.entityId,
      role: r.role,
      source: r.source,
    });
  }

  const entries = [...byCwid.values()];
  // Sort each person's grants by unit name (stable, code as tiebreak).
  for (const entry of entries) {
    entry.grants.sort(
      (a, b) => a.unitName.localeCompare(b.unitName) || a.entityId.localeCompare(b.entityId),
    );
  }
  // Sort people by name, then cwid.
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.cwid.localeCompare(b.cwid));

  const nameResolutionDegraded = entries.some((e) => !e.nameResolved);
  return { entries, nameResolutionDegraded };
}
