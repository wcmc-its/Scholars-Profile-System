import { describe, it, expect } from "vitest";

import { classifyByExternalId } from "@/lib/etl/reconcile";

type Row = { externalId: string; name: string };

const contentKey = (r: Row) => r.name;

describe("classifyByExternalId", () => {
  it("classifies rows absent from existing as toCreate", () => {
    const plan = classifyByExternalId({
      incoming: [{ externalId: "A", name: "alpha" }],
      existing: [],
      contentKey,
    });
    expect(plan.toCreate.map((r) => r.externalId)).toEqual(["A"]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.staleExternalIds).toEqual([]);
    expect(plan.duplicateExternalIds).toEqual([]);
  });

  it("classifies rows whose contentKey changed as toUpdate", () => {
    const plan = classifyByExternalId({
      incoming: [{ externalId: "A", name: "alpha-v2" }],
      existing: [{ externalId: "A", name: "alpha-v1" }],
      contentKey,
    });
    expect(plan.toUpdate.map((r) => r.name)).toEqual(["alpha-v2"]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.staleExternalIds).toEqual([]);
  });

  it("skips rows whose contentKey is unchanged", () => {
    const plan = classifyByExternalId({
      incoming: [{ externalId: "A", name: "same" }],
      existing: [{ externalId: "A", name: "same" }],
      contentKey,
    });
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.staleExternalIds).toEqual([]);
  });

  it("classifies existing rows absent from incoming as stale", () => {
    const plan = classifyByExternalId({
      incoming: [],
      existing: [
        { externalId: "A", name: "alpha" },
        { externalId: "B", name: "beta" },
      ],
      contentKey,
    });
    expect([...plan.staleExternalIds].sort()).toEqual(["A", "B"]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
  });

  it("handles create + update + skip + stale together", () => {
    const plan = classifyByExternalId({
      incoming: [
        { externalId: "keep", name: "unchanged" },
        { externalId: "change", name: "new-content" },
        { externalId: "fresh", name: "brand-new" },
      ],
      existing: [
        { externalId: "keep", name: "unchanged" },
        { externalId: "change", name: "old-content" },
        { externalId: "gone", name: "removed" },
      ],
      contentKey,
    });
    expect(plan.toCreate.map((r) => r.externalId)).toEqual(["fresh"]);
    expect(plan.toUpdate.map((r) => r.externalId)).toEqual(["change"]);
    expect(plan.staleExternalIds).toEqual(["gone"]);
  });

  it("dedupes duplicate incoming externalIds (last wins) and reports them", () => {
    const plan = classifyByExternalId({
      incoming: [
        { externalId: "dup", name: "first" },
        { externalId: "dup", name: "last" },
        { externalId: "uniq", name: "only" },
      ],
      existing: [],
      contentKey,
    });
    expect(plan.duplicateExternalIds).toEqual(["dup"]);
    expect(plan.toCreate).toHaveLength(2);
    expect(plan.toCreate.find((r) => r.externalId === "dup")?.name).toBe("last");
  });

  it("uses the last duplicate occurrence for the create-vs-update decision", () => {
    const plan = classifyByExternalId({
      incoming: [
        { externalId: "A", name: "stale-dup" },
        { externalId: "A", name: "matches-existing" },
      ],
      existing: [{ externalId: "A", name: "matches-existing" }],
      contentKey,
    });
    expect(plan.duplicateExternalIds).toEqual(["A"]);
    expect(plan.toCreate).toEqual([]);
    // last occurrence equals existing content → skipped, not updated
    expect(plan.toUpdate).toEqual([]);
  });

  it("is independent of incoming/existing row order", () => {
    const plan = classifyByExternalId({
      incoming: [
        { externalId: "B", name: "b" },
        { externalId: "A", name: "a" },
      ],
      existing: [
        { externalId: "A", name: "a" },
        { externalId: "B", name: "b" },
      ],
      contentKey,
    });
    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.staleExternalIds).toEqual([]);
  });
});
