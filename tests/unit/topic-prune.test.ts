/**
 * #2166 — the `topic` catalog keyed prune plan: retire topics ReciterAI
 * dropped from TAXONOMY# (or newly excluded), but NEVER mass-delete on a
 * partial/truncated scan (gated by the shared guardedReplace floor,
 * MIN_FLOOR 50 / 50% max shrink).
 *
 * #2166 follow-up: a topic absent from TAXONOMY# but still carrying live
 * TOPIC# entries this run (a taxonomy/per-paper desync, not a genuine
 * retirement — found via the prod verification probe: implementation_science
 * had 4189 live entries despite being dropped from the catalog) must be held
 * back, not deleted. An explicitly excluded topic prunes regardless — that's
 * a deliberate governance decision, not a sync artifact.
 */
import { describe, it, expect, vi } from "vitest";

// projection-replace imports @/lib/db only to lazily construct Prisma; stub it
// so this stays a pure unit test with no client construction.
vi.mock("@/lib/db", () => ({ db: {} }));

import { planTopicPrune } from "@/etl/dynamodb/topic-prune";

const ids = (n: number, prefix = "t"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

const noProtection = { excludedIds: new Set<string>(), liveActivityIds: new Set<string>() };

describe("planTopicPrune", () => {
  it("marks an existing topic absent from this run's write set as stale", () => {
    const written = ids(60);
    const retired = "pain_management_and_anesthesiology";
    const existing = [...written, retired];
    const plan = planTopicPrune(written, existing, existing.length, noProtection);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([retired]);
    expect(plan.held).toEqual([]);
  });

  it("returns no stale ids when this run rewrote every existing topic", () => {
    const written = ids(67);
    const plan = planTopicPrune(written, written, written.length, noProtection);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it("refuses to prune when the write set is below the floor (partial scan)", () => {
    // live 67, incoming 10 → below the 50% floor → no prune, even though 57
    // existing topics would otherwise look stale.
    const plan = planTopicPrune(ids(10), ids(67), 67, noProtection);
    expect(plan.prune).toBe(false);
    expect(plan.stale).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it("allows the first/empty load (live 0 → floor 0)", () => {
    const plan = planTopicPrune([], [], 0, noProtection);
    expect(plan.prune).toBe(true);
    expect(plan.stale).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it("prunes an excluded topic even though it still has live TOPIC# entries", () => {
    const written = ids(66);
    const existing = [...written, "oral_craniofacial_health"];
    const plan = planTopicPrune(written, existing, existing.length, {
      excludedIds: new Set(["oral_craniofacial_health"]),
      liveActivityIds: new Set(["oral_craniofacial_health"]), // 93 live entries in reality
    });
    expect(plan.stale).toEqual(["oral_craniofacial_health"]);
    expect(plan.held).toEqual([]);
  });

  it("holds back a non-excluded topic that's absent from TAXONOMY# but still has live TOPIC# entries", () => {
    const written = ids(66);
    const existing = [...written, "implementation_science"];
    const plan = planTopicPrune(written, existing, existing.length, {
      excludedIds: new Set(),
      liveActivityIds: new Set(["implementation_science"]), // 4189 live entries in reality
    });
    expect(plan.stale).toEqual([]);
    expect(plan.held).toEqual(["implementation_science"]);
  });

  it("prunes a non-excluded absent topic with zero live TOPIC# entries (genuine retirement)", () => {
    const written = ids(66);
    const existing = [...written, "pain_management_anesthesiology"];
    const plan = planTopicPrune(written, existing, existing.length, {
      excludedIds: new Set(),
      liveActivityIds: new Set(), // 0 live entries — fully migrated upstream
    });
    expect(plan.stale).toEqual(["pain_management_anesthesiology"]);
    expect(plan.held).toEqual([]);
  });
});
