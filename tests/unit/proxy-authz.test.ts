/**
 * #779 / scholar-proxy-spec.md — scholar-assigned proxy authorization predicates.
 *
 * Each test maps to a row in `docs/scholar-proxy-spec.md` § Edge-case test table
 * or a threat (PE-/CD-/IS-), so a failure names the regression risk.
 */
import { describe, expect, it, vi } from "vitest";

import {
  checkProxyConflictingRole,
  isGrantedProxy,
  scholarsServedByProxy,
  type ProxyListLookup,
  type ProxyLookup,
} from "@/lib/edit/proxy-authz";

const PROXY = "bec4010"; // Beth Chunn — pure staff
const SCHOLAR = "ras2022"; // Rahul Sharma — granted
const OTHER = "xyz9999"; // a scholar the proxy was NOT granted

type Grant = { scholarCwid: string; proxyCwid: string };

function proxyLookup(opts: {
  grants?: Grant[];
  scholars?: Record<string, { deletedAt: Date | null }>;
  unitAdmins?: string[];
}): ProxyLookup {
  const grants = opts.grants ?? [];
  const scholars = opts.scholars ?? {};
  const unitAdmins = new Set(opts.unitAdmins ?? []);
  return {
    scholarProxy: {
      findUnique: vi.fn(async ({ where }) => {
        const { scholarCwid, proxyCwid } = where.scholarCwid_proxyCwid;
        return grants.some((g) => g.scholarCwid === scholarCwid && g.proxyCwid === proxyCwid)
          ? { scholarCwid }
          : null;
      }),
    },
    scholar: {
      findUnique: vi.fn(async ({ where }) => {
        const s = scholars[where.cwid];
        return s ? { deletedAt: s.deletedAt } : null;
      }),
    },
    unitAdmin: {
      findFirst: vi.fn(async ({ where }) => (unitAdmins.has(where.cwid) ? { cwid: where.cwid } : null)),
    },
  };
}

function proxyListLookup(grants: Grant[]): ProxyListLookup {
  return {
    scholarProxy: {
      findMany: vi.fn(async ({ where }) =>
        grants.filter((g) => g.proxyCwid === where.proxyCwid).map((g) => ({ scholarCwid: g.scholarCwid })),
      ),
    },
  };
}

const noSuper = async () => false;
const yesSuper = async () => true;

describe("isGrantedProxy — composite-PK bind (PE-06 cross-scholar isolation)", () => {
  it("allows the proxy on the scholar they were granted (edge 1)", async () => {
    const db = proxyLookup({ grants: [{ scholarCwid: SCHOLAR, proxyCwid: PROXY }] });
    expect(await isGrantedProxy(PROXY, SCHOLAR, db)).toBe(true);
  });

  it("denies the proxy on a NON-granted scholar (edge 2 / PE-06)", async () => {
    const db = proxyLookup({ grants: [{ scholarCwid: SCHOLAR, proxyCwid: PROXY }] });
    expect(await isGrantedProxy(PROXY, OTHER, db)).toBe(false);
  });

  it("denies a non-proxy CWID with no grant", async () => {
    const db = proxyLookup({ grants: [{ scholarCwid: SCHOLAR, proxyCwid: PROXY }] });
    expect(await isGrantedProxy("nobody1", SCHOLAR, db)).toBe(false);
  });

  it("returns false for empty cwids without hitting the DB", async () => {
    const db = proxyLookup({ grants: [{ scholarCwid: SCHOLAR, proxyCwid: PROXY }] });
    expect(await isGrantedProxy("", SCHOLAR, db)).toBe(false);
    expect(await isGrantedProxy(PROXY, "", db)).toBe(false);
    expect(db.scholarProxy.findUnique).not.toHaveBeenCalled();
  });

  it("binds proxyCwid to the supplied realCwid, not any proxy of the scholar", async () => {
    // A grant exists for (SCHOLAR, someoneElse). A DIFFERENT real cwid must not match.
    const db = proxyLookup({ grants: [{ scholarCwid: SCHOLAR, proxyCwid: "elsep1" }] });
    expect(await isGrantedProxy(PROXY, SCHOLAR, db)).toBe(false);
    expect(await isGrantedProxy("elsep1", SCHOLAR, db)).toBe(true);
  });
});

describe("checkProxyConflictingRole — D3 'no other role', fail-closed", () => {
  it("ok when the candidate holds none of the three roles", async () => {
    const db = proxyLookup({});
    expect(await checkProxyConflictingRole(PROXY, db, noSuper)).toEqual({ ok: true });
  });

  it("blocks a non-deleted Scholar (edge 3 / leg 1)", async () => {
    const db = proxyLookup({ scholars: { [PROXY]: { deletedAt: null } } });
    expect(await checkProxyConflictingRole(PROXY, db, noSuper)).toEqual({
      ok: false,
      reason: "proxy_is_scholar",
    });
  });

  it("does NOT block a SOFT-DELETED scholar (deletedAt set is no longer an active scholar)", async () => {
    const db = proxyLookup({ scholars: { [PROXY]: { deletedAt: new Date("2026-01-01") } } });
    expect(await checkProxyConflictingRole(PROXY, db, noSuper)).toEqual({ ok: true });
  });

  it("blocks a UnitAdmin owner/curator (edge 4 / leg 2)", async () => {
    const db = proxyLookup({ unitAdmins: [PROXY] });
    expect(await checkProxyConflictingRole(PROXY, db, noSuper)).toEqual({
      ok: false,
      reason: "proxy_is_unit_admin",
    });
  });

  it("blocks a superuser via the LIVE leg, NOT deferred (edge 5 / leg 3 / CD-3)", async () => {
    const db = proxyLookup({});
    expect(await checkProxyConflictingRole(PROXY, db, yesSuper)).toEqual({
      ok: false,
      reason: "proxy_is_superuser",
    });
  });

  it("precedence: scholar > unit_admin > superuser when several conflict", async () => {
    const db = proxyLookup({ scholars: { [PROXY]: { deletedAt: null } }, unitAdmins: [PROXY] });
    expect(await checkProxyConflictingRole(PROXY, db, yesSuper)).toEqual({
      ok: false,
      reason: "proxy_is_scholar",
    });
  });

  it("always evaluates the live superuser leg on the passed cwid (TOCTOU re-check, PE-02)", async () => {
    const db = proxyLookup({});
    const su = vi.fn(yesSuper);
    await checkProxyConflictingRole(PROXY, db, su);
    expect(su).toHaveBeenCalledWith(PROXY);
  });
});

describe("scholarsServedByProxy — read-only reverse lookup (landing / drift)", () => {
  it("returns every scholar a proxy serves (D5 fan-out)", async () => {
    const db = proxyListLookup([
      { scholarCwid: "a0001", proxyCwid: PROXY },
      { scholarCwid: "b0002", proxyCwid: PROXY },
      { scholarCwid: "c0003", proxyCwid: "other1" },
    ]);
    expect((await scholarsServedByProxy(PROXY, db)).sort()).toEqual(["a0001", "b0002"]);
  });

  it("returns [] when the proxy serves nobody, without hitting the DB on empty cwid", async () => {
    const db = proxyListLookup([]);
    expect(await scholarsServedByProxy("", db)).toEqual([]);
    expect(db.scholarProxy.findMany).not.toHaveBeenCalled();
  });
});
