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
 * It is the composition #540 left unwired: `lib/edit/authz.ts` ships
 * `getEffectiveUnitRole` (the dept→division cascade), but nothing assembled
 * "resolve S's units → resolve A's role on each → decide". (Amendment 1's pure
 * `canProxyEdit` predicate — retired in Amendment 4 P4 — never did: its invariant
 * "roster membership never confers profile-edit rights" is the deliberate
 * OPPOSITE of D1.) This predicate is what a route calls, and it reuses
 * `getEffectiveUnitRole` so the cascade stays single-sourced (see the "the
 * cascade lives in getEffectiveUnitRole" contract referenced from
 * `app/api/edit/grant/route.ts`). It does NOT re-implement the cascade.
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
 * synthetic `EditSession` below carries `isSuperuser: false` (and
 * `isCommsSteward: false`) because `getEffectiveUnitRole` ignores those fields
 * (superuser is a separate, earlier allow in the route; the comms-steward role
 * is orthogonal to unit curation) — it is never an assertion about A's tier.
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
 * The membership unit through which a unit administrator may edit a scholar — a
 * `department` or `division` the scholar belongs to. Returned by
 * {@link resolveEditableUnitViaUnitAdmin} so callers can attribute the edit (the
 * P2 B03 audit `afterValues` carries the code; the page banner resolves the
 * display name). `kind` is never `center` — centers are excluded (D1).
 */
export type EditableUnit = { kind: "department" | "division"; code: string };

/**
 * Resolve THE unit through which `adminCwid` may edit `scholarCwid`'s profile —
 * by administering (owner OR curator — D2) a unit the scholar belongs to
 * (department + LDAP/roster division, with the dept→division cascade — D1) — or
 * `null` if there is none.
 *
 * Returns the scholar's **membership unit** that the admin's effective role
 * covers, in priority order: the scholar's department first, then each division
 * (LDAP-primary `divCode`, then roster `DivisionMembership`). In the #540
 * cascade case — a parent-department owner/curator reaching a division — the
 * **division** (the unit the scholar belongs to) is the one named, since that is
 * the relation that confers access; the admin's authority covers it via the
 * cascade encoded in `getEffectiveUnitRole`.
 *
 * `adminCwid` is the REAL signed-in cwid; the caller has already established
 * `adminCwid !== scholarCwid` (self-edit is `authorizeFieldEdit`) and
 * `impersonatedCwid === null`. Short-circuits on the first unit that grants
 * access. Fail-closed: empty inputs, a missing/soft-deleted scholar, a scholar
 * with no units, or no owner/curator grant ⇒ `null` (a thrown DB error
 * propagates — the route denies).
 */
export async function resolveEditableUnitViaUnitAdmin(
  adminCwid: string,
  scholarCwid: string,
  db: UnitScholarLookup,
): Promise<EditableUnit | null> {
  if (!adminCwid || !scholarCwid) return null;

  // S's home units come from the LDAP-authoritative `Scholar` columns; a
  // missing or soft-deleted scholar has no editable profile (fail-closed).
  const scholar = await db.scholar.findUnique({
    where: { cwid: scholarCwid },
    select: { deptCode: true, divCode: true, deletedAt: true },
  });
  if (!scholar || scholar.deletedAt !== null) return null;

  // Division membership = LDAP-primary (`divCode`) ∪ roster (`DivisionMembership`).
  const rosterRows = await db.divisionMembership.findMany({
    where: { cwid: scholarCwid },
    select: { divisionCode: true },
  });
  const divisionCodes = new Set<string>();
  if (scholar.divCode) divisionCodes.add(scholar.divCode);
  for (const row of rosterRows) divisionCodes.add(row.divisionCode);

  // Nobody can reach a scholar with no department and no divisions via this path.
  if (!scholar.deptCode && divisionCodes.size === 0) return null;

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

  // `getEffectiveUnitRole` keys on `session.cwid` and ignores `isSuperuser` /
  // `isCommsSteward`; pass A's real cwid. (Superuser is allowed earlier in the
  // route, not here; the comms-steward role is unrelated to unit curation.)
  const session: EditSession = {
    cwid: adminCwid,
    isSuperuser: false,
    isCommsSteward: false,
  };

  // Department membership (no cascade for a department — #540 edge 9).
  if (scholar.deptCode) {
    const role = await getEffectiveUnitRole(
      session,
      { kind: "department", code: scholar.deptCode },
      db,
    );
    if (role === "owner" || role === "curator") {
      return { kind: "department", code: scholar.deptCode };
    }
  }

  // Division membership (LDAP + roster), each with the dept→division cascade.
  for (const code of divisionCodes) {
    const role = await getEffectiveUnitRole(
      session,
      { kind: "division", code, parentDeptCode: parentByDivision.get(code) ?? null },
      db,
    );
    if (role === "owner" || role === "curator") {
      return { kind: "division", code };
    }
  }

  return null;
}

