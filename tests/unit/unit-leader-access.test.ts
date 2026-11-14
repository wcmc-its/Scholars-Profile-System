/**
 * Leadership report access (`lib/edit/unit-leader-access.ts`): who counts as a
 * unit's leader, the program-leader 2A write check, and the two route gates
 * built on them (flag off = exactly `canEditUnit`). Runs against a small
 * in-memory stand-in for the four Prisma delegates the module reads, which
 * evaluates the `where` shapes the module sends. Fixture people are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/lib/generated/prisma/client";

import {
  authorizeNci2aWrite,
  authorizeUnitReportView,
  isCenterProgramLeader,
  isUnitLeader,
  loadLedUnitRefs,
  type UnitLeaderClient,
} from "@/lib/edit/unit-leader-access";

type Row = Record<string, unknown>;

/** Matches a Prisma-style `where` against a row: equality, `in`, `startsWith`,
 *  `OR`, and one nested relation (`role`). */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Row;
      if ("in" in c) return (c.in as unknown[]).includes(v);
      if ("startsWith" in c) return typeof v === "string" && v.startsWith(c.startsWith as string);
      return matches((v ?? {}) as Row, c);
    }
    return v === cond;
  });
}

const ROLES: Row[] = [
  { entityType: "department", key: "chair", roleGroup: "leadership" },
  { entityType: "department", key: "director", roleGroup: "leadership" },
  { entityType: "department", key: "vice_chair", roleGroup: "leadership" },
  { entityType: "department", key: "admin_member", roleGroup: "membership" },
  { entityType: "division", key: "chief", roleGroup: "leadership" },
  { entityType: "center", key: "director", roleGroup: "leadership" },
  { entityType: "center", key: "associate_director", roleGroup: "leadership" },
  { entityType: "center", key: "member", roleGroup: "membership" },
  { entityType: "center_program", key: "leader", roleGroup: "leadership" },
  { entityType: "center_program", key: "coe_liaison", roleGroup: "leadership" },
  { entityType: "core", key: "director", roleGroup: "leadership" },
  { entityType: "core", key: "staff", roleGroup: "membership" },
];

function makeDb(opts: {
  assignments?: Array<{ entityType: string; entityId: string; cwid: string; roleKey: string }>;
  overrides?: Array<{ entityType: string; entityId: string; value: string }>;
  coreLeaders?: Array<{ coreId: string; cwid: string; role: string }>;
  unitAdmins?: Array<{
    entityType: string;
    entityId: string;
    cwid: string;
    role: "owner" | "curator";
  }>;
}) {
  const assignments = (opts.assignments ?? []).map((a) => ({
    ...a,
    role: ROLES.find((r) => r.entityType === a.entityType && r.key === a.roleKey) ?? {},
  }));
  const overrides = (opts.overrides ?? []).map((o) => ({ ...o, fieldName: "leaderCwid" }));
  const db = {
    orgUnitRoleAssignment: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        assignments.filter((r) => matches(r, where)),
      ),
    },
    fieldOverride: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        overrides.filter((r) => matches(r, where)),
      ),
    },
    coreLeader: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        (opts.coreLeaders ?? []).filter((r) => matches(r, where)),
      ),
    },
    orgUnitRole: {
      findMany: vi.fn(async ({ where }: { where: Row }) => ROLES.filter((r) => matches(r, where))),
    },
    unitAdmin: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        (opts.unitAdmins ?? []).filter((r) => matches(r, where)),
      ),
    },
  };
  return db as unknown as UnitLeaderClient & Pick<PrismaClient, "unitAdmin">;
}

const ME = { cwid: "lead001", isSuperuser: false, isCommsSteward: false };
const CENTER = "meyer_cancer_center";

const prevFlag = process.env.LEADER_REPORT_ACCESS;
beforeEach(() => {
  process.env.LEADER_REPORT_ACCESS = "on";
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env.LEADER_REPORT_ACCESS;
  else process.env.LEADER_REPORT_ACCESS = prevFlag;
});

