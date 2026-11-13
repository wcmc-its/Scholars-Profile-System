/**
 * Leadership report access (plan 2026-11-13-leadership-report-access-plan.md).
 *
 * The leaders of an org unit may VIEW that unit's reports in `/edit/reports`
 * without holding a `unit_admin` grant, and at a cancer center the PROGRAM
 * LEADERS may also edit NCI Table 2A. Nothing here widens any other write.
 *
 * Who counts as a leader is read from data that already exists:
 *   - department / division / center: an `OrgUnitRoleAssignment` on the unit
 *     whose `OrgUnitRole.roleGroup` is `"leadership"`. For a department or
 *     division a curator's `field_override(leaderCwid)` wins over the
 *     ETL-assigned PRIMARY leader role (chair/director, chief), the same
 *     precedence `resolveUnitLeader` (`lib/api/unit-leader.ts`) applies on the
 *     page: the override's cwid is a leader, and the assignment holder of the
 *     primary role is not (an explicit `""` override is a vacancy). Other
 *     leadership-group roles on the unit are untouched by the override.
 *   - a center also counts its programs' leadership assignments
 *     (`entityType: "center_program"`, `entityId: "{center}:{program}"`).
 *   - a core: a `CoreLeader` row whose role is in the core vocabulary's
 *     leadership group (`director`; `staff` is membership and never counts).
 * Self only: a department chair does not lead the department's divisions.
 *
 * Everything sits behind `LEADER_REPORT_ACCESS` (`"on"` enables), read at
 * call time. Off, no caller reaches a query in this module, so every gate
 * behaves exactly as it did before.
 *
 * Server-only by injection: the Prisma client is a parameter, never imported,
 * so nothing here constructs `prisma` at module scope.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { EditSession } from "@/lib/auth/superuser";
import {
  canEditUnit,
  getEffectiveUnitRole,
  type AuthzResult,
  type UnitAdminLookup,
  type UnitRef,
} from "@/lib/edit/authz";
import {
  CENTER_PROGRAM_ENTITY_TYPE,
  DEPARTMENT_CHAIR_ROLE_KEY,
  DEPARTMENT_DIRECTOR_ROLE_KEY,
  DIVISION_CHIEF_ROLE_KEY,
  PROGRAM_LEADER_ROLE_KEY,
} from "@/lib/org-unit-roles";

/** `LEADER_REPORT_ACCESS=on` turns leader report access on. Read per call. */
export function isLeaderReportAccessEnabled(): boolean {
  return process.env.LEADER_REPORT_ACCESS === "on";
}

/** The unit kinds a leader can be resolved for (the reports suite's kinds). */
export type LeaderUnitKind = "department" | "division" | "center" | "core";

/** One unit the actor leads. */
export type LedUnitRef = { kind: LeaderUnitKind; code: string };

/** The Prisma surface the leadership reads need. */
export type UnitLeaderClient = Pick<
  PrismaClient,
  "orgUnitRoleAssignment" | "fieldOverride" | "coreLeader" | "orgUnitRole"
>;

const LEADERSHIP = "leadership";

/** The ETL-assigned primary leader role keys a `field_override(leaderCwid)`
 *  supersedes. Departments list both keys: chair vs director is exclusive per
 *  department by category, the same IN-list `loadUnitEditContext` reads. */
const PRIMARY_LEADER_KEYS: Record<"department" | "division", readonly string[]> = {
  department: [DEPARTMENT_CHAIR_ROLE_KEY, DEPARTMENT_DIRECTOR_ROLE_KEY],
  division: [DIVISION_CHIEF_ROLE_KEY],
};

const unitKey = (kind: string, code: string) => `${kind}|${code}`;

/**
 * The units `cwid` leads, or (with `only`) whether it leads that one unit —
 * one code path for both, so the reports index and the per-unit gate can never
 * disagree about who is a leader.
 */