/**
 * May `adminCwid` edit scholar `scholarCwid`'s profile via a unit-admin role?
 * Boolean façade over {@link resolveEditableUnitViaUnitAdmin} (a non-null result
 * ⇒ yes). Kept as the named predicate for callers that need only the yes/no
 * answer; the write paths use the resolver so they can attribute the edit.
 */
export async function canEditScholarViaUnit(
  adminCwid: string,
  scholarCwid: string,
  db: UnitScholarLookup,
): Promise<boolean> {
  return (await resolveEditableUnitViaUnitAdmin(adminCwid, scholarCwid, db)) !== null;
}

// ───────────────────────────────────────────────────────────────────────────
// The INVERSE direction — "who may edit this scholar?" (Amendment 4 P3)
//
// `resolveEditableUnitViaUnitAdmin` is the FORWARD predicate (one admin + one
// scholar → may they edit?). The read-only "Org-unit administrators" group on
// the Profile-editors panel needs the inverse: given a scholar, list every
// org-unit administrator who can edit them. There is no single-actor short-cut
// here — `loadManageableUnits` / `getEffectiveUnitRole` both key on one actor's
// cwid — so this resolver re-uses the SAME membership derivation (deptCode +
// divCode + roster, dept→division cascade, centers excluded — D1) and then does
// ONE `unit_admin` scan over the scholar's membership units. It is a *listing*,
// never an authorization gate: every write path still calls the forward
// predicate, so a stale or over-broad entry here can never confer edit access.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The Prisma surface {@link listUnitAdminEditorsForScholar} reads. Distinct from
 * {@link UnitScholarLookup}: the inverse scan queries `unit_admin` by unit code
 * (no single `cwid`), and it resolves department + division display NAMES (the
 * forward resolver only needs a division's parent `deptCode`). `db.read`
 * satisfies it structurally; cast at the call site
 * (`db.read as unknown as UnitAdminEditorsLookup`).
 */
export type UnitAdminEditorsLookup = {
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
      select: { code: true; deptCode: true; name: true };
    }) => Promise<Array<{ code: string; deptCode: string; name: string }>>;
  };
  department: {
    findMany: (args: {
      where: { code: { in: string[] } };
      select: { code: true; name: true };
    }) => Promise<Array<{ code: string; name: string }>>;
  };
  unitAdmin: {
    findMany: (args: {
      where: { OR: Array<{ entityType: "department" | "division"; entityId: { in: string[] } }> };
      select: { cwid: true; entityType: true; entityId: true; role: true };
    }) => Promise<
      Array<{
        cwid: string;
        entityType: "department" | "division" | "center";
        entityId: string;
        role: "owner" | "curator";
      }>
    >;
  };
};

/**
 * One org-unit administrator who may edit a scholar's profile, attributed to the
 * scholar's membership unit (the relation that confers access). Returned by
 * {@link listUnitAdminEditorsForScholar} for the read-only Profile-editors group.
 * `adminCwid` is a real WCM person who often has no `Scholar` row (administrative
 * staff), so the display name is resolved client-side from the directory — only
 * the unit NAME (Scholars-DB-sourced) is resolved here. `conferringUnitKind` is
 * never `center` (centers are excluded — D1).
 */
export type UnitAdminEditor = {
  adminCwid: string;
  conferringUnitKind: "department" | "division";
  conferringUnitCode: string;
  conferringUnitName: string;
  role: "owner" | "curator";
};

/**
 * List every org-unit administrator who may edit `scholarCwid`'s profile via the
 * Amendment 4 path — the inverse of {@link resolveEditableUnitViaUnitAdmin}.
 *
 * Membership is derived exactly as the forward resolver does (department
 * `Scholar.deptCode`, LDAP-primary division `Scholar.divCode`, roster
 * `DivisionMembership`, dept→division cascade via `Division.deptCode`; centers
 * excluded). Each `unit_admin` row is attributed to the scholar's membership
 * unit: a division row → that division; a department row that is the scholar's
 * OWN department → that department; a department row that is only the PARENT of
 * one of the scholar's divisions → the CHILD division (mirroring the forward
 * resolver's cascade naming and the "via {unit} administrator" banner, so this
 * list never disagrees with what the admin sees in their own session).
 *
 * Dedupes (admin, unit) to the highest role (owner > curator). Fail-closed:
 * empty `scholarCwid` (no DB hit), a missing or soft-deleted scholar, or a
 * scholar with no department and no divisions ⇒ `[]` (no `unit_admin` query). A
 * thrown DB error propagates. This is a display listing only — authorization is
 * always the forward predicate's job.
 */
