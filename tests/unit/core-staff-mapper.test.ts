/**
 * Block 6b CORE#/STAFF_DICT -> core.staff_count + core.staff_tracked_count
 * record mapper.
 *
 * Two load-bearing properties here.
 *
 * ABSENT ≠ ZERO. Both columns are nullable with no default precisely so "the
 * engine has not published counts for this core" (NULL, no chip in the review
 * queue) stays distinguishable from "the facility dictionary lists no staff"
 * (0, and the queue says the co-author signal cannot fire). A mapper that
 * emitted a 0 write for a core it never saw an item for would be this repo's
 * standing failure mode — a fail-soft read on a path that WRITES is a wipe —
 * so the absent case must produce NO write at all, and the explicit-0 case
 * must produce a write of 0.
 *
 * THE TWO COUNTS TRAVEL TOGETHER. `staff_tracked_count` is what the co-author
 * signal actually matches on, and it is smaller than `staff_count` on most
 * live cores. A half-written row (listed known, tracked NULL) is the one state
 * the chip cannot render honestly, so an item missing the tracked count is
 * skipped outright rather than written as a listed count alone.
 *
 * Also covers: core_id resolved from PK or the scalar, the catalog FK guard,
 * numeric-string counts, malformed counts skipped rather than zeroed, the
 * tracked > listed incoherence guard, and last-item-wins on a duplicate core.
 */
import { describe, expect, it } from "vitest";
import { buildCoreStaffWrites, type CoreStaffRecordInput } from "@/etl/dynamodb/core-staff-mapper";

const SETS = { knownCoreIds: new Set(["2", "14"]) };

/** A record that clears every guard, with per-test overrides. */
function rec(over: Partial<CoreStaffRecordInput> = {}): CoreStaffRecordInput {
  return {
    PK: "CORE#2",
    SK: "STAFF_DICT",
    core_id: "2",
    staff_count: 7,
    staff_tracked_count: 4,
    ...over,
  };
}

