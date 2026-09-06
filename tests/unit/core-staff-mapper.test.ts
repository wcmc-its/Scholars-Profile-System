/**
 * Block 6b CORE#/STAFF -> core.staff_count record mapper.
 *
 * The load-bearing property here is ABSENT ≠ ZERO. `core.staff_count` is
 * nullable with no default precisely so "the engine has not published a count
 * for this core" (NULL, no chip in the review queue) stays distinguishable
 * from "the facility dictionary lists no staff" (0, and the queue says signal
 * 2 cannot fire). A mapper that emitted a 0 write for a core it never saw an
 * item for would be this repo's standing failure mode — a fail-soft read on a
 * path that WRITES is a wipe — so the absent case must produce NO write at
 * all, and the explicit-0 case must produce a write of 0.
 *
 * Also covers: core_id resolved from PK or the scalar, the catalog FK guard,
 * numeric-string counts, malformed counts skipped rather than zeroed, and
 * last-item-wins on a duplicate core.
 */
import { describe, expect, it } from "vitest";
import { buildCoreStaffWrites, type CoreStaffRecordInput } from "@/etl/dynamodb/core-staff-mapper";

const SETS = { knownCoreIds: new Set(["2", "14"]) };

/** A record that clears every guard, with per-test overrides. */
function rec(over: Partial<CoreStaffRecordInput> = {}): CoreStaffRecordInput {
  return { PK: "CORE#2", SK: "STAFF", core_id: "2", staff_count: 4, ...over };
}

describe("buildCoreStaffWrites (Block 6b mapper)", () => {
  it("maps a present item to a single write carrying its count", () => {
    const r = buildCoreStaffWrites([rec()], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 4 }]);
    expect(r.skippedMissingCore).toBe(0);
    expect(r.skippedUnknownCore).toBe(0);
    expect(r.skippedMissingCount).toBe(0);
  });

  // --- the absent-item trap, both halves ---------------------------------

  it("ABSENT: a core with no STAFF item produces NO write — never a 0", () => {
    // Core 14 is in the catalog but the engine emitted nothing for it. The
    // result must not mention it at all, so index.ts updates only core 2 and
    // core 14's column keeps whatever it had (NULL, or a real earlier count).
    const r = buildCoreStaffWrites([rec({ PK: "CORE#2", core_id: "2" })], SETS);
    expect(r.writes.map((w) => w.coreId)).toEqual(["2"]);
    expect(r.writes.some((w) => w.coreId === "14")).toBe(false);
  });

  it("EMPTY RUN: no items at all produces no writes — a quiet producer wipes nothing", () => {
    const r = buildCoreStaffWrites([], SETS);
    expect(r.writes).toEqual([]);
    expect(r).toMatchObject({
      skippedMissingCore: 0,
      skippedUnknownCore: 0,
      skippedMissingCount: 0,
    });
  });

  it("EXPLICIT ZERO: staff_count 0 IS written as 0, not dropped as falsy", () => {
    // The other half of the trap. `if (!staff_count)` would swallow this, and
    // "the dictionary lists no core staff" is the most useful thing a reviewer
    // can learn about such a core.
    const r = buildCoreStaffWrites([rec({ staff_count: 0 })], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 0 }]);
    expect(r.skippedMissingCount).toBe(0);
  });

  it("tells the two apart in ONE run: 0 for the core with an item, silence for the one without", () => {
    // The single assertion that proves the distinction end to end.
    const zero = rec({ PK: "CORE#14", core_id: "14", staff_count: 0 });
    const r = buildCoreStaffWrites([zero], SETS);
    expect(r.writes).toEqual([{ coreId: "14", staffCount: 0 }]);
    // core 2 is equally in the catalog and equally unmentioned by this run
    expect(r.writes.find((w) => w.coreId === "2")).toBeUndefined();
  });

  // --- parsing + guards ---------------------------------------------------

  it("resolves core_id from the PK when the scalar is absent", () => {
    const r = buildCoreStaffWrites([{ PK: "CORE#14", SK: "STAFF", staff_count: 7 }], SETS);
    expect(r.writes).toEqual([{ coreId: "14", staffCount: 7 }]);
  });

  it("falls back to the core_id scalar when the PK carries no id", () => {
    const r = buildCoreStaffWrites(
      [{ PK: "CORE#", SK: "STAFF", core_id: "2", staff_count: 1 }],
      SETS,
    );
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 1 }]);
  });

  it("skips an item whose core id cannot be resolved at all", () => {
    const r = buildCoreStaffWrites([{ PK: "CORE#", SK: "STAFF", staff_count: 3 }], SETS);
    expect(r.writes).toEqual([]);
    expect(r.skippedMissingCore).toBe(1);
  });

  it("skips a core absent from the seeded catalog (FK guard)", () => {
    const r = buildCoreStaffWrites([rec({ PK: "CORE#999", core_id: "999" })], SETS);
    expect(r.writes).toEqual([]);
    expect(r.skippedUnknownCore).toBe(1);
  });

  it("accepts a numeric string count (a hand-written S attribute)", () => {
    const r = buildCoreStaffWrites([rec({ staff_count: "12" })], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 12 }]);
  });

  it.each([
    ["absent", undefined],
    ["empty string", ""],
    ["non-numeric", "many"],
    ["negative", -1],
    ["fractional", 2.5],
    ["NaN", Number.NaN],
  ] as Array<[string, CoreStaffRecordInput["staff_count"]]>)(
    "skips a %s count rather than writing 0 over a real roster",
    (_label, staff_count) => {
      const r = buildCoreStaffWrites([rec({ staff_count })], SETS);
      expect(r.writes).toEqual([]);
      expect(r.skippedMissingCount).toBe(1);
    },
  );

  it("takes the LAST item for a duplicated core id (last-write-wins, as an upsert loop would)", () => {
    const r = buildCoreStaffWrites([rec({ staff_count: 4 }), rec({ staff_count: 9 })], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 9 }]);
  });

  it("fail-isolates: one malformed item does not stop the others landing", () => {
    const r = buildCoreStaffWrites(
      [rec({ staff_count: "junk" }), rec({ PK: "CORE#14", core_id: "14", staff_count: 3 })],
      SETS,
    );
    expect(r.writes).toEqual([{ coreId: "14", staffCount: 3 }]);
    expect(r.skippedMissingCount).toBe(1);
  });
});
