/**
 * Org-unit administrators as scholar-profile editors — the role-derived
 * authorization predicate (Amendment 4 P1,
 * `docs/scholar-proxy-unit-admin-amendment.md`; would become ADR-005
 * Amendment 4).
 *
 * Sibling to `lib/edit/proxy-authz.ts` (#779, the *explicitly assigned* proxy
 * axis) and to `lib/edit/authz.ts` (#540, the unit-*entity* curation axis).
 * This module answers a third, narrower question:
 *
 *   "May real CWID `A` edit scholar `S`'s profile **by virtue of administering
 *    an org unit `S` belongs to**?"
 *
 * It is the composition #540 left unwired: `lib/edit/authz.ts` already ships
 * `getEffectiveUnitRole` (the dept→division cascade) and the pure `canProxyEdit`
 * predicate, but nothing assembles "resolve S's units → resolve A's role on each
 * → decide". `canProxyEdit` is dead code today; this predicate is what a route
 * calls instead, and it reuses `getEffectiveUnitRole` so the cascade stays
 * single-sourced (see the "the cascade lives in getEffectiveUnitRole" contract
 * referenced from `app/api/edit/grant/route.ts`). It does NOT re-implement the
 * cascade.
 *
 * ── Membership model (Amendment 4 D1, resolved 2026-06-08) ──────────────────
 * `S` is a member of unit `U` when `U` is:
 *   • S's department  — `Scholar.deptCode` (ED/LDAP-authoritative, not
 *     `field_override`-able);
 *   • S's LDAP-primary division — `Scholar.divCode`;
 *   • a division S is on the **roster** of — a `DivisionMembership` row
 *     (`cwid = S`). D1 INCLUDES the manual roster.
 * Centers are **excluded** (D1) — `CenterMembership` is never consulted and no
 * `center` lookup is ever issued, so a center admin gains nothing here.
 * The dept→division cascade applies: an owner/curator of a division's **parent
 * department** reaches scholars in that division (the parent is resolved from
 * `Division.deptCode`; an orphan roster code with no `Division` row simply does
 * not cascade — it is still checked at the division level, never throws —
 * mirroring `getEffectiveUnitRole`'s `parentDeptCode: null` handling).
 *
 * ── THE LOAD-BEARING RULE — real CWID only (mirrors proxy-authz IS-1) ───────
 * `adminCwid` MUST be `EditRequestContext.realCwid`, NEVER `session.cwid` /
 * `effective.cwid`. While a #637 "View as" overlay is live, `session.cwid` is
 * the impersonation TARGET; keying this lookup on it would let a superuser
 * impersonate a unit admin (or the scholar) and inherit this path. The caller
 * asserts `impersonatedCwid === null` before taking the unit-admin branch, just
 * as the #779 proxy branch in `app/api/edit/field/route.ts` does. The
 * synthetic `EditSession` below carries `isSuperuser: false` because
 * `getEffectiveUnitRole` ignores that field (superuser is a separate, earlier
 * allow in the route) — it is never an assertion about A's superuser status.
 *
 * ── Fail-closed ────────────────────────────────────────────────────────────
 * Returns `false` on: empty `adminCwid`/`scholarCwid` (no DB hit); a missing or
 * soft-deleted scholar (a tombstoned profile is not editable); a scholar with
 * no department and no divisions (nobody can reach them via this path); and any
 * unit on which A holds no owner/curator row. A thrown DB error is NOT swallowed
 * — it propagates to the route's handler, which denies (mirrors proxy-authz:
 * "row existence is the whole answer", never cached, so a role change takes
 * effect on the very next request).
 *
 * ── Residual risk (ACCEPTED per D1/D3 — flag for the P5 ADR threat model) ───
 * Because the roster (`DivisionMembership`) is **curator-editable** via
 * `POST /api/edit/roster` (gated by the same `getEffectiveUnitRole`), a division
 * curator can add an arbitrary scholar to their division's roster and thereby
 * gain edit access to that scholar's `overview` — the very escalation #540's
 * "T3" deliberately excluded ("roster membership never confers profile-edit
 * rights"). D1 reverses that on purpose: this is institutional, automatic,
 * no-opt-out access (D3). The residual risk is bounded and traceable, not
 * silent — the edit surface is `overview` + own-publication hide ONLY (no
 * slug / visibility / unit structure), every edit writes a non-repudiable B03
 * audit row (`actor_cwid = A`), and the roster addition is itself audited. This
 * must be carried into ADR-005 Amendment 4 § Threat model as an accepted risk.
 */
