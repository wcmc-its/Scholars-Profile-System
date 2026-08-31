/**
 * Department / division leader resolution — Phase D foundation (#2542
 * follow-on, `PLAN-org-unit-roles-next-phases-2026-08-31.md`).
 *
 * Extends the Center Phase B dual-read at `lib/api/centers.ts:405-440` with a
 * store the center version does not need: `field_override`. Centers edit
 * in-row and never accumulate override rows — `loadUnitFieldOverrides`
 * (`lib/api/manual-layer.ts`) short-circuits to `{}` for them — but
 * departments and divisions do, and some of those rows are real curator
 * decisions: the 2026-08-31 probe found 10 live `leaderCwid` /
 * `leaderInterim` overrides in prod (4 in staging), none empty-string.
 *
 * Wired in as of Phase D (T3): `lib/api/departments.ts` and
 * `lib/api/divisions.ts` call this instead of resolving `mergeUnitFields`'s
 * `leaderCwid`/`leaderInterim` straight from the legacy column. Backfilling
 * `OrgUnitRoleAssignment` rows for department/division so branch 2 below
 * ever has anything to find is separate work (ETL dual-write + backfill
 * script) — until it is deployed and run in an environment, every
 * department/division resolves through branch 1 (if overridden) or branch 3
 * (the column), exactly as before.
 *
 * PRECEDENCE for WHO (the cwid), in order, and why:
 *
 *  1. `field_override(leaderCwid)` — wins OUTRIGHT over both stores below,
 *     `""` (explicit vacancy) included. This is the CRITICAL INVARIANT the
 *     2026-08-31 probe exists to protect: a curator's override is applied on
 *     READ, immediately — but `Department.chairCwid` / `Division.chiefCwid`
 *     is only rewritten once a night, by the `etl/ed` run at 07:00 UTC
 *     (`cdk/lib/etl-stack.ts`). If assignments or the column were preferred
 *     over the override, a curator's correction would render for the rest of
 *     that calendar day and then silently REVERT the next morning to
 *     whatever the ETL's auto-detection (Path A/B/C) — the very thing the
 *     override exists to suppress — produces. Checking the override first
 *     makes that ordering impossible to get backwards.
 *  2. `OrgUnitRoleAssignment` — the eventual home for this fact once a
 *     backfill lands. Checked ONLY when no override row exists, mirroring
 *     the center dual-read's assignment-then-column order.
 *  3. The legacy column (`Department.chairCwid` / `Division.chiefCwid`) —
 *     used only when neither of the above produced a value. This is today's
 *     behavior for every department/division, since no backfill has run.
 *
 * `field_override(leaderInterim)` is a SEPARATE precedence, orthogonal to the
 * above: it is a per-FIELD override, not tied to which store resolved the
 * cwid, so a curator can flag "interim" without also overriding WHO holds
 * the role — it wins over branch 2's `assignment.interim` and branch 3's
 * implicit `false` exactly as it wins inside branch 1. This mirrors how
 * `mergeUnitFields` applies every override field independently for every
 * other caller.
 *
 * The LABEL comes from the vocabulary (`OrgUnitRole.label`) in EVERY branch
 * that returns a leader, override included — a curator who renames "Chair"
 * via the Phase 3 vocabulary editor sees that label immediately, even for a
 * unit whose leader is still expressed as a `field_override` row or the
 * legacy column and has never been backfilled onto an assignment. Falls back
 * to the caller-supplied `fallbackLabel` only if the vocabulary row itself is
 * missing — defensive, matching `lib/api/centers.ts`'s
 * `directorRole?.label ?? "Director"`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { UnitFieldOverrides } from "@/lib/api/manual-layer";

/** The Prisma surface `resolveUnitLeader` needs — a client or a tx satisfies it. */
export type UnitLeaderReadClient = Pick<PrismaClient, "orgUnitRole" | "orgUnitRoleAssignment">;

/** Which of the three stores actually produced the resolved leader. Mostly diagnostic. */
export type ResolvedUnitLeaderSource = "override" | "assignment" | "column";

export type ResolvedUnitLeader = {
  cwid: string;
  interim: boolean;
  /** Echoes the `roleKey` the caller resolved (e.g. via `departmentLeaderRoleKey`). */
  roleKey: string;
  roleLabel: string;
  source: ResolvedUnitLeaderSource;
};

