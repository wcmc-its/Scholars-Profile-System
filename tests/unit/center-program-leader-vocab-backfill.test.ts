/**
 * #2558 Phase 1 — `scripts/backfills/2026-08-31-center-program-leader-vocab.ts`.
 *
 * Mirrors the `runBackfill` describe block in
 * `tests/unit/dept-div-role-vocabulary-backfill.test.ts` against an in-memory
 * fake DB with the same SQL-semantics `matches()` helper.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_UNIT_ROLES } from "@/lib/org-unit-roles";
import {
  runBackfill,
  type CenterProgramLeaderVocabBackfillDb,
} from "../../scripts/backfills/2026-08-31-center-program-leader-vocab";

type LegacyRow = {
  centerCode: string;
  programCode: string;
  cwid: string;
  role: string;
  interim: boolean;
  sortOrder: number;
};
type Assignment = {
  entityType: string;
  entityId: string;
  cwid: string;
  roleKey: string;
  interim: boolean;
  sortOrder: number;
};

function makeDb(opts: {
  legacy: LegacyRow[];
  assignments?: Assignment[];
  seededRoleKeys?: { entityType: string; key: string }[];
}) {
  const assignments: Assignment[] = (opts.assignments ?? []).map((a) => ({ ...a }));
  const roles: { entityType: string; key: string }[] = [];

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === "object" && "in" in (v as object)) {
        return ((v as { in: string[] }).in ?? []).includes(row[k] as string);
      }
      return row[k] === v;
    });

  const db: CenterProgramLeaderVocabBackfillDb = {
    centerProgramLeader: { findMany: vi.fn(async () => opts.legacy) },
    orgUnitRole: {
      createMany: vi.fn(async (args: unknown) => {
        const rows = (args as { data: { entityType: string; key: string }[] }).data;
        let count = 0;
        for (const r of rows) {
          if (!roles.some((x) => x.entityType === r.entityType && x.key === r.key)) {
            roles.push({ entityType: r.entityType, key: r.key });
            count += 1;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: Record<string, unknown> }).where;
        const seeded = opts.seededRoleKeys ?? roles;
        return seeded.filter((r) => matches(r as unknown as Record<string, unknown>, w));
      }),
    },
    orgUnitRoleAssignment: {
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: Record<string, unknown> }).where;
        return assignments.filter((a) => matches(a as unknown as Record<string, unknown>, w));
      }),
      create: vi.fn(async (args: unknown) => {
        const d = (args as { data: Assignment }).data;
        assignments.push({ ...d });
        return d;
      }),
    },
  };
  return { db, assignments, roles };
}

// Shape of the prod row set per the ticket: Meyer only, 7 leader + 4 coe_liaison
// across 4 programs.
const MEYER_ROWS: LegacyRow[] = [
  { centerCode: "meyer_cancer_center", programCode: "CB", cwid: "lead001", role: "leader", interim: false, sortOrder: 0 },
  { centerCode: "meyer_cancer_center", programCode: "CB", cwid: "lead002", role: "leader", interim: true, sortOrder: 1 },
  { centerCode: "meyer_cancer_center", programCode: "CB", cwid: "liai001", role: "coe_liaison", interim: false, sortOrder: 0 },
  { centerCode: "meyer_cancer_center", programCode: "CGE", cwid: "lead003", role: "leader", interim: false, sortOrder: 0 },
  { centerCode: "meyer_cancer_center", programCode: "CGE", cwid: "liai002", role: "coe_liaison", interim: false, sortOrder: 0 },
  { centerCode: "meyer_cancer_center", programCode: "CPC", cwid: "lead004", role: "leader", interim: false, sortOrder: 0 },
  { centerCode: "meyer_cancer_center", programCode: "CPC", cwid: "liai003", role: "coe_liaison", interim: false, sortOrder: 0 },
  { centerCode: "meyer_cancer_center", programCode: "CT", cwid: "lead005", role: "leader", interim: false, sortOrder: 0 },
  { centerCode: "meyer_cancer_center", programCode: "CT", cwid: "lead006", role: "leader", interim: false, sortOrder: 1 },
  { centerCode: "meyer_cancer_center", programCode: "CT", cwid: "lead007", role: "leader", interim: false, sortOrder: 2 },
  { centerCode: "meyer_cancer_center", programCode: "CT", cwid: "liai004", role: "coe_liaison", interim: false, sortOrder: 0 },
];

describe("runBackfill (center_program leader vocab)", () => {
  it("seeds the center_program vocabulary (leader + coe_liaison), not another kind's", async () => {
    const { db, roles } = makeDb({ legacy: MEYER_ROWS });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.rolesSeeded).toBe(DEFAULT_ORG_UNIT_ROLES.center_program.length);
    expect(roles.map((x) => x.key).sort()).toEqual(["coe_liaison", "leader"]);
    expect(roles.every((x) => x.entityType === "center_program")).toBe(true);
  });

  it("migrates all 11 rows, entityId as \"{centerCode}:{programCode}\", carrying sortOrder", async () => {
    const { db, assignments } = makeDb({ legacy: MEYER_ROWS });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.legacyRows).toBe(11);
    expect(r.assignmentsCreated).toBe(11);
    expect(assignments).toHaveLength(11);
    expect(assignments.every((a) => a.entityType === "center_program")).toBe(true);
    expect(assignments.every((a) => a.entityId === "meyer_cancer_center:CB" || a.entityId.startsWith("meyer_cancer_center:"))).toBe(true);
    const ctLead3 = assignments.find((a) => a.cwid === "lead007");
    expect(ctLead3).toMatchObject({
      entityId: "meyer_cancer_center:CT",
      roleKey: "leader",
      sortOrder: 2,
      interim: false,
    });
  });

  it("carries interim across unchanged", async () => {
    const { db, assignments } = makeDb({ legacy: MEYER_ROWS });
    await runBackfill(db, { dryRun: false });
    expect(assignments.find((a) => a.cwid === "lead002")?.interim).toBe(true);
    expect(assignments.find((a) => a.cwid === "lead001")?.interim).toBe(false);
  });

  it("migrates coe_liaison rows with roleKey coe_liaison, not folded into leader", async () => {
    const { db, assignments } = makeDb({ legacy: MEYER_ROWS });
    await runBackfill(db, { dryRun: false });
    const liaisons = assignments.filter((a) => a.roleKey === "coe_liaison");
    expect(liaisons).toHaveLength(4);
    expect(liaisons.map((a) => a.cwid).sort()).toEqual(["liai001", "liai002", "liai003", "liai004"]);
  });

  it("is idempotent — a rerun reports 0 to insert / 11 already present", async () => {
    const { db, assignments, roles } = makeDb({ legacy: MEYER_ROWS });
    await runBackfill(db, { dryRun: false });
    const assignmentsAfterFirst = assignments.length;
    const rolesAfterFirst = roles.length;

    const second = await runBackfill(db, { dryRun: false });
    expect(second.rolesSeeded).toBe(0);
    expect(second.assignmentsCreated).toBe(0);
    expect(second.assignmentsAlreadyPresent).toBe(11);
    expect(assignments).toHaveLength(assignmentsAfterFirst);
    expect(roles).toHaveLength(rolesAfterFirst);
  });

  // No dual-write exists for this table (the ticket's own scope: the editor
  // keeps writing `CenterProgramLeader` only) — so a re-run only ever sees
  // NEW legacy rows the first pass missed, never a replaced cwid for one it
  // already migrated. This asserts that incremental case: a second co-leader
  // added to a program the first run already covered gets its OWN assignment,
  // leaving the existing one untouched (per-cwid dedup, not per-program).
  it("a rerun after a NEW co-leader was added to an already-migrated program creates only that one row", async () => {
    const { db, assignments } = makeDb({
      legacy: [
        { centerCode: "meyer_cancer_center", programCode: "CB", cwid: "lead001", role: "leader", interim: false, sortOrder: 0 },
      ],
      assignments: [
        {
          entityType: "center_program",
          entityId: "meyer_cancer_center:CB",
          cwid: "lead001",
          roleKey: "leader",
          interim: false,
          sortOrder: 0,
        },
      ],
    });
    // Second co-leader appears in the legacy table only (no dual-write exists
    // to have created its assignment already).
    db.centerProgramLeader.findMany = vi.fn(async () => [
      { centerCode: "meyer_cancer_center", programCode: "CB", cwid: "lead001", role: "leader", interim: false, sortOrder: 0 },
      { centerCode: "meyer_cancer_center", programCode: "CB", cwid: "lead002", role: "leader", interim: false, sortOrder: 1 },
    ]);
    const r = await runBackfill(db, { dryRun: false });
    expect(r.assignmentsCreated).toBe(1);
    expect(r.assignmentsAlreadyPresent).toBe(1);
    expect(assignments).toHaveLength(2);
    expect(assignments.map((a) => a.cwid).sort()).toEqual(["lead001", "lead002"]);
  });

  it("writes nothing on --dry-run, but still REPORTS the real counts", async () => {
    const { db, roles, assignments } = makeDb({ legacy: MEYER_ROWS });
    const r = await runBackfill(db, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(roles).toHaveLength(0);
    expect(assignments).toHaveLength(0);
    expect(r.rolesSeeded).toBe(DEFAULT_ORG_UNIT_ROLES.center_program.length);
    expect(r.assignmentsCreated).toBe(11);
  });

  it("THROWS rather than writing a dangling assignment FK when the vocabulary is missing", async () => {
    const { db } = makeDb({ legacy: MEYER_ROWS, seededRoleKeys: [] });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(
      /Missing 'center_program' vocabulary row/,
    );
  });

  it("handles zero legacy rows without error", async () => {
    const { db, assignments } = makeDb({ legacy: [] });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.legacyRows).toBe(0);
    expect(r.assignmentsCreated).toBe(0);
    expect(assignments).toHaveLength(0);
  });
});
