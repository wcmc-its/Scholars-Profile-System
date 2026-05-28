/**
 * #540 Phase 2 — unit-curation authorization predicates.
 *
 * Each test maps directly to a row in `docs/unit-curation-spec.md`
 * § Edge-case test table, or to a threat in ADR-005 Amendment 1 § A1.3, so
 * the regression risk is named when a test fails.
 */
import { describe, expect, it, vi } from "vitest";

import {
  canEditUnit,
  canGrant,
  canManageAccess,
  canProxyEdit,
  getEffectiveUnitRole,
  type UnitAdminLookup,
  type UnitRef,
} from "@/lib/edit/authz";
import type { EditSession } from "@/lib/auth/superuser";

const ACTOR: EditSession = { cwid: "act001", isSuperuser: false };
const SUPER: EditSession = { cwid: "sup001", isSuperuser: true };

type Row = { entityType: "department" | "division" | "center"; entityId: string; role: "owner" | "curator" };

/** Build a `UnitAdminLookup` mock whose `findMany` returns rows that satisfy the `where` clause. */
function lookupWith(rows: Row[]): UnitAdminLookup {
  return {
    unitAdmin: {
      findMany: vi.fn(async ({ where }) => {
        return rows.filter((r) => {
          if (r.entityType !== "department" && r.entityType !== "division" && r.entityType !== "center") {
            return false;
          }
          if (where.cwid !== ACTOR.cwid) return false;
          return where.OR.some(
            (clause: { entityType: string; entityId: string }) =>
              clause.entityType === r.entityType && clause.entityId === r.entityId,
          );
        });
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// getEffectiveUnitRole — direct, cascade, owner-subsumes-curator
// ---------------------------------------------------------------------------

describe("getEffectiveUnitRole", () => {
  it("returns 'none' when the actor has no grant on the unit (edge 10)", async () => {
    const db = lookupWith([]);
    const role = await getEffectiveUnitRole(ACTOR, { kind: "department", code: "DEPT-X" }, db);
    expect(role).toBe("none");
  });

  it("returns 'curator' for a direct curator grant on the unit", async () => {
    const db = lookupWith([{ entityType: "department", entityId: "DEPT-X", role: "curator" }]);
    expect(await getEffectiveUnitRole(ACTOR, { kind: "department", code: "DEPT-X" }, db)).toBe(
      "curator",
    );
  });

  it("returns 'owner' for a direct owner grant on the unit", async () => {
    const db = lookupWith([{ entityType: "center", entityId: "MEYER", role: "owner" }]);
    expect(await getEffectiveUnitRole(ACTOR, { kind: "center", code: "MEYER" }, db)).toBe("owner");
  });

  it("cascades a dept-level owner grant down to the dept's divisions (edge 8)", async () => {
    const db = lookupWith([{ entityType: "department", entityId: "DEPT-X", role: "owner" }]);
    const role = await getEffectiveUnitRole(
      ACTOR,
      { kind: "division", code: "N101", parentDeptCode: "DEPT-X" },
      db,
    );
    expect(role).toBe("owner");
  });

  it("does NOT cascade a division grant up to the parent department (edge 9)", async () => {
    const db = lookupWith([{ entityType: "division", entityId: "N101", role: "owner" }]);
    const role = await getEffectiveUnitRole(ACTOR, { kind: "department", code: "DEPT-X" }, db);
    expect(role).toBe("none");
  });

  it("does NOT cascade across departments — a Dept-A grant does not cover Dept-B's division (T2 scope widening)", async () => {
    const db = lookupWith([{ entityType: "department", entityId: "DEPT-A", role: "owner" }]);
    const role = await getEffectiveUnitRole(
      ACTOR,
      { kind: "division", code: "N999", parentDeptCode: "DEPT-B" },
      db,
    );
    expect(role).toBe("none");
  });

  it("treats a division with unknown parentDeptCode as not-cascaded (no throw)", async () => {
    const db = lookupWith([{ entityType: "department", entityId: "DEPT-X", role: "owner" }]);
    const role = await getEffectiveUnitRole(
      ACTOR,
      { kind: "division", code: "N101", parentDeptCode: null },
      db,
    );
    expect(role).toBe("none");
  });

  it("owner subsumes curator — direct curator + cascaded owner picks owner", async () => {
    const db = lookupWith([
      { entityType: "division", entityId: "N101", role: "curator" },
      { entityType: "department", entityId: "DEPT-X", role: "owner" },
    ]);
    const role = await getEffectiveUnitRole(
      ACTOR,
      { kind: "division", code: "N101", parentDeptCode: "DEPT-X" },
      db,
    );
    expect(role).toBe("owner");
  });

  it("issues exactly one DB query — the lookup is single-pass", async () => {
    const db = lookupWith([{ entityType: "department", entityId: "DEPT-X", role: "owner" }]);
    await getEffectiveUnitRole(
      ACTOR,
      { kind: "division", code: "N101", parentDeptCode: "DEPT-X" },
      db,
    );
    expect(db.unitAdmin.findMany).toHaveBeenCalledTimes(1);
  });

  it("Superuser does NOT short-circuit the DB lookup — the audit log records the actual role", async () => {
    // Superuser short-circuit lives in the pure predicates so the audit log
    // records what role the actor held, not "owner because superuser".
    const db = lookupWith([]);
    const role = await getEffectiveUnitRole(SUPER, { kind: "department", code: "DEPT-X" }, db);
    expect(role).toBe("none");
    expect(db.unitAdmin.findMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// canEditUnit — edge 1, 7, 8, 10
// ---------------------------------------------------------------------------

describe("canEditUnit", () => {
  it("allows a Superuser regardless of effective role (edge 1)", () => {
    expect(canEditUnit(SUPER, "none")).toEqual({ ok: true });
  });

  it("allows an Owner (edge 7)", () => {
    expect(canEditUnit(ACTOR, "owner")).toEqual({ ok: true });
  });

  it("allows a Curator", () => {
    expect(canEditUnit(ACTOR, "curator")).toEqual({ ok: true });
  });

  it("denies an actor with no role on the unit with reason `not_curator` (edge 10)", () => {
    expect(canEditUnit(ACTOR, "none")).toEqual({ ok: false, reason: "not_curator" });
  });
});

// ---------------------------------------------------------------------------
// canManageAccess — Owner-only grant/revoke (T1 mitigation)
// ---------------------------------------------------------------------------

describe("canManageAccess", () => {
  it("allows a Superuser", () => {
    expect(canManageAccess(SUPER, "none")).toEqual({ ok: true });
  });

  it("allows an Owner", () => {
    expect(canManageAccess(ACTOR, "owner")).toEqual({ ok: true });
  });

  it("denies a Curator with reason `not_unit_owner` — Curators delegate nothing (T1)", () => {
    expect(canManageAccess(ACTOR, "curator")).toEqual({ ok: false, reason: "not_unit_owner" });
  });

  it("denies an actor with no role with reason `not_unit_owner`", () => {
    expect(canManageAccess(ACTOR, "none")).toEqual({ ok: false, reason: "not_unit_owner" });
  });
});

// ---------------------------------------------------------------------------
// canGrant — T1 authority, T2 scope, and the deliberate owner→owner widening
// ---------------------------------------------------------------------------

describe("canGrant", () => {
  it("allows a Superuser to mint any role", () => {
    expect(canGrant(SUPER, "none", "owner")).toEqual({ ok: true });
    expect(canGrant(SUPER, "none", "curator")).toEqual({ ok: true });
  });

  it("allows an Owner to grant Curator (the common case)", () => {
    expect(canGrant(ACTOR, "owner", "curator")).toEqual({ ok: true });
  });

  it("allows an Owner to grant Owner — Amendment 1 § A1.4 C, owner→owner is permitted", () => {
    expect(canGrant(ACTOR, "owner", "owner")).toEqual({ ok: true });
  });

  it("denies a Curator with reason `authority_violation` — Curator delegates nothing (T1)", () => {
    expect(canGrant(ACTOR, "curator", "curator")).toEqual({
      ok: false,
      reason: "authority_violation",
    });
    expect(canGrant(ACTOR, "curator", "owner")).toEqual({
      ok: false,
      reason: "authority_violation",
    });
  });

  it("denies an actor outside the subtree with reason `scope_violation` (T2)", () => {
    expect(canGrant(ACTOR, "none", "curator")).toEqual({ ok: false, reason: "scope_violation" });
    expect(canGrant(ACTOR, "none", "owner")).toEqual({ ok: false, reason: "scope_violation" });
  });
});

// ---------------------------------------------------------------------------
// canProxyEdit — edge 16, 17 (T3 capture-via-roster)
// ---------------------------------------------------------------------------

describe("canProxyEdit", () => {
  it("allows a Superuser", () => {
    expect(canProxyEdit(SUPER, "none")).toEqual({ ok: true });
  });

  it("allows an Owner of the scholar's LDAP-primary unit (edge 16)", () => {
    expect(canProxyEdit(ACTOR, "owner")).toEqual({ ok: true });
  });

  it("allows a Curator of the scholar's LDAP-primary unit", () => {
    expect(canProxyEdit(ACTOR, "curator")).toEqual({ ok: true });
  });

  it("denies when the scholar's LDAP-primary unit is outside the actor's scope (edge 17, T3)", () => {
    // The caller has already keyed the lookup on `Scholar.deptCode` / `divCode`
    // — never roster membership — so a `none` here means *strictly* "not in the
    // LDAP-primary subtree", which is the T3 capture-via-roster guard.
    expect(canProxyEdit(ACTOR, "none")).toEqual({ ok: false, reason: "proxy_target_not_in_unit" });
  });
});

// ---------------------------------------------------------------------------
// Per-POST re-check semantics — edge 11 ("revoke takes effect on next POST")
// ---------------------------------------------------------------------------

describe("per-POST re-check semantics", () => {
  it("a fresh `getEffectiveUnitRole` call sees a removed UnitAdmin row immediately (edge 11)", async () => {
    const before = lookupWith([{ entityType: "department", entityId: "DEPT-X", role: "owner" }]);
    expect(
      await getEffectiveUnitRole(ACTOR, { kind: "department", code: "DEPT-X" }, before),
    ).toBe("owner");

    // Subsequent POST after revoke — a fresh lookup against an empty store.
    const after = lookupWith([]);
    expect(
      await getEffectiveUnitRole(ACTOR, { kind: "department", code: "DEPT-X" }, after),
    ).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Mutually exclusive denial reasons — telemetry triage
// ---------------------------------------------------------------------------

describe("denial reasons are mutually exclusive across the predicates", () => {
  // The four new denials must not overlap so a metric filter / triage can
  // route a `scope_violation` differently from an `authority_violation`.
  it("canGrant's two denials are distinguishable by the actor's effective role", () => {
    const noRole = canGrant(ACTOR, "none", "curator");
    const curatorRole = canGrant(ACTOR, "curator", "curator");
    expect(noRole).not.toEqual(curatorRole);
    expect(noRole).toEqual({ ok: false, reason: "scope_violation" });
    expect(curatorRole).toEqual({ ok: false, reason: "authority_violation" });
  });

  it("canEditUnit and canManageAccess emit different reasons for a Curator-actor", () => {
    expect(canEditUnit(ACTOR, "curator")).toEqual({ ok: true });
    expect(canManageAccess(ACTOR, "curator")).toEqual({ ok: false, reason: "not_unit_owner" });
  });
});
