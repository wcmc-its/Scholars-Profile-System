/**
 * #2557 Phase E (T2) — `scripts/backfills/2026-08-31-role-scope-meyer-nci.ts`,
 * the day-one `OrgUnitRoleScope` seed (Meyer-only `research`/`clinical`
 * allowlist).
 *
 * Fake in-memory DB, same posture as `org-unit-roles.test.ts`'s `makeDb` for
 * the sibling #2542 backfill — no real Prisma client.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MEYER_CENTER_CODE,
  parseArgs,
  runRoleScopeSeed,
  type RoleScopeSeedDb,
} from "../../scripts/backfills/2026-08-31-role-scope-meyer-nci";

type ScopeRow = { entityType: string; roleKey: string; entityId: string };

function makeDb(opts: {
  centerExists?: boolean;
  vocabKeys?: string[]; // which of ["research", "clinical"] have a `center` OrgUnitRole row
  existingScopeRows?: ScopeRow[];
}) {
  const centerExists = opts.centerExists ?? true;
  const vocabKeys = opts.vocabKeys ?? ["research", "clinical"];
  const scopeRows: ScopeRow[] = [...(opts.existingScopeRows ?? [])];

  const db: RoleScopeSeedDb = {
    center: {
      findUnique: vi.fn(async (args: unknown) => {
        const where = (args as { where: { code: string } }).where;
        return centerExists && where.code === MEYER_CENTER_CODE ? { code: where.code } : null;
      }),
    },
    orgUnitRole: {
      findMany: vi.fn(async (args: unknown) => {
        const where = (args as { where: { entityType: string; key: { in: string[] } } }).where;
        return vocabKeys
          .filter((k) => where.key.in.includes(k))
          .map((k) => ({ entityType: where.entityType, key: k }));
      }),
    },
    orgUnitRoleScope: {
      findMany: vi.fn(async (args: unknown) => {
        const where = (
          args as {
            where: { entityType: string; roleKey: { in: string[] }; entityId: string };
          }
        ).where;
        return scopeRows.filter(
          (r) =>
            r.entityType === where.entityType &&
            where.roleKey.in.includes(r.roleKey) &&
            r.entityId === where.entityId,
        );
      }),
      createMany: vi.fn(async (args: unknown) => {
        const rows = (args as { data: ScopeRow[] }).data;
        let count = 0;
        for (const r of rows) {
          const dup = scopeRows.some(
            (x) => x.entityType === r.entityType && x.roleKey === r.roleKey && x.entityId === r.entityId,
          );
          if (!dup) {
            scopeRows.push({ ...r });
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  return { db, scopeRows };
}

describe("parseArgs", () => {
  it("recognizes --dry-run", () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
  });
});

describe("runRoleScopeSeed", () => {
  it("inserts exactly the two Meyer rows on a clean table", async () => {
    const { db, scopeRows } = makeDb({});
    const result = await runRoleScopeSeed(db, { dryRun: false });

    expect(result).toEqual({ rowsInserted: 2, rowsAlreadyPresent: 0, dryRun: false });
    expect(scopeRows).toEqual(
      expect.arrayContaining([
        { entityType: "center", roleKey: "research", entityId: MEYER_CENTER_CODE },
        { entityType: "center", roleKey: "clinical", entityId: MEYER_CENTER_CODE },
      ]),
    );
    expect(scopeRows).toHaveLength(2);
    expect(db.orgUnitRoleScope.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("is idempotent — a second run inserts nothing new", async () => {
    const { db, scopeRows } = makeDb({});
    await runRoleScopeSeed(db, { dryRun: false });
    const second = await runRoleScopeSeed(db, { dryRun: false });

    expect(second).toEqual({ rowsInserted: 0, rowsAlreadyPresent: 2, dryRun: false });
    expect(scopeRows).toHaveLength(2);
  });

  it("--dry-run reports what would change and writes nothing", async () => {
    const { db, scopeRows } = makeDb({});
    const result = await runRoleScopeSeed(db, { dryRun: true });

    expect(result).toEqual({ rowsInserted: 2, rowsAlreadyPresent: 0, dryRun: true });
    expect(scopeRows).toHaveLength(0);
    expect(db.orgUnitRoleScope.createMany).not.toHaveBeenCalled();
  });

  it("--dry-run on an already-seeded table reports 0 to insert, 2 already present", async () => {
    const { db } = makeDb({
      existingScopeRows: [
        { entityType: "center", roleKey: "research", entityId: MEYER_CENTER_CODE },
        { entityType: "center", roleKey: "clinical", entityId: MEYER_CENTER_CODE },
      ],
    });
    const result = await runRoleScopeSeed(db, { dryRun: true });
    expect(result).toEqual({ rowsInserted: 0, rowsAlreadyPresent: 2, dryRun: true });
    expect(db.orgUnitRoleScope.createMany).not.toHaveBeenCalled();
  });

  it("throws and writes nothing when the 'research' vocabulary row is missing", async () => {
    const { db, scopeRows } = makeDb({ vocabKeys: ["clinical"] });
    await expect(runRoleScopeSeed(db, { dryRun: false })).rejects.toThrow(/research/);
    expect(db.orgUnitRoleScope.createMany).not.toHaveBeenCalled();
    expect(scopeRows).toHaveLength(0);
  });

  it("throws and writes nothing when the 'clinical' vocabulary row is missing", async () => {
    const { db, scopeRows } = makeDb({ vocabKeys: ["research"] });
    await expect(runRoleScopeSeed(db, { dryRun: false })).rejects.toThrow(/clinical/);
    expect(db.orgUnitRoleScope.createMany).not.toHaveBeenCalled();
    expect(scopeRows).toHaveLength(0);
  });

  it("throws when BOTH vocabulary rows are missing, naming both", async () => {
    const { db } = makeDb({ vocabKeys: [] });
    await expect(runRoleScopeSeed(db, { dryRun: false })).rejects.toThrow(
      /research, clinical/,
    );
  });

  it("throws and writes nothing when the meyer_cancer_center Center row does not exist", async () => {
    const { db, scopeRows } = makeDb({ centerExists: false });
    await expect(runRoleScopeSeed(db, { dryRun: false })).rejects.toThrow(
      new RegExp(MEYER_CENTER_CODE),
    );
    expect(db.orgUnitRole.findMany).not.toHaveBeenCalled();
    expect(db.orgUnitRoleScope.createMany).not.toHaveBeenCalled();
    expect(scopeRows).toHaveLength(0);
  });
});
