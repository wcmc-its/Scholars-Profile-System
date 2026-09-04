/**
 * #2601 — the publication_core keyed prune plan: remove (pmid, coreId) pairs the
 * cores engine demoted to `below_threshold` (the mapper drops them, so they fall
 * out of the write set), but NEVER mass-delete on a partial/truncated CORE# scan
 * (gated by the shared guardedReplace floor, MIN_FLOOR 50 / 50% max shrink).
 */
import { describe, it, expect, vi } from "vitest";

// projection-replace imports @/lib/db only to lazily construct Prisma; stub it
// so this stays a pure unit test with no client construction.
vi.mock("@/lib/db", () => ({ db: {} }));

import { planPublicationCorePrune, type PubCoreKey } from "@/etl/dynamodb/publication-core-prune";

const k = (pmid: string, coreId: string): PubCoreKey => ({ pmid, coreId });
const keys = (n: number, coreId = "14"): PubCoreKey[] =>
  Array.from({ length: n }, (_, i) => k(String(i), coreId));

describe("planPublicationCorePrune", () => {
  it("marks existing keys absent from the write set as stale (the demoted pair)", () => {
    const writes = keys(50);
    const demoted = k("99999", "14"); // re-scored below_threshold → dropped by the mapper
    const existing = [...writes, demoted];
    const plan = planPublicationCorePrune(writes, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([demoted]);
  });

  it("returns no stale keys when the write set covers every existing key", () => {
    const rows = keys(50);
    const plan = planPublicationCorePrune(rows, rows, rows.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
  });

  it("refuses to prune when the write set is below the floor (partial scan)", () => {
    // live 100, incoming 10 → below the 50% floor → no prune, even though 90
    // existing keys would otherwise look stale.
    const plan = planPublicationCorePrune(keys(10), keys(100), 100);
    expect(plan.prune).toBe(false);
    expect(plan.stale).toEqual([]);
  });

  it("allows the first/empty load (live 0 → floor 0)", () => {
    const plan = planPublicationCorePrune([], [], 0);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
  });

  it("distinguishes keys sharing a pmid but differing in coreId", () => {
    // core "1" must have a write of its own, else the zero-write hold-back
    // (below) retains it instead of pruning it.
    const writes = [...keys(50), k("7", "1")]; // pmid "0".."49" core "14", plus core "1"
    const samePmidDifferentCore = k("0", "1"); // NOT in the write set
    const existing = [...writes, samePmidDifferentCore];
    const plan = planPublicationCorePrune(writes, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([samePmidDifferentCore]);
  });

  it("does not let a delimiter-free key encoding collide two different pairs", () => {
    // The regression this locks: a naive `pmid + coreId` key makes ("1","23")
    // and ("12","3") both "123", so the SECOND pair looks already-written and
    // is silently retained. Every other test in this file stays green under
    // that mutation — only a real collision pair separates the two encodings.
    const writes = [...keys(50), k("1", "23"), k("99", "3")];
    const collides = k("12", "3"); // "123" under concat, distinct under JSON
    const existing = [...writes, collides];
    const plan = planPublicationCorePrune(writes, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([collides]);
  });

  it("HOLDS BACK rather than prunes every row of a core that got zero writes", () => {
    // The failure the whole-table floor cannot see: the engine emits nothing
    // for one core while the others keep the global write set above the floor.
    // Without this, that core's entire review queue is deleted in one run.
    const writes = keys(50); // core "14" only
    const quietCore = [k("900", "5"), k("901", "5"), k("902", "5")];
    const existing = [...writes, ...quietCore];
    const plan = planPublicationCorePrune(writes, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
    expect(plan.held).toEqual(quietCore);
  });

  it("still prunes a demoted pair in a core that IS live this run", () => {
    // The hold-back must not swallow the actual #2601 case: core "14" is
    // emitting, one of its pairs was demoted, that pair is stale not held.
    const writes = keys(50);
    const demoted = k("50", "14");
    const existing = [...writes, demoted];
    const plan = planPublicationCorePrune(writes, existing, existing.length);
    expect(plan.stale).toEqual([demoted]);
    expect(plan.held).toEqual([]);
  });
});
