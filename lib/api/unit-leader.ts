/**
 * Department / division leader resolution — #2542 contract A.
 *
 * Extends the Center dual-read at `lib/api/centers.ts` with a store the
 * center version does not need: `field_override`. Centers edit in-row and
 * never accumulate override rows — `loadUnitFieldOverrides`
 * (`lib/api/manual-layer.ts`) short-circuits to `{}` for them — but
 * departments and divisions do, and some of those rows are real curator
 * decisions: the 2026-08-31 probe found 10 live `leaderCwid` /
 * `leaderInterim` overrides in prod (4 in staging), none empty-string.
 *
 * `lib/api/departments.ts` and `lib/api/divisions.ts` call this instead of
 * resolving `mergeUnitFields`'s `leaderCwid`/`leaderInterim` from a column —
 * `Department.chairCwid` / `Division.chiefCwid` no longer exist as a read
 * source; `OrgUnitRoleAssignment` (kept in sync nightly by `etl/ed`'s
 * `writeUnitLeaderAssignment`) is the sole non-override store.
 *
 * PRECEDENCE for WHO (the cwid), in order, and why:
 *
 *  1. `field_override(leaderCwid)` — wins OUTRIGHT over the assignment store
 *     below, `""` (explicit vacancy) included. This is the CRITICAL
 *     INVARIANT the 2026-08-31 probe exists to protect: a curator's override
 *     is applied on READ, immediately — but `OrgUnitRoleAssignment` is only
 *     rewritten once a night, by the `etl/ed` run at 07:00 UTC
 *     (`cdk/lib/etl-stack.ts`). If the assignment were preferred over the
 *     override, a curator's correction would render for the rest of that
 *     calendar day and then silently REVERT the next morning to whatever the
 *     ETL's auto-detection (Path A/B/C) — the very thing the override exists
 *     to suppress — produces. Checking the override first makes that
 *     ordering impossible to get backwards.
 *  2. `OrgUnitRoleAssignment` — used whenever no override row exists.
 *
 * `field_override(leaderInterim)` is a SEPARATE precedence, orthogonal to the
 * above: it is a per-FIELD override, not tied to which store resolved the
 * cwid, so a curator can flag "interim" without also overriding WHO holds
 * the role — it wins over branch 2's `assignment.interim` exactly as it wins
 * inside branch 1. This mirrors how `mergeUnitFields` applies every override
 * field independently for every other caller.
 *
 * The LABEL comes from the vocabulary (`OrgUnitRole.label`) in EVERY branch
 * that returns a leader, override included — a curator who renames "Chair"
 * via the Phase 3 vocabulary editor sees that label immediately, even for a
 * unit whose leader is still expressed as a `field_override` row and has
 * never been backfilled onto an assignment. Falls back to the
 * caller-supplied `fallbackLabel` only if the vocabulary row itself is
 * missing — defensive, matching `lib/api/centers.ts`'s
 * `directorRole?.label ?? "Director"`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { UnitFieldOverrides } from "@/lib/api/manual-layer";

/** The Prisma surface `resolveUnitLeader` needs — a client or a tx satisfies it. */
export type UnitLeaderReadClient = Pick<PrismaClient, "orgUnitRole" | "orgUnitRoleAssignment">;

/** Which of the two stores actually produced the resolved leader. Mostly diagnostic. */
export type ResolvedUnitLeaderSource = "override" | "assignment";

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
 * override-over-assignment precedence documented above.
 *
 * Returns `null` for "no leader": either an explicit `field_override`
 * vacancy (`leaderCwid: ""`), or no override and no assignment.
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
  overrides: UnitFieldOverrides;
  /** Used only if the vocabulary row for `roleKey` is missing — defensive. */
  fallbackLabel: string;
  client: UnitLeaderReadClient;
}): Promise<ResolvedUnitLeader | null> {
  const { entityType, entityId, roleKey, overrides, fallbackLabel, client } = params;

  // `leaderInterim` is a SEPARATE override field from `leaderCwid` — a
  // curator can flag "whoever holds this role today is interim" without also
  // overriding WHO that is, exactly as `mergeUnitFields` applies it to every
  // other caller independently of the other fields. So this is computed once
  // and layered onto whichever branch below resolves the cwid, rather than
  // being read only inside the override-cwid branch. Dept/div carry no
  // `leaderInterim` column, so there is no row value to fall back to for a
  // malformed override — anything other than the exact strings `"true"` /
  // `"false"` is treated as "no override" and falls through to each branch's
  // own default.
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

  // 2. No override row — fall back to OrgUnitRoleAssignment, mirroring
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
  if (!assignment) return null;
  return {
    cwid: assignment.cwid,
    // A curator's interim override still wins over the assignment row's own
    // `interim` flag — the override is about the FIELD, not about which
    // store produced the cwid.
    interim: interimOverride ?? assignment.interim,
    roleKey,
    roleLabel: assignment.role.label,
    source: "assignment",
  };
}