describe("isUnitLeader", () => {
  it("a leadership-group role passes; a membership-group role fails", async () => {
    const db = makeDb({
      assignments: [
        { entityType: "department", entityId: "D1", cwid: ME.cwid, roleKey: "vice_chair" },
        { entityType: "department", entityId: "D2", cwid: ME.cwid, roleKey: "admin_member" },
      ],
    });
    expect(await isUnitLeader(ME, "department", "D1", db)).toBe(true);
    expect(await isUnitLeader(ME, "department", "D2", db)).toBe(false);
  });

  it("the ETL chair passes with no override", async () => {
    const db = makeDb({
      assignments: [{ entityType: "department", entityId: "D1", cwid: ME.cwid, roleKey: "chair" }],
    });
    expect(await isUnitLeader(ME, "department", "D1", db)).toBe(true);
  });

  it('a field_override vacancy ("") removes the ETL-assigned primary leader', async () => {
    const db = makeDb({
      assignments: [{ entityType: "division", entityId: "V1", cwid: ME.cwid, roleKey: "chief" }],
      overrides: [{ entityType: "division", entityId: "V1", value: "" }],
    });
    expect(await isUnitLeader(ME, "division", "V1", db)).toBe(false);
  });

  it("an override naming someone else supersedes the chair; one naming me makes me the leader", async () => {
    const supersededDb = makeDb({
      assignments: [{ entityType: "department", entityId: "D1", cwid: ME.cwid, roleKey: "chair" }],
      overrides: [{ entityType: "department", entityId: "D1", value: "other01" }],
    });
    expect(await isUnitLeader(ME, "department", "D1", supersededDb)).toBe(false);
    const overrideDb = makeDb({
      overrides: [{ entityType: "department", entityId: "D1", value: ME.cwid }],
    });
    expect(await isUnitLeader(ME, "department", "D1", overrideDb)).toBe(true);
  });

  it("an override touches only the primary role: a vice chair still leads", async () => {
    const db = makeDb({
      assignments: [
        { entityType: "department", entityId: "D1", cwid: ME.cwid, roleKey: "vice_chair" },
      ],
      overrides: [{ entityType: "department", entityId: "D1", value: "" }],
    });
    expect(await isUnitLeader(ME, "department", "D1", db)).toBe(true);
  });

  it("a program leader leads the Cancer Center; an associate director does too; a member does not", async () => {
    const programDb = makeDb({
      assignments: [
        {
          entityType: "center_program",
          entityId: `${CENTER}:CB`,
          cwid: ME.cwid,
          roleKey: "leader",
        },
      ],
    });
    expect(await isUnitLeader(ME, "center", CENTER, programDb)).toBe(true);
    expect(await isUnitLeader(ME, "center", "other_center", programDb)).toBe(false);
    const adDb = makeDb({
      assignments: [
        { entityType: "center", entityId: CENTER, cwid: ME.cwid, roleKey: "associate_director" },
      ],
    });
    expect(await isUnitLeader(ME, "center", CENTER, adDb)).toBe(true);
    const memberDb = makeDb({
      assignments: [{ entityType: "center", entityId: CENTER, cwid: ME.cwid, roleKey: "member" }],
    });
    expect(await isUnitLeader(ME, "center", CENTER, memberDb)).toBe(false);
  });

  it("a center whose code prefixes another's does not borrow its programs", async () => {
    const db = makeDb({
      assignments: [
        { entityType: "center_program", entityId: "meyer_x:CB", cwid: ME.cwid, roleKey: "leader" },
      ],
    });
    expect(await isUnitLeader(ME, "center", "meyer", db)).toBe(false);
  });

  it("no cascade: a department chair does not lead the department's divisions", async () => {
    const db = makeDb({
      assignments: [{ entityType: "department", entityId: "D1", cwid: ME.cwid, roleKey: "chair" }],
    });
    expect(await isUnitLeader(ME, "division", "V1", db)).toBe(false);
  });

  it("a core director leads the core; core staff does not", async () => {
    const db = makeDb({
      coreLeaders: [
        { coreId: "c1", cwid: ME.cwid, role: "director" },
        { coreId: "c2", cwid: ME.cwid, role: "staff" },
      ],
    });
    expect(await isUnitLeader(ME, "core", "c1", db)).toBe(true);
    expect(await isUnitLeader(ME, "core", "c2", db)).toBe(false);
  });

  it("someone else's assignment never counts", async () => {
    const db = makeDb({
      assignments: [
        { entityType: "department", entityId: "D1", cwid: "other01", roleKey: "chair" },
      ],
    });
    expect(await isUnitLeader(ME, "department", "D1", db)).toBe(false);
  });
});