export async function listUnitAdminEditorsForScholar(
  scholarCwid: string,
  db: UnitAdminEditorsLookup,
): Promise<UnitAdminEditor[]> {
  if (!scholarCwid) return [];

  const scholar = await db.scholar.findUnique({
    where: { cwid: scholarCwid },
    select: { deptCode: true, divCode: true, deletedAt: true },
  });
  if (!scholar || scholar.deletedAt !== null) return [];

  // Division membership = LDAP-primary (`divCode`) ∪ roster (`DivisionMembership`).
  const rosterRows = await db.divisionMembership.findMany({
    where: { cwid: scholarCwid },
    select: { divisionCode: true },
  });
  const divisionCodes = new Set<string>();
  if (scholar.divCode) divisionCodes.add(scholar.divCode);
  for (const row of rosterRows) divisionCodes.add(row.divisionCode);

  // Nobody can reach a scholar with no department and no divisions via this path.
  if (!scholar.deptCode && divisionCodes.size === 0) return [];

  // Resolve each division's parent department (for the cascade) and display name
  // in one batched read. An orphan roster code with no `Division` row simply has
  // no parent (not cascaded) and no name (falls back to the code below).
  const parentByDivision = new Map<string, string>();
  const divisionName = new Map<string, string>();
  if (divisionCodes.size > 0) {
    const divisions = await db.division.findMany({
      where: { code: { in: [...divisionCodes] } },
      select: { code: true, deptCode: true, name: true },
    });
    for (const d of divisions) {
      parentByDivision.set(d.code, d.deptCode);
      divisionName.set(d.code, d.name);
    }
  }

  // The departments whose admins confer access: the scholar's own department,
  // plus the parent department of each of the scholar's divisions (cascade — D1).
  const deptCodes = new Set<string>();
  if (scholar.deptCode) deptCodes.add(scholar.deptCode);
  for (const parent of parentByDivision.values()) deptCodes.add(parent);

  // ONE scan over the scholar's membership units. (Either `deptCodes` or
  // `divisionCodes` is non-empty here — the no-units case returned above.)
  const orClauses: Array<{ entityType: "department" | "division"; entityId: { in: string[] } }> = [];
  if (deptCodes.size > 0) orClauses.push({ entityType: "department", entityId: { in: [...deptCodes] } });
  if (divisionCodes.size > 0)
    orClauses.push({ entityType: "division", entityId: { in: [...divisionCodes] } });

  const rows = await db.unitAdmin.findMany({
    where: { OR: orClauses },
    select: { cwid: true, entityType: true, entityId: true, role: true },
  });

  type Attributed = {
    adminCwid: string;
    kind: "department" | "division";
    code: string;
    role: "owner" | "curator";
  };
  const best = new Map<string, Attributed>();
  const consider = (a: Attributed) => {
    const key = `${a.adminCwid}:${a.kind}:${a.code}`;
    const existing = best.get(key);
    // owner subsumes curator (mirrors `loadManageableUnits`).
    if (!existing || (existing.role === "curator" && a.role === "owner")) best.set(key, a);
  };

  for (const r of rows) {
    if (r.entityType === "division") {
      if (!divisionCodes.has(r.entityId)) continue; // defensive — outside the requested set
      consider({ adminCwid: r.cwid, kind: "division", code: r.entityId, role: r.role });
    } else if (r.entityType === "department") {
      if (scholar.deptCode && r.entityId === scholar.deptCode) {
        // The scholar's OWN department — name the department (forward resolver
        // checks the department first, before any cascade).
        consider({ adminCwid: r.cwid, kind: "department", code: r.entityId, role: r.role });
      } else {
        // A parent-department admin reaches the scholar through the cascade —
        // attribute to each child division the scholar belongs to.
        for (const [divCode, parent] of parentByDivision) {
          if (parent === r.entityId) {
            consider({ adminCwid: r.cwid, kind: "division", code: divCode, role: r.role });
          }
        }
      }
    }
    // `center` rows are never requested (the OR is department/division only) and
    // are ignored defensively if one ever appears.
  }

  // Department names need a batched lookup (division names came from the read
  // above); a unit row that has since been pruned falls back to its code.
  const deptNameCodes = [
    ...new Set([...best.values()].filter((a) => a.kind === "department").map((a) => a.code)),
  ];
  const deptName = new Map<string, string>();
  if (deptNameCodes.length > 0) {
    const depts = await db.department.findMany({
      where: { code: { in: deptNameCodes } },
      select: { code: true, name: true },
    });
    for (const d of depts) deptName.set(d.code, d.name);
  }

  const result: UnitAdminEditor[] = [...best.values()].map((a) => ({
    adminCwid: a.adminCwid,
    conferringUnitKind: a.kind,
    conferringUnitCode: a.code,
    conferringUnitName:
      a.kind === "department" ? (deptName.get(a.code) ?? a.code) : (divisionName.get(a.code) ?? a.code),
    role: a.role,
  }));

  // Stable order so the rendered list and the tests are deterministic.
  result.sort(
    (x, y) =>
      x.adminCwid.localeCompare(y.adminCwid) ||
      x.conferringUnitKind.localeCompare(y.conferringUnitKind) ||
      x.conferringUnitCode.localeCompare(y.conferringUnitCode),
  );
  return result;
}