import type { EditSession } from "@/lib/auth/superuser";
import { getEffectiveUnitRole, type UnitAdminLookup } from "@/lib/edit/authz";

/**
 * Minimal Prisma surface this predicate reads. Composes `UnitAdminLookup` (so
 * the same `db` flows straight into `getEffectiveUnitRole`) with the three
 * membership reads. `db.read` satisfies it structurally; cast at the call site
 * (`db.read as unknown as UnitScholarLookup`), mirroring `ProxyLookup` /
 * `UnitAdminLookup`.
 */
export type UnitScholarLookup = UnitAdminLookup & {
  scholar: {
    findUnique: (args: {
      where: { cwid: string };
      select: { deptCode: true; divCode: true; deletedAt: true };
    }) => Promise<{ deptCode: string | null; divCode: string | null; deletedAt: Date | null } | null>;
  };
  divisionMembership: {
    findMany: (args: {
      where: { cwid: string };
      select: { divisionCode: true };
    }) => Promise<Array<{ divisionCode: string }>>;
  };
  division: {
    findMany: (args: {
      where: { code: { in: string[] } };
      select: { code: true; deptCode: true };
    }) => Promise<Array<{ code: string; deptCode: string }>>;
  };
};

/**
 * May `adminCwid` edit scholar `scholarCwid`'s profile by virtue of
 * administering (owner OR curator — D2) a unit the scholar belongs to
 * (department + LDAP/roster division, with the dept→division cascade — D1)?
 *
 * Pure boolean predicate, no wiring (Amendment 4 P1). `adminCwid` is the REAL
 * signed-in cwid; the caller has already established `adminCwid !== scholarCwid`
 * (self-edit is `authorizeFieldEdit`) and `impersonatedCwid === null`. Short-
 * circuits on the first unit that grants access.
 */
export async function canEditScholarViaUnit(
  adminCwid: string,
  scholarCwid: string,
  db: UnitScholarLookup,
): Promise<boolean> {
  if (!adminCwid || !scholarCwid) return false;

  // S's home units come from the LDAP-authoritative `Scholar` columns; a
  // missing or soft-deleted scholar has no editable profile (fail-closed).
  const scholar = await db.scholar.findUnique({
    where: { cwid: scholarCwid },
    select: { deptCode: true, divCode: true, deletedAt: true },
  });
  if (!scholar || scholar.deletedAt !== null) return false;

  // Division membership = LDAP-primary (`divCode`) ∪ roster (`DivisionMembership`).
  const rosterRows = await db.divisionMembership.findMany({
    where: { cwid: scholarCwid },
    select: { divisionCode: true },
  });
  const divisionCodes = new Set<string>();
  if (scholar.divCode) divisionCodes.add(scholar.divCode);
  for (const row of rosterRows) divisionCodes.add(row.divisionCode);

  // Nobody can reach a scholar with no department and no divisions via this path.
  if (!scholar.deptCode && divisionCodes.size === 0) return false;

  // Resolve each division's parent department for the cascade. An orphan roster
  // code with no `Division` row stays absent from the map → `parentDeptCode:
  // null` → not cascaded (still checked at the division level).
  const parentByDivision = new Map<string, string>();
  if (divisionCodes.size > 0) {
    const divisions = await db.division.findMany({
      where: { code: { in: [...divisionCodes] } },
      select: { code: true, deptCode: true },
    });
    for (const d of divisions) parentByDivision.set(d.code, d.deptCode);
  }

  // `getEffectiveUnitRole` keys on `session.cwid` and ignores `isSuperuser`;
  // pass A's real cwid. (Superuser is allowed earlier in the route, not here.)
  const session: EditSession = { cwid: adminCwid, isSuperuser: false };

  // Department membership (no cascade for a department — #540 edge 9).
  if (scholar.deptCode) {
    const role = await getEffectiveUnitRole(
      session,
      { kind: "department", code: scholar.deptCode },
      db,
    );
    if (role === "owner" || role === "curator") return true;
  }

  // Division membership (LDAP + roster), each with the dept→division cascade.
  for (const code of divisionCodes) {
    const role = await getEffectiveUnitRole(
      session,
      { kind: "division", code, parentDeptCode: parentByDivision.get(code) ?? null },
      db,
    );
    if (role === "owner" || role === "curator") return true;
  }

  return false;
}
