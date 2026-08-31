/**
 * `writeUnitLeaderAssignment` — the #2542 Phase D ETL dual-write helper.
 *
 * Every `chairCwid` / `chiefCwid` write site in `etl/ed/index.ts` calls this
 * immediately after, with the SAME already-resolved cwid, so
 * `OrgUnitRoleAssignment` never diverges from the legacy column the nightly
 * ETL rewrites. Covers PLAN-org-unit-roles-next-phases-2026-08-31.md's Phase D
 * dual-write requirements:
 *   - the assignment is written alongside the column's resolved value
 *   - a resolved vacancy (`cwid: null`) DELETES any existing row
 *   - a department `category` flip (chair <-> director between runs) never
 *     leaves both keys' rows behind
 */
import { describe, expect, it, vi } from "vitest";

import { writeUnitLeaderAssignment } from "@/etl/ed/index";
import {
  DEPARTMENT_CHAIR_ROLE_KEY,
  DEPARTMENT_DIRECTOR_ROLE_KEY,
  DIVISION_CHIEF_ROLE_KEY,
} from "@/lib/org-unit-roles";

type FakeRow = { entityType: string; entityId: string; cwid: string; roleKey: string };
type FakeClient = Parameters<typeof writeUnitLeaderAssignment>[0];

/**
 * An in-memory stand-in for the two Prisma delegates the helper touches.
 * Faithful enough to prove the real invariant (final row state), not just
 * that a particular Prisma method was called with particular args.
 */
function makeFakeClient() {
  const rows: FakeRow[] = [];
  const seedCalls: unknown[][] = [];
  const createMany = vi.fn(async (args: { data: unknown[] }) => {
    seedCalls.push(args.data);
    return { count: args.data.length };
  });
  const deleteMany = vi.fn(
    async (args: { where: { entityType: string; entityId: string; roleKey: string } }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i];
        if (
          r.entityType === args.where.entityType &&
          r.entityId === args.where.entityId &&
          r.roleKey === args.where.roleKey
        ) {
          rows.splice(i, 1);
        }
      }
      return { count: before - rows.length };
    },
  );
  const create = vi.fn(async (args: { data: FakeRow }) => {
    rows.push(args.data);
    return args.data;
  });
  const client = {
    orgUnitRole: { createMany },
    orgUnitRoleAssignment: { deleteMany, create },
  } as unknown as FakeClient;
  return { client, rows, seedCalls, createMany, deleteMany, create };
}

