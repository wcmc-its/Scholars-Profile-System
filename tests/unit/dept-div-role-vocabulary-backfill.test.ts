/**
 * Phase D — `scripts/backfills/2026-08-31-dept-div-role-vocabulary.ts`.
 *
 * Mirrors the `runBackfill` describe block in `tests/unit/org-unit-roles.test.ts`
 * (the center backfill's own test), against an in-memory fake DB with the same
 * SQL-semantics `matches()` helper (NOT JS `!==` — a NULL column matches
 * neither `= v` nor `<> v`, which is exactly the trap the center backfill's
 * own regression test exists to guard).
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ORG_UNIT_ROLES,
  DEPARTMENT_CHAIR_ROLE_KEY,
  DEPARTMENT_DIRECTOR_ROLE_KEY,
  DIVISION_CHIEF_ROLE_KEY,
} from "@/lib/org-unit-roles";
import {
  runBackfill,
  type DeptDivRoleBackfillDb,
} from "../../scripts/backfills/2026-08-31-dept-div-role-vocabulary";

type DeptRow = { code: string; category: string; chairCwid: string | null };
type DivRow = { code: string; chiefCwid: string | null };
type Assignment = { entityType: string; entityId: string; cwid: string; roleKey: string };

function makeDb(opts: {
  departments: DeptRow[];
  divisions: DivRow[];
  assignments?: Assignment[];
  seededRoleKeys?: { entityType: string; key: string }[];
}) {
  const assignments: Assignment[] = (opts.assignments ?? []).map((a) => ({ ...a }));
  const roles: { entityType: string; key: string }[] = [];

  // Same SQL-not-JS matcher the center backfill's test uses — `in` and plain
  // equality only, no negation.
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === "object" && "in" in (v as object)) {
        return ((v as { in: string[] }).in ?? []).includes(row[k] as string);
      }
      return row[k] === v;
    });

  const db: DeptDivRoleBackfillDb = {
    department: { findMany: vi.fn(async () => opts.departments) },
    division: { findMany: vi.fn(async () => opts.divisions) },
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
        return assignments.filter((a) =>
          matches(a as unknown as Record<string, unknown>, w),
        ) as Assignment[];
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

// Live shape, per the plan's 2026-08-31 probe: administrative -> director,
// everything else -> chair; a division has no category ternary at all.
const DEPARTMENTS: DeptRow[] = [
  { code: "medicine", category: "clinical", chairCwid: "chair001" },
  { code: "library", category: "administrative", chairCwid: "dir001" },
  { code: "basic_sci", category: "basic", chairCwid: null },
  { code: "mixed_dept", category: "mixed", chairCwid: "chair002" },
];

const DIVISIONS: DivRow[] = [
  { code: "cardiology_med", chiefCwid: "chief001" },
  { code: "no_chief_div", chiefCwid: null },
];

describe("runBackfill (dept/div/core role vocabulary)", () => {
  it("seeds the department/division/core vocabulary, not center's", async () => {
    const { db, roles } = makeDb({ departments: DEPARTMENTS, divisions: DIVISIONS });
    const r = await runBackfill(db, { dryRun: false });
    const expected =
      DEFAULT_ORG_UNIT_ROLES.department.length +
      DEFAULT_ORG_UNIT_ROLES.division.length +
      DEFAULT_ORG_UNIT_ROLES.core.length;
    expect(r.rolesSeeded).toBe(expected);
    expect(roles.some((x) => x.entityType === "center")).toBe(false);
    expect(roles.filter((x) => x.entityType === "core")).toHaveLength(
      DEFAULT_ORG_UNIT_ROLES.core.length,
    );
  });

  it("routes a clinical/mixed department to chair and an administrative one to director", async () => {
    const { db, assignments } = makeDb({ departments: DEPARTMENTS, divisions: [] });
    await runBackfill(db, { dryRun: false });
    const roleFor = (code: string) =>
      assignments.find((a) => a.entityType === "department" && a.entityId === code)?.roleKey;
    expect(roleFor("medicine")).toBe(DEPARTMENT_CHAIR_ROLE_KEY);
    expect(roleFor("mixed_dept")).toBe(DEPARTMENT_CHAIR_ROLE_KEY);
    expect(roleFor("library")).toBe(DEPARTMENT_DIRECTOR_ROLE_KEY);
  });

  it("skips a null chairCwid/chiefCwid and never creates a vacancy row", async () => {
    const { db, assignments } = makeDb({ departments: DEPARTMENTS, divisions: DIVISIONS });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.departmentLeadersCreated).toBe(3); // medicine, library, mixed_dept — NOT basic_sci
    expect(r.divisionLeadersCreated).toBe(1); // cardiology_med — NOT no_chief_div
    expect(assignments.some((a) => a.entityId === "basic_sci")).toBe(false);
    expect(assignments.some((a) => a.entityId === "no_chief_div")).toBe(false);
  });

  it("treats an empty-string leader as an explicit vacancy, same as null", async () => {
    const { db, assignments } = makeDb({
      departments: [{ code: "vacant_dept", category: "clinical", chairCwid: "" }],
      divisions: [{ code: "vacant_div", chiefCwid: "" }],
    });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.departmentLeadersCreated).toBe(0);
    expect(r.divisionLeadersCreated).toBe(0);
    expect(assignments).toHaveLength(0);
  });

  it("writes interim: false — dept/div carry no leaderInterim column to carry across", async () => {
    const { db, assignments } = makeDb({ departments: DEPARTMENTS, divisions: DIVISIONS });
    await runBackfill(db, { dryRun: false });
    expect(assignments.every((a) => (a as unknown as { interim: boolean }).interim === false)).toBe(
      true,
    );
  });

  it("does NOT write any core assignment, even with core vocabulary seeded", async () => {
    const { db, assignments } = makeDb({ departments: DEPARTMENTS, divisions: DIVISIONS });
    await runBackfill(db, { dryRun: false });
    expect(assignments.some((a) => a.entityType === "core")).toBe(false);
  });

  it("creates a division chief assignment from chiefCwid", async () => {
    const { db, assignments } = makeDb({ departments: [], divisions: DIVISIONS });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.divisionLeadersCreated).toBe(1);
    expect(assignments).toEqual([
      {
        entityType: "division",
        entityId: "cardiology_med",
        cwid: "chief001",
        roleKey: DIVISION_CHIEF_ROLE_KEY,
        interim: false,
      },
    ]);
  });

  it("is idempotent — a second run seeds nothing and creates no duplicate leader", async () => {
    const { db, roles, assignments } = makeDb({ departments: DEPARTMENTS, divisions: DIVISIONS });
    await runBackfill(db, { dryRun: false });
    const rolesAfterFirst = roles.length;
    const assignmentsAfterFirst = assignments.length;

    const second = await runBackfill(db, { dryRun: false });
    expect(second.rolesSeeded).toBe(0);
    expect(second.departmentLeadersCreated).toBe(0);
    expect(second.divisionLeadersCreated).toBe(0);
    expect(roles).toHaveLength(rolesAfterFirst);
    expect(assignments).toHaveLength(assignmentsAfterFirst);
  });

  it("does NOT resurrect a chair a curator has since replaced", async () => {
    const { db, assignments } = makeDb({
      departments: [{ code: "medicine", category: "clinical", chairCwid: "OLD001" }],
      divisions: [],
      assignments: [
        { entityType: "department", entityId: "medicine", cwid: "new999", roleKey: "chair" },
      ],
    });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.departmentLeadersCreated).toBe(0);
    expect(r.departmentLeadersAlreadyPresent).toBe(1);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].cwid).toBe("new999");
  });

  it("writes nothing on --dry-run, but still REPORTS the real counts", async () => {
    const { db, roles, assignments } = makeDb({ departments: DEPARTMENTS, divisions: DIVISIONS });
    const r = await runBackfill(db, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(roles).toHaveLength(0);
    expect(assignments).toHaveLength(0);
    const expectedRoles =
      DEFAULT_ORG_UNIT_ROLES.department.length +
      DEFAULT_ORG_UNIT_ROLES.division.length +
      DEFAULT_ORG_UNIT_ROLES.core.length;
    expect(r.rolesSeeded).toBe(expectedRoles);
    expect(r.departmentLeadersCreated).toBe(3);
    expect(r.divisionLeadersCreated).toBe(1);
  });

  it("THROWS rather than writing a dangling leadership key when the department vocabulary is missing", async () => {
    const { db } = makeDb({
      departments: DEPARTMENTS,
      divisions: [],
      seededRoleKeys: [],
    });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(
      /Missing department vocabulary row/,
    );
  });

  it("THROWS rather than writing a dangling leadership key when the division vocabulary is missing", async () => {
    const { db } = makeDb({
      departments: [],
      divisions: DIVISIONS,
      seededRoleKeys: [],
    });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(/Missing 'chief' vocabulary row/);
  });
});