describe("buildCoreStaffWrites (Block 6b mapper)", () => {
  it("maps a present item to a single write carrying BOTH counts", () => {
    const r = buildCoreStaffWrites([rec()], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 7, staffTrackedCount: 4 }]);
    expect(r.skippedMissingCore).toBe(0);
    expect(r.skippedUnknownCore).toBe(0);
    expect(r.skippedMissingCount).toBe(0);
    expect(r.skippedMissingTracked).toBe(0);
    expect(r.skippedIncoherent).toBe(0);
  });

  it("keeps the two counts DISTINCT — tracked is not derived from listed", () => {
    // Core 14, the one in the owner's mockup: the dictionary lists four staff
    // and the co-author signal can match exactly one of them. Anything that
    // collapsed these to a single number would put "draws on 4" on that chip.
    const r = buildCoreStaffWrites(
      [rec({ PK: "CORE#14", core_id: "14", staff_count: 4, staff_tracked_count: 1 })],
      SETS,
    );
    expect(r.writes).toEqual([{ coreId: "14", staffCount: 4, staffTrackedCount: 1 }]);
  });

  // --- the absent-item trap, both halves ---------------------------------

  it("ABSENT: a core with no STAFF_DICT item produces NO write — never a 0", () => {
    // Core 14 is in the catalog but the engine emitted nothing for it. The
    // result must not mention it at all, so index.ts updates only core 2 and
    // core 14's columns keep whatever they had (NULL, or real earlier counts).
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
      skippedMissingTracked: 0,
      skippedIncoherent: 0,
    });
  });

  it("EXPLICIT ZERO: staff_count 0 IS written as 0, not dropped as falsy", () => {
    // The other half of the trap. `if (!staff_count)` would swallow this, and
    // "the dictionary lists no core staff" is the most useful thing a reviewer
    // can learn about such a core.
    const r = buildCoreStaffWrites([rec({ staff_count: 0, staff_tracked_count: 0 })], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 0, staffTrackedCount: 0 }]);
    expect(r.skippedMissingCount).toBe(0);
    expect(r.skippedMissingTracked).toBe(0);
  });

  it("EXPLICIT ZERO on the TRACKED count alone IS written — listed staff, none matchable", () => {
    // Cores 8, 10 and 13 are in exactly this state on the live dictionary. It
    // is a real, published fact and the queue has a sentence for it; dropping
    // it as falsy would leave those chips claiming the listed count instead.
    const r = buildCoreStaffWrites([rec({ staff_count: 3, staff_tracked_count: 0 })], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 3, staffTrackedCount: 0 }]);
    expect(r.skippedMissingTracked).toBe(0);
  });

  it("tells the two apart in ONE run: 0 for the core with an item, silence for the one without", () => {
    // The single assertion that proves the distinction end to end.
    const zero = rec({ PK: "CORE#14", core_id: "14", staff_count: 0, staff_tracked_count: 0 });
    const r = buildCoreStaffWrites([zero], SETS);
    expect(r.writes).toEqual([{ coreId: "14", staffCount: 0, staffTrackedCount: 0 }]);
    // core 2 is equally in the catalog and equally unmentioned by this run
    expect(r.writes.find((w) => w.coreId === "2")).toBeUndefined();
  });

  // --- the two counts are all-or-nothing ---------------------------------

  it("skips an item carrying a listed count but NO tracked count — never half-writes", () => {
    // A row of (staff_count = 7, staff_tracked_count = NULL) is the one state
    // the chip cannot render honestly: it can neither claim the signal draws on
    // 7 nor claim it cannot fire. Skipping leaves both columns alone and the
    // chip invisible, which is the fail-safe direction.
    const r = buildCoreStaffWrites([rec({ staff_tracked_count: undefined })], SETS);
    expect(r.writes).toEqual([]);
    expect(r.skippedMissingTracked).toBe(1);
    expect(r.skippedMissingCount).toBe(0);
  });

  it("skips an item whose tracked count EXCEEDS its listed count", () => {
    // The dictionary cannot track staff it does not list; rendering "7 of 4
    // core staff" would be a visible lie about a number under review.
    const r = buildCoreStaffWrites([rec({ staff_count: 4, staff_tracked_count: 7 })], SETS);
    expect(r.writes).toEqual([]);
    expect(r.skippedIncoherent).toBe(1);
  });

  it("allows tracked === listed (every listed staff member resolves)", () => {
    const r = buildCoreStaffWrites([rec({ staff_count: 4, staff_tracked_count: 4 })], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 4, staffTrackedCount: 4 }]);
    expect(r.skippedIncoherent).toBe(0);
  });

  // --- parsing + guards ---------------------------------------------------

  it("resolves core_id from the PK when the scalar is absent", () => {
    const r = buildCoreStaffWrites(
      [{ PK: "CORE#14", SK: "STAFF_DICT", staff_count: 7, staff_tracked_count: 2 }],
      SETS,
    );
    expect(r.writes).toEqual([{ coreId: "14", staffCount: 7, staffTrackedCount: 2 }]);
  });

  it("falls back to the core_id scalar when the PK carries no id", () => {
    const r = buildCoreStaffWrites(
      [{ PK: "CORE#", SK: "STAFF_DICT", core_id: "2", staff_count: 1, staff_tracked_count: 1 }],
      SETS,
    );
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 1, staffTrackedCount: 1 }]);
  });

  it("skips an item whose core id cannot be resolved at all", () => {
    const r = buildCoreStaffWrites(
      [{ PK: "CORE#", SK: "STAFF_DICT", staff_count: 3, staff_tracked_count: 1 }],
      SETS,
    );
    expect(r.writes).toEqual([]);
    expect(r.skippedMissingCore).toBe(1);
  });

  it("skips a core absent from the seeded catalog (FK guard)", () => {
    const r = buildCoreStaffWrites([rec({ PK: "CORE#999", core_id: "999" })], SETS);
    expect(r.writes).toEqual([]);
    expect(r.skippedUnknownCore).toBe(1);
  });

  it("accepts numeric string counts on BOTH attributes (hand-written S attributes)", () => {
    const r = buildCoreStaffWrites([rec({ staff_count: "12", staff_tracked_count: "5" })], SETS);
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 12, staffTrackedCount: 5 }]);
  });

  const MALFORMED = [
    ["absent", undefined],
    ["empty string", ""],
    ["non-numeric", "many"],
    ["negative", -1],
    ["fractional", 2.5],
    ["NaN", Number.NaN],
  ] as Array<[string, CoreStaffRecordInput["staff_count"]]>;

  it.each(MALFORMED)(
    "skips a %s staff_count rather than writing 0 over a real roster",
    (_label, staff_count) => {
      const r = buildCoreStaffWrites([rec({ staff_count })], SETS);
      expect(r.writes).toEqual([]);
      expect(r.skippedMissingCount).toBe(1);
    },
  );

  it.each(MALFORMED)(
    "skips a %s staff_tracked_count rather than writing 0 over a real tracked count",
    (_label, staff_tracked_count) => {
      const r = buildCoreStaffWrites([rec({ staff_tracked_count })], SETS);
      expect(r.writes).toEqual([]);
      expect(r.skippedMissingTracked).toBe(1);
    },
  );

  it("takes the LAST item for a duplicated core id (last-write-wins, as an upsert loop would)", () => {
    const r = buildCoreStaffWrites(
      [
        rec({ staff_count: 4, staff_tracked_count: 4 }),
        rec({ staff_count: 9, staff_tracked_count: 2 }),
      ],
      SETS,
    );
    expect(r.writes).toEqual([{ coreId: "2", staffCount: 9, staffTrackedCount: 2 }]);
  });

  it("fail-isolates: one malformed item does not stop the others landing", () => {
    const r = buildCoreStaffWrites(
      [
        rec({ staff_count: "junk" }),
        rec({ PK: "CORE#14", core_id: "14", staff_count: 3, staff_tracked_count: 1 }),
      ],
      SETS,
    );
    expect(r.writes).toEqual([{ coreId: "14", staffCount: 3, staffTrackedCount: 1 }]);
    expect(r.skippedMissingCount).toBe(1);
  });
});
