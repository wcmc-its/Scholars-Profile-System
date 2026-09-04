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
    const writes = keys(50); // pmid "0".."49", core "14"
    const samePmidDifferentCore = k("0", "1"); // NOT in the write set
    const existing = [...writes, samePmidDifferentCore];
    const plan = planPublicationCorePrune(writes, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([samePmidDifferentCore]);
  });
});
