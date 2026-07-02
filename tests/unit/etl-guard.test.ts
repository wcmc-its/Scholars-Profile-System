import { afterEach, describe, expect, it } from "vitest";

import { EtlGuardError, assertPruneVolume, assertSourceVolume } from "@/lib/etl-guard";

afterEach(() => {
  delete process.env.ETL_GUARD_BYPASS;
});

describe("assertSourceVolume", () => {
  it("passes when incoming meets the floor and drop bound", () => {
    expect(() =>
      assertSourceVolume("t:src", { incoming: 9000, existing: 9100, floor: 5000, maxDropPct: 2 }),
    ).not.toThrow();
  });

  it("throws below the absolute floor", () => {
    expect(() => assertSourceVolume("t:src", { incoming: 50, floor: 5000 })).toThrow(
      EtlGuardError,
    );
  });

  it("throws when the drop vs existing exceeds maxDropPct", () => {
    expect(() =>
      assertSourceVolume("t:src", { incoming: 100, existing: 1000, maxDropPct: 50 }),
    ).toThrow(/90\.0% drop/);
  });

  it("allows growth and small shrink within maxDropPct", () => {
    expect(() =>
      assertSourceVolume("t:src", { incoming: 990, existing: 1000, maxDropPct: 2 }),
    ).not.toThrow();
    expect(() =>
      assertSourceVolume("t:src", { incoming: 2000, existing: 1000, maxDropPct: 2 }),
    ).not.toThrow();
  });

  it("skips the drop check on bootstrap (existing=0)", () => {
    expect(() =>
      assertSourceVolume("t:src", { incoming: 0, existing: 0, maxDropPct: 50 }),
    ).not.toThrow();
  });
});

describe("assertPruneVolume", () => {
  it("passes a small prune", () => {
    expect(() => assertPruneVolume("t:prune", { pruning: 10, of: 9000, maxPct: 2 })).not.toThrow();
  });

  it("throws on an implausibly large prune", () => {
    expect(() => assertPruneVolume("t:prune", { pruning: 8000, of: 9000, maxPct: 2 })).toThrow(
      EtlGuardError,
    );
  });

  it("no-ops when there is nothing to prune from", () => {
    expect(() => assertPruneVolume("t:prune", { pruning: 0, of: 0, maxPct: 2 })).not.toThrow();
  });
});

describe("ETL_GUARD_BYPASS", () => {
  it("bypasses a named guard", () => {
    process.env.ETL_GUARD_BYPASS = "t:src, other:guard";
    expect(() => assertSourceVolume("t:src", { incoming: 0, floor: 5000 })).not.toThrow();
  });

  it("bypasses everything with 'all'", () => {
    process.env.ETL_GUARD_BYPASS = "all";
    expect(() => assertPruneVolume("t:prune", { pruning: 9000, of: 9000, maxPct: 2 })).not.toThrow();
  });

  it("does not bypass unrelated guards", () => {
    process.env.ETL_GUARD_BYPASS = "other:guard";
    expect(() => assertSourceVolume("t:src", { incoming: 0, floor: 5000 })).toThrow(EtlGuardError);
  });
});
