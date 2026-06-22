/**
 * #1166 — the Surface-B directory grouping helper (groupCellLineDirectory). Pure;
 * no DB. Verifies parent nesting (two 3T3-L1 forms collapse under one group, a
 * separate line stays flat), single-form degradation, and rank-stability.
 */
import { describe, expect, it } from "vitest";

import { groupCellLineDirectory, type CellLineEntity } from "@/lib/api/methods";

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

describe("groupCellLineDirectory", () => {
  it("nests forms sharing a parent and keeps a distinct line flat", () => {
    const entities = [
      ent({ entityId: "t1", label: "3T3-L1 adipocytes", usageCount: 4, parentEntityId: "p", parentLabel: "3T3-L1", parentDescriptor: "mouse fibroblast line" }),
      ent({ entityId: "t2", label: "3T3-L1 preadipocytes", usageCount: 3, parentEntityId: "p", parentLabel: "3T3-L1", parentDescriptor: "mouse fibroblast line" }),
      ent({ entityId: "t3", label: "HEK293T cells", usageCount: 5 }), // top-level
    ];
    const nodes = groupCellLineDirectory(entities);
    expect(nodes).toHaveLength(2);
    // HEK293T (count 5) outranks the 3T3-L1 group (4+3=7)? group sum 7 > 5 → group first.
    expect(nodes[0].kind).toBe("group");
    const group = nodes[0] as Extract<(typeof nodes)[number], { kind: "group" }>;
    expect(group.parentLabel).toBe("3T3-L1");
    expect(group.parentDescriptor).toBe("mouse fibroblast line");
    expect(group.usageCount).toBe(7);
    expect(group.forms.map((f) => f.entityId)).toEqual(["t1", "t2"]);
    expect(nodes[1]).toEqual({ kind: "entity", entity: entities[2] });
  });

  it("degrades a single-form parent to a flat entity (nesting one row is noise)", () => {
    const entities = [
      ent({ entityId: "only", label: "MS1 cells", usageCount: 2, parentEntityId: "lonely", parentLabel: "MS1" }),
    ];
    const nodes = groupCellLineDirectory(entities);
    expect(nodes).toEqual([{ kind: "entity", entity: entities[0] }]);
  });

  it("ranks groups by summed usage against singletons, stable within ties", () => {
    const entities = [
      ent({ entityId: "a", label: "A1 x", usageCount: 1, parentEntityId: "pa", parentLabel: "A1" }),
      ent({ entityId: "b", label: "A1 y", usageCount: 1, parentEntityId: "pa", parentLabel: "A1" }), // group sum 2
      ent({ entityId: "c", label: "Solo", usageCount: 2 }), // ties the group at 2 → input order wins
    ];
    const nodes = groupCellLineDirectory(entities);
    expect(nodes.map((n) => (n.kind === "group" ? n.parentLabel : n.entity.label))).toEqual(["A1", "Solo"]);
  });

  it("returns [] for no entities", () => {
    expect(groupCellLineDirectory([])).toEqual([]);
  });
});
