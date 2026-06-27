/**
 * #1265 — reconcileEntityCountsToFeed: the rail must never advertise a link the
 * feed can't honor. Pure; no DB. Verifies the count is overwritten with the live
 * feed-visible pmid count, entities with zero visible papers are dropped, and the
 * list is re-ranked by the live count (the stored order was by the stale count).
 */
import { describe, expect, it } from "vitest";

import { reconcileEntityCountsToFeed, type CellLineEntity } from "@/lib/api/methods";

function ent(p: Partial<CellLineEntity> & { entityId: string; label: string; usageCount: number }): CellLineEntity {
  return {
    evidenced: true,
    parentEntityId: null,
    parentLabel: null,
    parentDescriptor: null,
    isGeneric: false,
    dominantKind: null,
    ...p,
  };
}

describe("reconcileEntityCountsToFeed", () => {
  it("drops an entity whose usage pmids are all outside the visible feed set (#1265)", () => {
    // The exact #1265 case: rail says "1 paper" but the feed returns 0.
    const entities = [
      ent({ entityId: "tool_001179", label: "3D cerebral organoids", usageCount: 2 }),
      ent({ entityId: "tool_013627", label: "human and murine organoid models", usageCount: 1 }),
    ];
    const visible = new Map<string, Set<string>>([
      ["tool_001179", new Set(["34789849", "38263175"])],
      ["tool_013627", new Set()], // pmid 42167227 not in the family's visible set → empty
    ]);
    const out = reconcileEntityCountsToFeed(entities, visible);
    expect(out.map((e) => e.entityId)).toEqual(["tool_001179"]);
    expect(out[0].usageCount).toBe(2);
  });

  it("clamps an off-by-one count to the visible total (rail 2 → feed 1)", () => {
    const entities = [ent({ entityId: "t", label: "x", usageCount: 2 })];
    const out = reconcileEntityCountsToFeed(entities, new Map([["t", new Set(["111"])]]));
    expect(out[0].usageCount).toBe(1);
  });

  it("re-ranks by the live count, not the stored one", () => {
    const entities = [
      ent({ entityId: "a", label: "Alpha", usageCount: 9 }), // stored-high, live-low
      ent({ entityId: "b", label: "Bravo", usageCount: 1 }), // stored-low, live-high
    ];
    const visible = new Map<string, Set<string>>([
      ["a", new Set(["1"])],
      ["b", new Set(["1", "2", "3"])],
    ]);
    const out = reconcileEntityCountsToFeed(entities, visible);
    expect(out.map((e) => e.entityId)).toEqual(["b", "a"]);
  });

  it("breaks count ties by label asc, deterministically", () => {
    const entities = [
      ent({ entityId: "z", label: "Zeta", usageCount: 5 }),
      ent({ entityId: "a", label: "Alpha", usageCount: 5 }),
    ];
    const visible = new Map<string, Set<string>>([
      ["z", new Set(["1", "2"])],
      ["a", new Set(["3", "4"])],
    ]);
    const out = reconcileEntityCountsToFeed(entities, visible);
    expect(out.map((e) => e.label)).toEqual(["Alpha", "Zeta"]);
  });

  it("returns [] when nothing is visible", () => {
    const entities = [ent({ entityId: "t", label: "x", usageCount: 3 })];
    expect(reconcileEntityCountsToFeed(entities, new Map())).toEqual([]);
    expect(reconcileEntityCountsToFeed([], new Map())).toEqual([]);
  });
});
