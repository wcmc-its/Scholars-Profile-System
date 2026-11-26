/**
 * The set forms of two per-scholar predicates, used to decide which rows of a
 * report may link to a scholar's Bibliometrics report:
 * `scholarsEditableViaUnitAdmin` (of `resolveEditableUnitViaUnitAdmin`) and
 * `cvExportAllowedAmong` (of `authorizeCvExport`). Each is held to the
 * per-scholar predicate's answer for every scholar of one invented
 * population, and to a fixed number of reads however many scholars.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ superusers: new Set<string>(), observers: new Set<string>() }));

vi.mock("@/lib/auth/superuser", () => ({ isSuperuser: async (cwid: string) => h.superusers.has(cwid) }));
vi.mock("@/lib/auth/observer", () => ({ isObserver: async (cwid: string) => h.observers.has(cwid) }));

import type { EditSession } from "@/lib/auth/superuser";
import { authorizeCvExport, cvExportAllowedAmong, type CvExportBatchLookup } from "@/lib/edit/overview-authz";
import type { ProxyLookup } from "@/lib/edit/proxy-authz";
import {
  resolveEditableUnitViaUnitAdmin,
  scholarsEditableViaUnitAdmin,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";

type Scholar = { cwid: string; deptCode: string | null; divCode: string | null; primaryOrgCode: string | null; deletedAt: Date | null };
const scholar = (cwid: string, over: Partial<Scholar> = {}): Scholar => ({
  cwid,
  deptCode: null,
  divCode: null,
  primaryOrgCode: null,
  deletedAt: null,
  ...over,
});
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);

const ADMIN = "adm1001";
const SCHOLARS: Scholar[] = [
  scholar("own0001", { deptCode: "N1" }), // the admin's department
  scholar("div0002", { deptCode: "N9", divCode: "D1" }), // the admin's division, LDAP-primary
  scholar("ros0003", { deptCode: "N9" }), // the admin's division, by roster
  scholar("cas0004", { deptCode: "N9", divCode: "D5" }), // a division of the admin's department
  scholar("orp0005", { divCode: "D404" }), // a division with no row: no parent to cascade from
  scholar("ctr0006", { deptCode: "N9" }), // a current member of the admin's center
  scholar("lap0007", { deptCode: "N9" }), // a lapsed member of it
  scholar("pen0008", { deptCode: "N9" }), // a member from next year
  scholar("inv0009", { deptCode: "N9" }), // invited, not a member
  scholar("ins0010", { primaryOrgCode: "HX" }), // the admin's institution
  scholar("del0011", { deptCode: "N1", deletedAt: new Date("2026-01-01") }), // soft-deleted
  scholar("out0012", { deptCode: "N9", divCode: "D9", primaryOrgCode: "HY" }), // none of the admin's units
  scholar("non0013"), // no unit at all
  scholar("pro0014", { deptCode: "N9" }), // the admin is their granted proxy
];
const CWIDS = [...SCHOLARS.map((s) => s.cwid), "gone0015"]; // the last has no scholar row
const GRANTS = [
  { cwid: ADMIN, entityType: "department", entityId: "N1", role: "curator" },
  { cwid: ADMIN, entityType: "division", entityId: "D1", role: "owner" },
  { cwid: ADMIN, entityType: "center", entityId: "C7", role: "curator" },
  { cwid: ADMIN, entityType: "institution", entityId: "HX", role: "owner" },
  { cwid: ADMIN, entityType: "core", entityId: "N9", role: "owner" }, // a core is no one's unit
  { cwid: "oth2002", entityType: "department", entityId: "N9", role: "owner" },
];
const ROSTER = [{ cwid: "ros0003", divisionCode: "D1" }];
const DIVISIONS = [
  { code: "D1", deptCode: "N8" },
  { code: "D5", deptCode: "N1" },
  { code: "D9", deptCode: "N9" },
];
const CENTER_ROWS = [
  { cwid: "ctr0006", centerCode: "C7", startDate: day(-30), endDate: null, membershipRoleKey: null },
  { cwid: "lap0007", centerCode: "C7", startDate: day(-300), endDate: day(-30), membershipRoleKey: null },
  { cwid: "pen0008", centerCode: "C7", startDate: day(300), endDate: null, membershipRoleKey: null },
  { cwid: "inv0009", centerCode: "C7", startDate: null, endDate: null, membershipRoleKey: "invited" },
  { cwid: "out0012", centerCode: "C8", startDate: null, endDate: null, membershipRoleKey: null },
];
const PROXIES = [{ scholarCwid: "pro0014", proxyCwid: ADMIN }];

/** One in-memory database answering both the per-scholar reads and the batch reads. */
function fakeDb() {
  const calls: string[] = [];
  const inList = (v: unknown): string[] | null =>
    typeof v === "object" && v !== null && "in" in v ? (v as { in: string[] }).in : null;
  const byCwid = <R extends { cwid: string }>(rows: R[], where: { cwid: unknown }) => {
    const list = inList(where.cwid);
    return rows.filter((r) => (list ? list.includes(r.cwid) : r.cwid === where.cwid));
  };
  const db = {
    unitAdmin: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one fake behind several lookup shapes
      findMany: async ({ where }: any) => {
        calls.push("unitAdmin.findMany");
        const or: { entityType: string; entityId: string }[] | undefined = where.OR;
        return GRANTS.filter(
          (g) => g.cwid === where.cwid && (!or || or.some((o) => o.entityType === g.entityType && o.entityId === g.entityId)),
        );
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        calls.push("unitAdmin.findUnique");
        const k = where.entityType_entityId_cwid;
        return GRANTS.find((g) => g.cwid === k.cwid && g.entityType === k.entityType && g.entityId === k.entityId) ?? null;
      },
    },
    scholar: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        calls.push("scholar.findUnique");
        return SCHOLARS.find((s) => s.cwid === where.cwid) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        calls.push("scholar.findMany");
        return byCwid(SCHOLARS, where).filter((s) => where.deletedAt !== null || s.deletedAt === null);
      },
    },
    divisionMembership: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        calls.push("divisionMembership.findMany");
        return byCwid(ROSTER, where);
      },
    },
    division: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        calls.push("division.findMany");
        return DIVISIONS.filter((d) => where.code.in.includes(d.code));
      },
    },
    centerMembership: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        calls.push("centerMembership.findMany");
        return byCwid(CENTER_ROWS, where);
      },
    },
    scholarProxy: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        calls.push("scholarProxy.findUnique");
        const k = where.scholarCwid_proxyCwid;
        return PROXIES.find((p) => p.scholarCwid === k.scholarCwid && p.proxyCwid === k.proxyCwid) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) => {
        calls.push("scholarProxy.findMany");
        return PROXIES.filter((p) => p.proxyCwid === where.proxyCwid && where.scholarCwid.in.includes(p.scholarCwid));
      },
    },
  };
  return { db, calls };
}