/**
 * Resolve the current leader of one department or division, honoring the
 * override-over-assignment-over-column precedence documented above.
 *
 * Returns `null` for "no leader": either an explicit `field_override`
 * vacancy (`leaderCwid: ""`), or no override, no assignment, and no legacy
 * column value.
 *
 * `overrides` is the caller's already-loaded `UnitFieldOverrides` bag (from
 * `loadUnitFieldOverrides`) — this function does not issue that query itself,
 * so a caller that also merges `description`/`url` via `mergeUnitFields`
 * pays for exactly one `field_override` round trip, not two.
 */
export async function resolveUnitLeader(params: {
  entityType: "department" | "division";
  /** The unit's code — `Department.code` / `Division.code`. */
  entityId: string;
  /** The vocabulary key to resolve, e.g. `departmentLeaderRoleKey(category)` or `DIVISION_CHIEF_ROLE_KEY`. */
  roleKey: string;
  /** `Department.chairCwid` / `Division.chiefCwid`, or `null`. */
  legacyLeaderCwid: string | null;
  overrides: UnitFieldOverrides;
  /** Used only if the vocabulary row for `roleKey` is missing — defensive. */
  fallbackLabel: string;
  client: UnitLeaderReadClient;
}): Promise<ResolvedUnitLeader | null> {
  const { entityType, entityId, roleKey, legacyLeaderCwid, overrides, fallbackLabel, client } = params;

  // `leaderInterim` is a SEPARATE override field from `leaderCwid` — a
  // curator can flag "whoever holds this role today is interim" without also
  // overriding WHO that is, exactly as `mergeUnitFields` applies it to every
  // other caller independently of the other fields. So this is computed once
  // and layered onto whichever branch below resolves the cwid, rather than
  // being read only inside the override-cwid branch. Dept/div carry no
  // `leaderInterim` COLUMN (only `Center.leaderInterim` does), so there is no
  // row value to fall back to for a malformed override — anything other than
  // the exact strings `"true"` / `"false"` is treated as "no override" and
  // falls through to each branch's own default.
  const interimOverride: boolean | undefined =
    overrides.leaderInterim === "true" ? true : overrides.leaderInterim === "false" ? false : undefined;

  // 1. field_override(leaderCwid) wins outright. `""` is an explicit "no
  //    leader" and must short-circuit here too, exactly as `mergeUnitFields`
  //    treats it: no card, no fall-through to the assignment table or the
  //    column.
  if (overrides.leaderCwid !== undefined) {
    if (overrides.leaderCwid === "") return null;
    const role = await client.orgUnitRole.findUnique({
      where: { entityType_key: { entityType, key: roleKey } },
      select: { label: true },
    });
    return {
      cwid: overrides.leaderCwid,
      interim: interimOverride ?? false,
      roleKey,
      roleLabel: role?.label ?? fallbackLabel,
      source: "override",
    };
  }

  // 2. No override row — prefer an OrgUnitRoleAssignment, mirroring
  //    `lib/api/centers.ts`. Department/division roles are seeded
  //    `singleHolder: true`, so `findFirst` ordered by (sortOrder, cwid) is a
  //    stable pick even before Phase C's write-path enforcement lands; a
  //    second holder would be a bug elsewhere, not something this read
  //    should mask by silently picking one.
  const assignment = await client.orgUnitRoleAssignment.findFirst({
    where: { entityType, entityId, roleKey },
    select: { cwid: true, interim: true, role: { select: { label: true } } },
    orderBy: [{ sortOrder: "asc" }, { cwid: "asc" }],
  });
  if (assignment) {
    return {
      cwid: assignment.cwid,
      // A curator's interim override still wins over the assignment row's
      // own `interim` flag — the override is about the FIELD, not about
      // which store produced the cwid.
      interim: interimOverride ?? assignment.interim,
      roleKey,
      roleLabel: assignment.role.label,
      source: "assignment",
    };
  }

  // 3. Fall back to the legacy column — today's behavior for every
  //    department/division, since no backfill has run yet.
  if (!legacyLeaderCwid) return null;
  const role = await client.orgUnitRole.findUnique({
    where: { entityType_key: { entityType, key: roleKey } },
    select: { label: true },
  });
  return {
    cwid: legacyLeaderCwid,
    // No override on the cwid (branch 1 would have returned) and no
    // assignment row exists — the column itself has nothing to report, so
    // only an explicit `leaderInterim` override can make this interim.
    interim: interimOverride ?? false,
    roleKey,
    roleLabel: role?.label ?? fallbackLabel,
    source: "column",
  };
}