describe("loadLedUnitRefs", () => {
  it("lists every unit led, deduped, with the override precedence applied", async () => {
    const db = makeDb({
      assignments: [
        { entityType: "department", entityId: "D1", cwid: ME.cwid, roleKey: "chair" },
        { entityType: "division", entityId: "V1", cwid: ME.cwid, roleKey: "chief" },
        {
          entityType: "center_program",
          entityId: `${CENTER}:CB`,
          cwid: ME.cwid,
          roleKey: "leader",
        },
        {
          entityType: "center_program",
          entityId: `${CENTER}:CT`,
          cwid: ME.cwid,
          roleKey: "coe_liaison",
        },
        { entityType: "center", entityId: "other_center", cwid: ME.cwid, roleKey: "member" },
      ],
      overrides: [
        { entityType: "division", entityId: "V1", value: "" },
        { entityType: "division", entityId: "V9", value: ME.cwid },
      ],
      coreLeaders: [{ coreId: "c1", cwid: ME.cwid, role: "director" }],
    });
    const refs = await loadLedUnitRefs(ME.cwid, db);
    expect(refs.map((r) => `${r.kind}:${r.code}`).sort()).toEqual(
      ["center:meyer_cancer_center", "core:c1", "department:D1", "division:V9"].sort(),
    );
  });

  it("someone with no leadership leads nothing", async () => {
    expect(await loadLedUnitRefs(ME.cwid, makeDb({}))).toEqual([]);
  });
});

describe("isCenterProgramLeader", () => {
  it("a program leader passes; a COE liaison and a center-level leader do not", async () => {
    const leader = makeDb({
      assignments: [
        {
          entityType: "center_program",
          entityId: `${CENTER}:CB`,
          cwid: ME.cwid,
          roleKey: "leader",
        },
      ],
    });
    expect(await isCenterProgramLeader(ME, CENTER, leader)).toBe(true);
    expect(await isCenterProgramLeader(ME, "other_center", leader)).toBe(false);
    const liaison = makeDb({
      assignments: [
        {
          entityType: "center_program",
          entityId: `${CENTER}:CB`,
          cwid: ME.cwid,
          roleKey: "coe_liaison",
        },
      ],
    });
    expect(await isCenterProgramLeader(ME, CENTER, liaison)).toBe(false);
    const director = makeDb({
      assignments: [{ entityType: "center", entityId: CENTER, cwid: ME.cwid, roleKey: "director" }],
    });
    expect(await isCenterProgramLeader(ME, CENTER, director)).toBe(false);
  });
});

describe("authorizeUnitReportView / authorizeNci2aWrite", () => {
  const leaderDb = () =>
    makeDb({
      assignments: [
        { entityType: "center", entityId: CENTER, cwid: ME.cwid, roleKey: "associate_director" },
        { entityType: "department", entityId: "D1", cwid: ME.cwid, roleKey: "chair" },
      ],
    });

  it("flag on: a center leader may view, but not write 2A without a program role", async () => {
    const db = leaderDb();
    expect(await authorizeUnitReportView(ME, { kind: "center", code: CENTER }, db)).toEqual({
      ok: true,
    });
    expect(await authorizeNci2aWrite(ME, CENTER, db)).toEqual({ ok: false, reason: "not_curator" });
  });

  it("flag on: a department chair is refused another department's reports", async () => {
    expect(
      await authorizeUnitReportView(ME, { kind: "department", code: "D2" }, leaderDb()),
    ).toEqual({
      ok: false,
      reason: "not_curator",
    });
  });

  it("flag on: a program leader may write 2A for that center only", async () => {
    const db = makeDb({
      assignments: [
        {
          entityType: "center_program",
          entityId: `${CENTER}:CB`,
          cwid: ME.cwid,
          roleKey: "leader",
        },
      ],
    });
    expect(await authorizeNci2aWrite(ME, CENTER, db)).toEqual({ ok: true });
    expect(await authorizeNci2aWrite(ME, "other_center", db)).toEqual({
      ok: false,
      reason: "not_curator",
    });
  });

  it("flag off: exactly canEditUnit, and no leadership read at all", async () => {
    delete process.env.LEADER_REPORT_ACCESS;
    const db = leaderDb();
    expect(await authorizeUnitReportView(ME, { kind: "center", code: CENTER }, db)).toEqual({
      ok: false,
      reason: "not_curator",
    });
    expect(db.orgUnitRoleAssignment.findMany).not.toHaveBeenCalled();
    process.env.LEADER_REPORT_ACCESS = "off";
    expect(await authorizeNci2aWrite(ME, CENTER, db)).toEqual({ ok: false, reason: "not_curator" });
    expect(db.orgUnitRoleAssignment.findMany).not.toHaveBeenCalled();
  });

  it("an editor passes without the leadership read", async () => {
    const db = makeDb({
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ME.cwid, role: "curator" }],
    });
    expect(await authorizeUnitReportView(ME, { kind: "center", code: CENTER }, db)).toEqual({
      ok: true,
    });
    expect(await authorizeNci2aWrite(ME, CENTER, db)).toEqual({ ok: true });
    expect(db.orgUnitRoleAssignment.findMany).not.toHaveBeenCalled();
  });
});
