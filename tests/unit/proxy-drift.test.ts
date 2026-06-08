import { describe, expect, it } from "vitest";

import { auditProxyDrift, type ProxyDriftLookup } from "@/lib/edit/proxy-drift";

/**
 * #779 D3 DRIFT AUDIT (scholar-proxy-spec.md § Audit queries, query D).
 *
 * `auditProxyDrift` takes its DB surface as a parameter, so no module mock is
 * needed — a fake `db` is passed directly. It reuses the REAL
 * `checkProxyConflictingRole` with the superuser leg stubbed `false`, so these
 * assert the two DB legs (Scholar / UnitAdmin) exactly as enforcement reads
 * them: a non-deleted `scholar` row or any `unit_admin` row is a conflict; a
 * soft-deleted scholar is not.
 */
type Grant = { scholarCwid: string; proxyCwid: string; createdAt: Date };

function makeDb(opts: {
  grants: Grant[];
  /** proxyCwid → its `scholar` row (presence + deletedAt drives leg 1). */
  scholars?: Record<string, { deletedAt: Date | null }>;
  /** proxyCwids that hold a `unit_admin` row (leg 2). */
  unitAdmins?: Set<string>;
}): ProxyDriftLookup {
  return {
    scholarProxy: { findMany: async () => opts.grants },
    scholar: {
      findUnique: async ({ where }: { where: { cwid: string } }) =>
        opts.scholars?.[where.cwid] ?? null,
    },
    unitAdmin: {
      findFirst: async ({ where }: { where: { cwid: string } }) =>
        opts.unitAdmins?.has(where.cwid) ? { cwid: where.cwid } : null,
    },
  };
}

const T = new Date("2026-06-01T00:00:00.000Z");

describe("auditProxyDrift — D3 drift watch (#779 query D)", () => {
  it("no grants → no drift", async () => {
    const r = await auditProxyDrift(makeDb({ grants: [] }));
    expect(r).toEqual({ totalGrants: 0, drifted: [] });
  });

  it("a clean proxy (no Scholar / UnitAdmin row) is not flagged", async () => {
    const r = await auditProxyDrift(
      makeDb({ grants: [{ scholarCwid: "schA", proxyCwid: "px1", createdAt: T }] }),
    );
    expect(r.totalGrants).toBe(1);
    expect(r.drifted).toEqual([]);
  });

  it("a proxy who has since become an active Scholar is flagged (leg 1)", async () => {
    const r = await auditProxyDrift(
      makeDb({
        grants: [{ scholarCwid: "schA", proxyCwid: "px1", createdAt: T }],
        scholars: { px1: { deletedAt: null } },
      }),
    );
    expect(r.drifted).toEqual([
      { scholarCwid: "schA", proxyCwid: "px1", grantedAt: T, conflictingRole: "proxy_is_scholar" },
    ]);
  });

  it("a soft-deleted Scholar row is NOT a conflict (matches checkProxyConflictingRole)", async () => {
    const r = await auditProxyDrift(
      makeDb({
        grants: [{ scholarCwid: "schA", proxyCwid: "px1", createdAt: T }],
        scholars: { px1: { deletedAt: new Date("2025-01-01T00:00:00.000Z") } },
      }),
    );
    expect(r.drifted).toEqual([]);
  });

  it("a proxy who now holds a UnitAdmin row is flagged (leg 2)", async () => {
    const r = await auditProxyDrift(
      makeDb({
        grants: [{ scholarCwid: "schA", proxyCwid: "px1", createdAt: T }],
        unitAdmins: new Set(["px1"]),
      }),
    );
    expect(r.drifted).toEqual([
      { scholarCwid: "schA", proxyCwid: "px1", grantedAt: T, conflictingRole: "proxy_is_unit_admin" },
    ]);
  });

  it("scans every grant and reports only the drifted subset", async () => {
    const r = await auditProxyDrift(
      makeDb({
        grants: [
          { scholarCwid: "schA", proxyCwid: "clean1", createdAt: T },
          { scholarCwid: "schB", proxyCwid: "nowScholar", createdAt: T },
          { scholarCwid: "schC", proxyCwid: "nowAdmin", createdAt: T },
        ],
        scholars: { nowScholar: { deletedAt: null } },
        unitAdmins: new Set(["nowAdmin"]),
      }),
    );
    expect(r.totalGrants).toBe(3);
    expect(r.drifted.map((d) => d.proxyCwid).sort()).toEqual(["nowAdmin", "nowScholar"]);
    expect(r.drifted.find((d) => d.proxyCwid === "nowScholar")?.conflictingRole).toBe(
      "proxy_is_scholar",
    );
    expect(r.drifted.find((d) => d.proxyCwid === "nowAdmin")?.conflictingRole).toBe(
      "proxy_is_unit_admin",
    );
  });

  it("the scholar leg wins when a proxy is BOTH a Scholar and a UnitAdmin (predicate order)", async () => {
    const r = await auditProxyDrift(
      makeDb({
        grants: [{ scholarCwid: "schA", proxyCwid: "both", createdAt: T }],
        scholars: { both: { deletedAt: null } },
        unitAdmins: new Set(["both"]),
      }),
    );
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0].conflictingRole).toBe("proxy_is_scholar");
  });
});
