/**
 * #540 Phase 9 — unit-curation cutover backfill.
 *
 * Drives the exported, dependency-injected backfill functions with fake Prisma
 * delegates (no live DB). Covers:
 *   1. Center migration updates only `source='seed'` rows; `manual` is skipped.
 *   2. Membership migration touches only `source LIKE 'file:%'`; `manual` /
 *      `manual-ui` rows are skipped (edge case 26).
 *   3. --dry-run prints intent and writes nothing.
 *   4. Audit query C (manually-created units), ordered scholar_count ASC.
 *   5. Audit query E (manual rosters), ordered unit_kind, code.
 *   6. --limit constrains the candidate set processed.
 *   plus: arg parsing and fixture-load skip-when-populated.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  fixtureLoadCenters,
  migrateCenterSource,
  migrateMembershipSource,
  type BackfillDb,
  type BackfillOptions,
} from "@/scripts/backfills/2026-06-10-import-unit-curation";
import {
  runAuditQueryC,
  runAuditQueryE,
  type AuditDb,
} from "@/scripts/backfills/audit-unit-curation";

const RUN: BackfillOptions = { dryRun: false, limit: null };
const DRY: BackfillOptions = { dryRun: true, limit: null };

/** A center.findMany fake that filters on the `where.source` predicate. */
function makeCenterDb(
  centers: Array<{ code: string; source: string }>,
  overrides: Partial<BackfillDb["center"]> = {},
): { db: BackfillDb; updateManyArgs: unknown[] } {
  const updateManyArgs: unknown[] = [];
  const db: BackfillDb = {
    center: {
      count: vi.fn(async () => centers.length),
      findMany: vi.fn(async (args) => {
        let rows = centers;
        if (args.where?.source != null) rows = rows.filter((c) => c.source === args.where!.source);
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows.map((c) => ({ code: c.code }));
      }),
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async (args) => {
        updateManyArgs.push(args);
        const n = centers.filter((c) => c.source === args.where.source).length;
        return { count: n };
      }),
      ...overrides,
    },
    centerProgram: { upsert: vi.fn(async () => ({})) },
    centerMembership: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { db, updateManyArgs };
}

describe("parseArgs", () => {
  it("defaults to a real run with no limit", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null });
  });
  it("reads --dry-run and --limit=N", () => {
    expect(parseArgs(["--dry-run", "--limit=3"])).toEqual({ dryRun: true, limit: 3 });
  });
  it("rejects a non-positive --limit", () => {
    expect(() => parseArgs(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--limit=abc"])).toThrow(/positive integer/);
  });
});

describe("migrateCenterSource", () => {
  it("migrates only source='seed' rows; manual rows are skipped (case 1)", async () => {
    const { db } = makeCenterDb([
      { code: "meyer_cancer_center", source: "seed" },
      { code: "already_manual", source: "manual" },
    ]);
    const n = await migrateCenterSource(db, RUN);
    expect(n).toBe(1);
    // updateMany re-asserts the source='seed' predicate (WHERE-guarded).
    expect(db.center.updateMany).toHaveBeenCalledWith({
      where: { source: "seed" },
      data: { source: "manual" },
    });
  });

  it("is a no-op when no seed rows remain (idempotent re-run)", async () => {
    const { db } = makeCenterDb([{ code: "already_manual", source: "manual" }]);
    const n = await migrateCenterSource(db, RUN);
    expect(n).toBe(0);
    expect(db.center.updateMany).not.toHaveBeenCalled();
  });

  it("--dry-run reports candidates and writes nothing (case 3)", async () => {
    const { db } = makeCenterDb([
      { code: "meyer_cancer_center", source: "seed" },
      { code: "englander_ipm", source: "seed" },
    ]);
    const n = await migrateCenterSource(db, DRY);
    expect(n).toBe(0);
    expect(db.center.updateMany).not.toHaveBeenCalled();
  });

  it("--limit constrains the candidate set read (case 6)", async () => {
    const { db } = makeCenterDb([
      { code: "a", source: "seed" },
      { code: "b", source: "seed" },
      { code: "c", source: "seed" },
    ]);
    await migrateCenterSource(db, { dryRun: true, limit: 2 });
    expect(db.center.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: "seed" }, take: 2 }),
    );
  });
});