export async function loadLedUnitRefs(
  cwid: string,
  db: UnitLeaderClient,
  only?: LedUnitRef,
): Promise<LedUnitRef[]> {
  const wantOrg = !only || only.kind !== "core";
  const wantCore = !only || only.kind === "core";

  const assignmentScope =
    only === undefined
      ? { entityType: { in: ["department", "division", "center", CENTER_PROGRAM_ENTITY_TYPE] } }
      : only.kind === "center"
        ? {
            OR: [
              { entityType: "center", entityId: only.code },
              { entityType: CENTER_PROGRAM_ENTITY_TYPE, entityId: { startsWith: `${only.code}:` } },
            ],
          }
        : { entityType: only.kind, entityId: only.code };

  const [assignments, coreRows] = await Promise.all([
    wantOrg
      ? db.orgUnitRoleAssignment.findMany({
          where: { cwid, role: { roleGroup: LEADERSHIP }, ...assignmentScope },
          select: { entityType: true, entityId: true, roleKey: true },
        })
      : Promise.resolve([]),
    wantCore
      ? db.coreLeader.findMany({
          where: { cwid, ...(only ? { coreId: only.code } : {}) },
          select: { coreId: true, role: true },
        })
      : Promise.resolve([]),
  ]);

  // `field_override(leaderCwid)` rows that matter: the ones naming this cwid
  // (it leads by override) and the ones on a dept/division where it holds an
  // assignment (an override there supersedes its primary-role assignment).
  const overrideKinds = (["department", "division"] as const).filter(
    (k) => !only || only.kind === k,
  );
  const assignedDeptDivIds = assignments
    .filter((a) => a.entityType === "department" || a.entityType === "division")
    .map((a) => a.entityId);
  const overrides =
    overrideKinds.length === 0
      ? []
      : await db.fieldOverride.findMany({
          where: {
            entityType: { in: [...overrideKinds] },
            fieldName: "leaderCwid",
            ...(only
              ? { entityId: only.code }
              : {
                  OR: [
                    { value: cwid },
                    ...(assignedDeptDivIds.length > 0
                      ? [{ entityId: { in: assignedDeptDivIds } }]
                      : []),
                  ],
                }),
          },
          select: { entityType: true, entityId: true, value: true },
        });
  const overrideByUnit = new Map(
    overrides.map((o) => [unitKey(o.entityType, o.entityId), o.value]),
  );

  const coreLeadershipKeys =
    coreRows.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db.orgUnitRole.findMany({
              where: { entityType: "core", roleGroup: LEADERSHIP },
              select: { key: true },
            })
          ).map((r) => r.key),
        );

  const out = new Map<string, LedUnitRef>();
  const add = (kind: LeaderUnitKind, code: string) => out.set(unitKey(kind, code), { kind, code });

  for (const a of assignments) {
    if (a.entityType === CENTER_PROGRAM_ENTITY_TYPE) {
      const sep = a.entityId.indexOf(":");
      if (sep <= 0) continue;
      const centerCode = a.entityId.slice(0, sep);
      // `startsWith` is a LIKE: re-check the prefix exactly here.
      if (only && centerCode !== only.code) continue;
      add("center", centerCode);
    } else if (a.entityType === "department" || a.entityType === "division") {
      const superseded =
        overrideByUnit.has(unitKey(a.entityType, a.entityId)) &&
        PRIMARY_LEADER_KEYS[a.entityType].includes(a.roleKey);
      if (!superseded) add(a.entityType, a.entityId);
    } else if (a.entityType === "center") {
      add("center", a.entityId);
    }
  }
  for (const o of overrides) {
    if (o.value === cwid && (o.entityType === "department" || o.entityType === "division")) {
      add(o.entityType, o.entityId);
    }
  }
  for (const c of coreRows) {
    if (coreLeadershipKeys.has(c.role)) add("core", c.coreId);
  }

  const refs = [...out.values()];
  return only ? refs.filter((r) => r.kind === only.kind && r.code === only.code) : refs;
}

/** Whether the actor leads this one unit (self only, no cascade). */
export async function isUnitLeader(
  session: Pick<EditSession, "cwid">,
  kind: LeaderUnitKind,
  code: string,
  db: UnitLeaderClient,
): Promise<boolean> {
  return (await loadLedUnitRefs(session.cwid, db, { kind, code })).length > 0;
}

/**
 * Whether the actor is a program LEADER of any program of this center (role
 * key `leader`, `entityType: "center_program"`). The only leadership that may
 * write NCI Table 2A. A COE Liaison sits in the program leadership group but is
 * not a program lead (see its vocabulary entry), so it views 2A only.
 */
export async function isCenterProgramLeader(
  session: Pick<EditSession, "cwid">,
  centerCode: string,
  db: Pick<PrismaClient, "orgUnitRoleAssignment">,
): Promise<boolean> {
  const rows = await db.orgUnitRoleAssignment.findMany({
    where: {
      cwid: session.cwid,
      entityType: CENTER_PROGRAM_ENTITY_TYPE,
      roleKey: PROGRAM_LEADER_ROLE_KEY,
      entityId: { startsWith: `${centerCode}:` },
    },
    select: { entityId: true },
  });
  return rows.some((r) => r.entityId.startsWith(`${centerCode}:`));
}

/**
 * The READ gate for a unit's report data routes: `canEditUnit` (superuser,
 * comms_steward, content editor, or the unit's Owner/Curator), or — with the
 * flag on — a leader of the unit. Flag off: exactly `canEditUnit`.
 */
export async function authorizeUnitReportView(
  session: EditSession,
  unit: UnitRef,
  db: UnitLeaderClient & Pick<PrismaClient, "unitAdmin">,
): Promise<AuthzResult> {
  const effective = await getEffectiveUnitRole(session, unit, db as unknown as UnitAdminLookup);
  const base = canEditUnit(session, effective);
  if (base.ok || !isLeaderReportAccessEnabled()) return base;
  return (await isUnitLeader(session, unit.kind, unit.code, db)) ? { ok: true } : base;
}

/**
 * The WRITE gate for NCI Table 2A (`PATCH /nci-2a/[awardId]`,
 * `POST /nci-2a/accept`): `canEditUnit` on the center, or — with the flag on —
 * a program leader of that center. Center-level leaders without a program
 * leader role stay read-only. Flag off: exactly `canEditUnit`.
 */
export async function authorizeNci2aWrite(
  session: EditSession,
  centerCode: string,
  db: Pick<PrismaClient, "unitAdmin" | "orgUnitRoleAssignment">,
): Promise<AuthzResult> {
  const effective = await getEffectiveUnitRole(
    session,
    { kind: "center", code: centerCode },
    db as unknown as UnitAdminLookup,
  );
  const base = canEditUnit(session, effective);
  if (base.ok || !isLeaderReportAccessEnabled()) return base;
  return (await isCenterProgramLeader(session, centerCode, db)) ? { ok: true } : base;
}
