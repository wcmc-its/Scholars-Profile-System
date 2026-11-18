/**
 * Leadership report access in `lib/edit/cancer-center-reports.ts`:
 *   - `loadReportsContext`: when the editor gate refuses, a leader of THIS unit
 *     gets a `viewOnly` context; a leader of another unit, a retired unit, and
 *     everyone with the flag off still get null (the visible 403).
 *   - `loadReportableUnitsForActor`: the units an actor leads join the units it
 *     administers (marked `viewOnly`), through the same CenterProgram and
 *     retirement filters; flag off, the list is unchanged.
 * The editor path (`loadUnitEditContext`, `loadManageableUnits`) is stubbed to
 * "no grant" so only the leader path can admit. Fixture people are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ loadUnitEditContext: vi.fn(), loadManageableUnits: vi.fn() }));

vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/api/unit-edit-context", () => ({ loadUnitEditContext: h.loadUnitEditContext }));
vi.mock("@/lib/edit/manageable-units", () => ({
  loadManageableUnits: h.loadManageableUnits,
  loadAllUnitsDirectory: vi.fn(),
  loadAllUnitsForFinder: vi.fn(),
}));

import { loadReportableUnitsForActor, loadReportsContext } from "@/lib/edit/cancer-center-reports";

const ME = { cwid: "lead001", isSuperuser: false, isCommsSteward: false };

type Assignment = { entityType: string; entityId: string; roleKey: string; roleGroup: string };

function fakeDb(opts: {
  assignments?: Assignment[];
  retired?: string[];
  programCenters?: string[];
}) {
  const assignments = opts.assignments ?? [];
  const inOrEq = (v: string, c: unknown) =>
    c === undefined ||
    (typeof c === "string"
      ? v === c
      : "in" in (c as object)
        ? (c as { in: string[] }).in.includes(v)
        : v.startsWith((c as { startsWith: string }).startsWith));
  const match = (a: Assignment, w: Record<string, unknown>): boolean =>
    w.OR
      ? (w.OR as Array<Record<string, unknown>>).some((x) => match(a, x))
      : inOrEq(a.entityType, w.entityType) &&
        inOrEq(a.entityId, w.entityId) &&
        (w.role === undefined || a.roleGroup === (w.role as { roleGroup: string }).roleGroup);
  const names: Record<string, string> = {
    D1: "Medicine",
    D2: "Surgery",
    meyer: "Meyer Cancer Center",
  };
  return {
    orgUnitRoleAssignment: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.cwid === ME.cwid ? assignments.filter((a) => match(a, where)) : [],
      ),
    },
    fieldOverride: { findMany: vi.fn(async () => []) },
    coreLeader: { findMany: vi.fn(async () => []) },
    orgUnitRole: { findMany: vi.fn(async () => []) },
    department: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
        names[where.code] ? { name: names[where.code] } : null,
      ),
      findMany: vi.fn(async ({ where }: { where: { code: { in: string[] } } }) =>
        where.code.in.filter((c) => names[c]).map((code) => ({ code, name: names[code] })),
      ),
    },
    division: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    center: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
        names[where.code] ? { name: names[where.code] } : null,
      ),
      findMany: vi.fn(async ({ where }: { where: { code: { in: string[] } } }) =>
        where.code.in
          .filter((c) => names[c])
          .map((code) => ({ code, name: names[code], centerType: "center" })),
      ),
    },
    core: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    suppression: {
      findFirst: vi.fn(async ({ where }: { where: { entityId: string } }) =>
        (opts.retired ?? []).includes(where.entityId) ? { id: 1 } : null,
      ),
      findMany: vi.fn(async ({ where }: { where: { entityId: { in: string[] } } }) =>
        where.entityId.in
          .filter((c) => (opts.retired ?? []).includes(c))
          .map((entityId) => ({ entityId })),
      ),
    },
    centerProgram: {
      findMany: vi.fn(async () =>
        (opts.programCenters ?? []).map((centerCode) => ({ centerCode })),
      ),
    },
  };
}

const CHAIR_D1: Assignment = {
  entityType: "department",
  entityId: "D1",
  roleKey: "chair",
  roleGroup: "leadership",
};
const PROGRAM_LEAD: Assignment = {
  entityType: "center_program",
  entityId: "meyer:CB",
  roleKey: "leader",
  roleGroup: "leadership",
};

const prevFlag = process.env.LEADER_REPORT_ACCESS;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.LEADER_REPORT_ACCESS = "on";
  h.loadUnitEditContext.mockResolvedValue(null);
  h.loadManageableUnits.mockResolvedValue({
    centers: [],
    departments: [],
    divisions: [],
    cores: [],
    total: 0,
  });
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env.LEADER_REPORT_ACCESS;
  else process.env.LEADER_REPORT_ACCESS = prevFlag;
});

describe("loadReportsContext — leader path", () => {
  it("a chair views their own department's reports, view-only", async () => {
    const db = fakeDb({ assignments: [CHAIR_D1] });
    expect(await loadReportsContext("D1", ME, db as never, "department")).toEqual({
      unit: { name: "Medicine" },
      viewOnly: true,
    });
  });

  it("a chair is refused another department's reports", async () => {
    const db = fakeDb({ assignments: [CHAIR_D1] });
    expect(await loadReportsContext("D2", ME, db as never, "department")).toBeNull();
  });

  it("a retired unit stays hidden from its leader", async () => {
    const db = fakeDb({ assignments: [CHAIR_D1], retired: ["D1"] });
    expect(await loadReportsContext("D1", ME, db as never, "department")).toBeNull();
  });

  it("a program leader views the Cancer Center's reports", async () => {
    const db = fakeDb({ assignments: [PROGRAM_LEAD] });
    expect(await loadReportsContext("meyer", ME, db as never, "center")).toEqual({
      unit: { name: "Meyer Cancer Center" },
      viewOnly: true,
    });
  });

  it("an editor's context is returned as is, with no leadership read", async () => {
    const editorCtx = { unit: { name: "Medicine" } };
    h.loadUnitEditContext.mockResolvedValue(editorCtx);
    const db = fakeDb({ assignments: [CHAIR_D1] });
    expect(await loadReportsContext("D1", ME, db as never, "department")).toBe(editorCtx);
    expect(db.orgUnitRoleAssignment.findMany).not.toHaveBeenCalled();
  });

  it("flag off: a leader is refused, and no leadership row is read", async () => {
    delete process.env.LEADER_REPORT_ACCESS;
    const db = fakeDb({ assignments: [CHAIR_D1] });
    expect(await loadReportsContext("D1", ME, db as never, "department")).toBeNull();
    expect(db.orgUnitRoleAssignment.findMany).not.toHaveBeenCalled();
  });
});

describe("loadReportableUnitsForActor — led units", () => {
  const KINDS = ["center", "department", "division", "core"] as const;

  it("adds the units led, view-only, through the CenterProgram gate", async () => {
    const db = fakeDb({ assignments: [CHAIR_D1, PROGRAM_LEAD], programCenters: ["meyer"] });
    const units = await loadReportableUnitsForActor(ME, db as never, KINDS);
    expect(units.map((u) => [u.kind, u.code, u.name, u.viewOnly])).toEqual([
      ["department", "D1", "Medicine", true],
      ["center", "meyer", "Meyer Cancer Center", true],
    ]);
  });

  it("a led center with no program taxonomy and a retired led unit are dropped", async () => {
    const db = fakeDb({
      assignments: [CHAIR_D1, PROGRAM_LEAD],
      programCenters: [],
      retired: ["D1"],
    });
    expect(await loadReportableUnitsForActor(ME, db as never, KINDS)).toEqual([]);
  });

  it("a unit the actor already administers is not duplicated or marked view-only", async () => {
    h.loadManageableUnits.mockResolvedValue({
      centers: [],
      departments: [{ code: "D1", name: "Medicine" }],
      divisions: [],
      cores: [],
      total: 1,
    });
    const db = fakeDb({ assignments: [CHAIR_D1] });
    const units = await loadReportableUnitsForActor(ME, db as never, KINDS);
    expect(units).toEqual([{ code: "D1", kind: "department", name: "Medicine", centerType: null }]);
  });

  it("flag off: the list is the administered units only", async () => {
    delete process.env.LEADER_REPORT_ACCESS;
    const db = fakeDb({ assignments: [CHAIR_D1, PROGRAM_LEAD], programCenters: ["meyer"] });
    expect(await loadReportableUnitsForActor(ME, db as never, KINDS)).toEqual([]);
    expect(db.orgUnitRoleAssignment.findMany).not.toHaveBeenCalled();
  });
});