describe("migrateMembershipSource", () => {
  it("migrates only source LIKE 'file:%'; manual/manual-ui skipped (case 2, edge 26)", async () => {
    // The fake applies the startsWith predicate so we prove the WHERE scoping.
    const rows = [
      { source: "file:meyer.txt" },
      { source: "file:englander.txt" },
      { source: "manual-ui" },
      { source: "manual" },
    ];
    const updateMany = vi.fn(async (args: { where: { source: { startsWith: string } } }) => ({
      count: rows.filter((r) => r.source.startsWith(args.where.source.startsWith)).length,
    }));
    const db = {
      centerMembership: { updateMany },
    } as unknown as BackfillDb;
    const n = await migrateMembershipSource(db, RUN);
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { source: { startsWith: "file:" } },
      data: { source: "manual" },
    });
  });

  it("--dry-run writes nothing (case 3)", async () => {
    const updateMany = vi.fn(async () => ({ count: 99 }));
    const db = { centerMembership: { updateMany } } as unknown as BackfillDb;
    const n = await migrateMembershipSource(db, DRY);
    expect(n).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("fixtureLoadCenters", () => {
  it("skips when centers already exist (non-destructive on a populated DB)", async () => {
    const { db } = makeCenterDb([{ code: "meyer_cancer_center", source: "manual" }]);
    const res = await fixtureLoadCenters(db, RUN);
    expect(res).toEqual({ centersCreated: 0, programsUpserted: 0 });
    expect(db.center.upsert).not.toHaveBeenCalled();
  });

  it("creates the 11 centers + Meyer programs as source='manual' on an empty DB", async () => {
    const { db } = makeCenterDb([]);
    const res = await fixtureLoadCenters(db, RUN);
    // 11 centers post comms 2026-06-12 (was 8: -Computational Biomedicine,
    // -Iris Cantor, +Drukier, +Weill Metabolic, +Global Health, +Appel,
    // +Friedman). Tracks prisma/center-seed-data.ts CENTERS.
    expect(res.centersCreated).toBe(11);
    expect(res.programsUpserted).toBe(5);
    // every created row carries source='manual'
    const upsertCalls = (db.center.upsert as ReturnType<typeof vi.fn>).mock.calls;
    expect(upsertCalls).toHaveLength(11);
    for (const [arg] of upsertCalls) {
      expect((arg as { create: { source: string } }).create.source).toBe("manual");
    }
  });

  it("--dry-run on an empty DB writes nothing", async () => {
    const { db } = makeCenterDb([]);
    const res = await fixtureLoadCenters(db, DRY);
    expect(res).toEqual({ centersCreated: 0, programsUpserted: 0 });
    expect(db.center.upsert).not.toHaveBeenCalled();
    expect(db.centerProgram.upsert).not.toHaveBeenCalled();
  });
});

describe("audit query C — manually-created units (case 4)", () => {
  it("unions divisions + centers (source='manual'), ordered scholar_count ASC", async () => {
    const db: AuditDb = {
      division: {
        findMany: vi.fn(async () => [{ code: "N123", name: "Manual Div", scholarCount: 0 }]),
      },
      center: {
        findMany: vi.fn(async () => [
          { code: "meyer_cancer_center", name: "Meyer", scholarCount: 12 },
          { code: "aging_research", name: "Aging", scholarCount: 3 },
        ]),
      },
      centerMembership: { findMany: vi.fn(async () => []) },
      divisionMembership: { findMany: vi.fn(async () => []) },
    };
    const rows = await runAuditQueryC(db);
    expect(rows.map((r) => `${r.unit}:${r.code}:${r.scholarCount}`)).toEqual([
      "division:N123:0",
      "center:aging_research:3",
      "center:meyer_cancer_center:12",
    ]);
    expect(db.division.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: "manual" } }),
    );
    expect(db.center.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source: "manual" } }),
    );
  });
});

describe("audit query E — manual rosters (case 5)", () => {
  it("unions center + division memberships, ordered unit_kind then code", async () => {
    const db: AuditDb = {
      division: { findMany: vi.fn(async () => []) },
      center: { findMany: vi.fn(async () => []) },
      centerMembership: {
        findMany: vi.fn(async () => [
          { centerCode: "meyer_cancer_center", cwid: "abc1001", source: "manual" },
          { centerCode: "aging_research", cwid: "def2002", source: "file:aging.txt" },
        ]),
      },
      divisionMembership: {
        findMany: vi.fn(async () => [{ divisionCode: "N123", cwid: "ghi3003", source: "manual" }]),
      },
    };
    const rows = await runAuditQueryE(db);
    expect(rows.map((r) => `${r.unitKind}:${r.code}:${r.cwid}`)).toEqual([
      "center:aging_research:def2002",
      "center:meyer_cancer_center:abc1001",
      "division:N123:ghi3003",
    ]);
  });
});
