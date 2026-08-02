/**
 * #2166 — the `topic` catalog keyed prune plan: retire topics ReciterAI
 * dropped from TAXONOMY# (or newly excluded), but NEVER mass-delete on a
 * partial/truncated scan (gated by the shared guardedReplace floor,
 * MIN_FLOOR 50 / 50% max shrink).
 */
import { describe, it, expect, vi } from "vitest";

// projection-replace imports @/lib/db only to lazily construct Prisma; stub it
// so this stays a pure unit test with no client construction.
vi.mock("@/lib/db", () => ({ db: {} }));

import { planTopicPrune } from "@/etl/dynamodb/topic-prune";

const ids = (n: number, prefix = "t"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("planTopicPrune", () => {
  it("marks an existing topic absent from this run's write set as stale", () => {
    const written = ids(60);
    const retired = "pain_management_and_anesthesiology";
    const existing = [...written, retired];
    const plan = planTopicPrune(written, existing, existing.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([retired]);
  });

  it("returns no stale ids when this run rewrote every existing topic", () => {
    const written = ids(67);
    const plan = planTopicPrune(written, written, written.length);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
  });

  it("refuses to prune when the write set is below the floor (partial scan)", () => {
    // live 67, incoming 10 → below the 50% floor → no prune, even though 57
    // existing topics would otherwise look stale.
    const plan = planTopicPrune(ids(10), ids(67), 67);
    expect(plan.prune).toBe(false);
    expect(plan.stale).toEqual([]);
  });

  it("allows the first/empty load (live 0 → floor 0)", () => {
    const plan = planTopicPrune([], [], 0);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
  });

  it("prunes a topic newly added to the exclusion list even though TAXONOMY# still lists it", () => {
    // Caller already filtered excluded ids out of `written` before calling in —
    // this just confirms the excluded id (present in `existing` from a prior
    // run, absent from `written`) is treated as stale like any other drop.
    const written = ids(66);
    const existing = [...written, "oral_craniofacial_health"];
    const plan = planTopicPrune(written, existing, existing.length);
    expect(plan.stale).toEqual(["oral_craniofacial_health"]);
  });
});