describe("writeUnitLeaderAssignment", () => {
  it("seeds the vocabulary and creates the assignment for a resolved leader (division)", async () => {
    const { client, rows, seedCalls } = makeFakeClient();
    await writeUnitLeaderAssignment(client, {
      entityType: "division",
      entityId: "CARDIO",
      roleKey: DIVISION_CHIEF_ROLE_KEY,
      cwid: "chf0001",
    });
    expect(seedCalls).toHaveLength(1);
    expect(rows).toEqual([
      { entityType: "division", entityId: "CARDIO", cwid: "chf0001", roleKey: "chief" },
    ]);
  });

  it("seeds and creates for a department (chair)", async () => {
    const { client, rows } = makeFakeClient();
    await writeUnitLeaderAssignment(client, {
      entityType: "department",
      entityId: "MED",
      roleKey: DEPARTMENT_CHAIR_ROLE_KEY,
      otherRoleKey: DEPARTMENT_DIRECTOR_ROLE_KEY,
      cwid: "chr0001",
    });
    expect(rows).toEqual([
      { entityType: "department", entityId: "MED", cwid: "chr0001", roleKey: "chair" },
    ]);
  });

  it("a resolved vacancy (cwid: null) deletes any existing row and creates nothing", async () => {
    const { client, rows, create } = makeFakeClient();
    rows.push({ entityType: "division", entityId: "CARDIO", cwid: "old0001", roleKey: "chief" });
    await writeUnitLeaderAssignment(client, {
      entityType: "division",
      entityId: "CARDIO",
      roleKey: DIVISION_CHIEF_ROLE_KEY,
      cwid: null,
    });
    expect(rows).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("a no-op vacancy on a unit with no existing row still creates nothing", async () => {
    const { client, rows, create } = makeFakeClient();
    await writeUnitLeaderAssignment(client, {
      entityType: "division",
      entityId: "EMPTY",
      roleKey: DIVISION_CHIEF_ROLE_KEY,
      cwid: null,
    });
    expect(rows).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("re-writing the same holder is idempotent — a single row, never duplicated", async () => {
    const { client, rows } = makeFakeClient();
    for (let i = 0; i < 2; i += 1) {
      await writeUnitLeaderAssignment(client, {
        entityType: "division",
        entityId: "CARDIO",
        roleKey: DIVISION_CHIEF_ROLE_KEY,
        cwid: "chf0001",
      });
    }
    expect(rows).toEqual([
      { entityType: "division", entityId: "CARDIO", cwid: "chf0001", roleKey: "chief" },
    ]);
  });

  it("a new holder replaces the old one (vacate-then-grant), not a second row", async () => {
    const { client, rows } = makeFakeClient();
    await writeUnitLeaderAssignment(client, {
      entityType: "division",
      entityId: "CARDIO",
      roleKey: DIVISION_CHIEF_ROLE_KEY,
      cwid: "chf0001",
    });
    await writeUnitLeaderAssignment(client, {
      entityType: "division",
      entityId: "CARDIO",
      roleKey: DIVISION_CHIEF_ROLE_KEY,
      cwid: "chf0002",
    });
    expect(rows).toEqual([
      { entityType: "division", entityId: "CARDIO", cwid: "chf0002", roleKey: "chief" },
    ]);
  });

  it("a department category flip (chair -> director) leaves exactly one row, not two", async () => {
    const { client, rows } = makeFakeClient();
    // Run N: N1932 is clinical, holder assigned as chair.
    await writeUnitLeaderAssignment(client, {
      entityType: "department",
      entityId: "N1932",
      roleKey: DEPARTMENT_CHAIR_ROLE_KEY,
      otherRoleKey: DEPARTMENT_DIRECTOR_ROLE_KEY,
      cwid: "hld0001",
    });
    expect(rows).toEqual([
      { entityType: "department", entityId: "N1932", cwid: "hld0001", roleKey: "chair" },
    ]);

    // Run N+1: N1932 reclassified administrative — same holder, now director.
    await writeUnitLeaderAssignment(client, {
      entityType: "department",
      entityId: "N1932",
      roleKey: DEPARTMENT_DIRECTOR_ROLE_KEY,
      otherRoleKey: DEPARTMENT_CHAIR_ROLE_KEY,
      cwid: "hld0001",
    });
    expect(rows).toEqual([
      { entityType: "department", entityId: "N1932", cwid: "hld0001", roleKey: "director" },
    ]);
  });

  it("a department category flip the OTHER direction (director -> chair) also leaves one row", async () => {
    const { client, rows } = makeFakeClient();
    await writeUnitLeaderAssignment(client, {
      entityType: "department",
      entityId: "N1932",
      roleKey: DEPARTMENT_DIRECTOR_ROLE_KEY,
      otherRoleKey: DEPARTMENT_CHAIR_ROLE_KEY,
      cwid: "hld0001",
    });
    await writeUnitLeaderAssignment(client, {
      entityType: "department",
      entityId: "N1932",
      roleKey: DEPARTMENT_CHAIR_ROLE_KEY,
      otherRoleKey: DEPARTMENT_DIRECTOR_ROLE_KEY,
      cwid: "hld0001",
    });
    expect(rows).toEqual([
      { entityType: "department", entityId: "N1932", cwid: "hld0001", roleKey: "chair" },
    ]);
  });

  it("a department vacancy with otherRoleKey clears BOTH keys (mirrors the chairDeptsToClear site)", async () => {
    const { client, rows } = makeFakeClient();
    rows.push({ entityType: "department", entityId: "N1932", cwid: "hld0001", roleKey: "chair" });
    rows.push({ entityType: "department", entityId: "N1932", cwid: "hld0001", roleKey: "director" });
    await writeUnitLeaderAssignment(client, {
      entityType: "department",
      entityId: "N1932",
      roleKey: DEPARTMENT_CHAIR_ROLE_KEY,
      otherRoleKey: DEPARTMENT_DIRECTOR_ROLE_KEY,
      cwid: null,
    });
    expect(rows).toEqual([]);
  });

  it("only touches the SAME (entityType, entityId, roleKey) — other units' rows survive", async () => {
    const { client, rows } = makeFakeClient();
    rows.push({ entityType: "division", entityId: "OTHER", cwid: "keep0001", roleKey: "chief" });
    rows.push({ entityType: "department", entityId: "CARDIO", cwid: "keep0002", roleKey: "chair" });
    await writeUnitLeaderAssignment(client, {
      entityType: "division",
      entityId: "CARDIO",
      roleKey: DIVISION_CHIEF_ROLE_KEY,
      cwid: "chf0002",
    });
    expect(rows).toContainEqual({
      entityType: "division",
      entityId: "OTHER",
      cwid: "keep0001",
      roleKey: "chief",
    });
    expect(rows).toContainEqual({
      entityType: "department",
      entityId: "CARDIO",
      cwid: "keep0002",
      roleKey: "chair",
    });
    expect(rows).toContainEqual({
      entityType: "division",
      entityId: "CARDIO",
      cwid: "chf0002",
      roleKey: "chief",
    });
  });

  it("seeds the vocabulary even on a vacancy — a predating unit must not throw MySQL 1452 later", async () => {
    const { client, seedCalls } = makeFakeClient();
    await writeUnitLeaderAssignment(client, {
      entityType: "department",
      entityId: "N1932",
      roleKey: DEPARTMENT_DIRECTOR_ROLE_KEY,
      otherRoleKey: DEPARTMENT_CHAIR_ROLE_KEY,
      cwid: null,
    });
    expect(seedCalls).toHaveLength(1);
    const seeded = seedCalls[0] as Array<{ entityType: string; key: string }>;
    expect(seeded.every((r) => r.entityType === "department")).toBe(true);
    expect(seeded.map((r) => r.key).sort()).toEqual(["chair", "director"]);
  });
});