beforeEach(() => {
  h.superusers.clear();
  h.observers.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe("scholarsEditableViaUnitAdmin", () => {
  for (const centers of ["off", "on"] as const) {
    it(`answers as the per-scholar resolver does for every scholar (center proxy ${centers})`, async () => {
      vi.stubEnv("UNIT_ADMIN_CENTER_PROXY", centers);
      const { db, calls } = fakeDb();
      const one: string[] = [];
      for (const cwid of CWIDS) {
        if (await resolveEditableUnitViaUnitAdmin(ADMIN, cwid, db as unknown as UnitScholarLookup)) one.push(cwid);
      }
      calls.length = 0;
      const many = await scholarsEditableViaUnitAdmin(ADMIN, CWIDS, db);
      expect([...many].sort()).toEqual([...one].sort());
      expect([...many].sort()).toEqual(
        ["cas0004", "div0002", "ins0010", "own0001", "ros0003", ...(centers === "on" ? ["ctr0006"] : [])].sort(),
      );
      // One read per table for the whole set; centers only behind the flag.
      expect(calls.sort()).toEqual(
        [
          "division.findMany",
          "divisionMembership.findMany",
          "scholar.findMany",
          "unitAdmin.findMany",
          ...(centers === "on" ? ["centerMembership.findMany"] : []),
        ].sort(),
      );
    });
  }

  it("someone with no grant reaches no one, after one read; no scholars, no read", async () => {
    const { db, calls } = fakeDb();
    expect((await scholarsEditableViaUnitAdmin("nob3003", CWIDS, db)).size).toBe(0);
    expect(calls).toEqual(["unitAdmin.findMany"]);
    calls.length = 0;
    expect((await scholarsEditableViaUnitAdmin(ADMIN, [], db)).size).toBe(0);
    expect((await scholarsEditableViaUnitAdmin("", CWIDS, db)).size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("cvExportAllowedAmong", () => {
  const session = (cwid: string, over: Partial<EditSession> = {}): EditSession => ({
    cwid,
    isSuperuser: false,
    isCommsSteward: false,
    ...over,
  });
  type Viewer = { session: EditSession; realCwid: string; impersonatedCwid: string | null };
  const VIEWERS: Record<string, () => Viewer> = {
    "a unit administrator who is also one scholar's proxy": () => ({
      session: session(ADMIN),
      realCwid: ADMIN,
      impersonatedCwid: null,
    }),
    "a scholar with no role (themselves only)": () => ({
      session: session("own0001"),
      realCwid: "own0001",
      impersonatedCwid: null,
    }),
    "a superuser": () => ({
      session: session("sup4004", { isSuperuser: true }),
      realCwid: "sup4004",
      impersonatedCwid: null,
    }),
    "a comms steward": () => ({
      session: session("com5005", { isCommsSteward: true }),
      realCwid: "com5005",
      impersonatedCwid: null,
    }),
    "an observer": () => {
      h.observers.add("obs6006");
      return { session: session("obs6006"), realCwid: "obs6006", impersonatedCwid: null };
    },
    "a proxy who is a superuser by group (the grant is a conflict)": () => {
      h.superusers.add(ADMIN);
      return { session: session(ADMIN), realCwid: ADMIN, impersonatedCwid: null };
    },
    "a superuser viewing as the unit administrator": () => {
      h.superusers.add("sup4004");
      return { session: session(ADMIN), realCwid: "sup4004", impersonatedCwid: ADMIN };
    },
    "View as started by someone who is no longer a superuser": () => ({
      session: session(ADMIN),
      realCwid: "was7007",
      impersonatedCwid: ADMIN,
    }),
    "an observer viewing as the unit administrator (the observer leg is off under View as)": () => {
      h.observers.add("obs6006");
      return { session: session(ADMIN), realCwid: "obs6006", impersonatedCwid: ADMIN };
    },
  };

  for (const [name, make] of Object.entries(VIEWERS)) {
    it(`answers as authorizeCvExport does for every scholar: ${name}`, async () => {
      vi.stubEnv("UNIT_ADMIN_CENTER_PROXY", "on");
      const viewer = make();
      const { db, calls } = fakeDb();
      const one: string[] = [];
      for (const entityId of CWIDS) {
        const r = await authorizeCvExport({
          ...viewer,
          entityId,
          proxyDb: db as unknown as ProxyLookup,
          unitDb: db as unknown as UnitScholarLookup,
        });
        if (r.ok) one.push(entityId);
      }
      calls.length = 0;
      const many = await cvExportAllowedAmong({ ...viewer, entityIds: CWIDS, db: db as unknown as CvExportBatchLookup });
      expect([...many].sort()).toEqual([...one].sort());
      // Never a read per scholar: each table at most once.
      expect(new Set(calls).size).toBe(calls.length);
      expect(calls.some((c) => c.endsWith("findUnique"))).toBe(false);
    });
  }

  it("the unit administrator: their units' people and the scholar they are proxy for, no one else", async () => {
    vi.stubEnv("UNIT_ADMIN_CENTER_PROXY", "on");
    const { db } = fakeDb();
    const many = await cvExportAllowedAmong({
      ...VIEWERS["a unit administrator who is also one scholar's proxy"](),
      entityIds: [...CWIDS, ...CWIDS],
      db: db as unknown as CvExportBatchLookup,
    });
    expect([...many].sort()).toEqual(["cas0004", "ctr0006", "div0002", "ins0010", "own0001", "pro0014", "ros0003"]);
  });

  it("a superuser needs no read at all", async () => {
    const { db, calls } = fakeDb();
    const many = await cvExportAllowedAmong({
      ...VIEWERS["a superuser"](),
      entityIds: CWIDS,
      db: db as unknown as CvExportBatchLookup,
    });
    expect(many.size).toBe(CWIDS.length);
    expect(calls).toEqual([]);
  });
});
