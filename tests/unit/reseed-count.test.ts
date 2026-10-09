/**
 * #1987 — post-reseed row-count assertion.
 *
 * `mesh_curated_alias` sat ~8 weeks stale in prod (10 rows vs 74 in the
 * checked-in CSV) and freshness could not see it: it grades the recency of the
 * last SUCCESS and never reads row counts. The curated-CSV loaders now count
 * the table inside their reseed transaction and throw on a mismatch, which
 * rolls the reseed back and fails the run.
 *
 * Two layers: the pure comparison, then each loader's wiring driven through a
 * fake transaction client (the DB itself is out of reach of a unit test).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertReseedCount, reseedCountMismatch } from "@/lib/etl/reseed-count";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: {
    write: {
      $transaction: transaction,
      $disconnect: vi.fn(),
      etlRun: { create: vi.fn() },
    },
    read: {},
  },
}));

afterEach(() => {
  transaction.mockReset();
  vi.resetModules();
});

describe("reseedCountMismatch / assertReseedCount", () => {
  const base = {
    source: "MeshAlias",
    table: "mesh_curated_alias",
    from: "etl/mesh-aliases/curated.csv",
  };

  it("passes when the table holds exactly the loaded rows", () => {
    expect(reseedCountMismatch({ ...base, expected: 74, actual: 74 })).toBeNull();
    expect(() => assertReseedCount({ ...base, expected: 74, actual: 74 })).not.toThrow();
  });

  it("fails with a message naming the table, both counts, the source and the delta", () => {
    // The prod shape: 10 rows against a 74-row CSV.
    const msg = reseedCountMismatch({ ...base, expected: 74, actual: 10 });
    expect(msg).toBe(
      "[MeshAlias] post-reseed row count mismatch: mesh_curated_alias holds 10 row(s) but 74 " +
        "were loaded from etl/mesh-aliases/curated.csv (-64) — refusing to commit a reseed " +
        "that does not match its source (#1987)",
    );
    expect(() => assertReseedCount({ ...base, expected: 74, actual: 10 })).toThrow(msg!);
  });

  it("fails in the other direction too — extra rows are as wrong as missing ones", () => {
    expect(reseedCountMismatch({ ...base, expected: 74, actual: 75 })).toMatch(/\(\+1\)/);
  });

  it("treats 0 = 0 as a match (the empty-CSV refusal is readCurated's job, not this one's)", () => {
    expect(reseedCountMismatch({ ...base, expected: 0, actual: 0 })).toBeNull();
  });
});

/** A transaction client whose every model method resolves, and whose count() returns `count`. */
function fakeTx(count: number) {
  const model = {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => []),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    count: vi.fn(async () => count),
  };
  return {
    model,
    tx: {
      meshCuratedAlias: model,
      familySensitivityOverlay: model,
      familySuppressionOverlay: model,
      familyTierDecision: { findMany: vi.fn(async () => []) },
    },
  };
}

function runTransactionsAgainst(tx: unknown): void {
  transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
}

describe("MeshAlias replaceAliases checks the table against the CSV", () => {
  const rows = [
    { alias: "Robotic surgery", descriptorUi: "D065287", sourceNote: null },
    { alias: "Cardiothoracic Surgery", descriptorUi: "D013903", sourceNote: null },
  ];

  it("commits when the count matches", async () => {
    const { tx, model } = fakeTx(2);
    runTransactionsAgainst(tx);
    const { replaceAliases } = await import("@/etl/mesh-aliases");
    await expect(replaceAliases(rows)).resolves.toBeUndefined();
    expect(model.count).toHaveBeenCalledWith();
  });

  it("throws (rolling the transaction back) when it does not", async () => {
    const { tx } = fakeTx(1);
    runTransactionsAgainst(tx);
    const { replaceAliases } = await import("@/etl/mesh-aliases");
    await expect(replaceAliases(rows)).rejects.toThrow(
      /\[MeshAlias\] post-reseed row count mismatch: mesh_curated_alias holds 1 row\(s\) but 2/,
    );
  });
});

describe.each([
  { source: "FamilySensitivity", load: () => import("@/etl/family-sensitivity") },
  { source: "FamilySuppression", load: () => import("@/etl/family-suppression") },
])(
  "$source replaceRows checks the seed partition against the kept CSV keys",
  ({ source, load }) => {
    // Three CSV rows, one a duplicate key: the seed partition must hold TWO.
    const rows = [
      {
        supercategory: "computational_statistical",
        familyLabel: "Regression modeling",
        sourceNote: null,
      },
      {
        supercategory: "computational_statistical",
        familyLabel: "Regression modeling",
        sourceNote: "dup",
      },
      { supercategory: "study_design", familyLabel: "Cohort study", sourceNote: null },
    ];

    it("compares against the post-dedup key count, scoped to source='seed'", async () => {
      const { tx, model } = fakeTx(2);
      runTransactionsAgainst(tx);
      const { replaceRows } = await load();
      await expect(replaceRows(rows)).resolves.toMatchObject({ deleted: 0 });
      expect(model.count).toHaveBeenCalledWith({ where: { source: "seed" } });
    });

    it("throws on a mismatch", async () => {
      const { tx } = fakeTx(3);
      runTransactionsAgainst(tx);
      const { replaceRows } = await load();
      await expect(replaceRows(rows)).rejects.toThrow(
        new RegExp(`\\[${source}\\] post-reseed row count mismatch: .*holds 3 row\\(s\\) but 2`),
      );
    });
  },
);
