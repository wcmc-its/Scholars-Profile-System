/**
 * Issue #259 / SPEC §5.4.2 — pure-helper tests for the descendant
 * precompute. Exercises `buildPrefixIndex`, `prefixLookup`, and
 * `computeDescendantUis` directly without the Prisma harness used by
 * `search-taxonomy.test.ts`.
 *
 * The dot-boundary trap (test #4) and the 200-cap (test #9) are the two
 * regressions most likely to bite a future refactor; both are locked
 * with explicit assertions.
 */
import { describe, it, expect } from "vitest";
import {
  buildPrefixIndex,
  prefixLookup,
  computeDescendantUis,
} from "@/lib/api/search-taxonomy";

type Row = {
  descriptorUi: string;
  name: string;
  entryTerms: string[];
  treeNumbers: string[];
  scopeNote: string | null;
  dateRevised: Date | null;
  localPubCoverage: number | null;
};

function row(descriptorUi: string, treeNumbers: string[]): Row {
  return {
    descriptorUi,
    name: descriptorUi,
    entryTerms: [],
    treeNumbers,
    scopeNote: null,
    dateRevised: null,
    localPubCoverage: null,
  };
}

describe("prefixLookup", () => {
  it("returns [] for an empty index", () => {
    expect(prefixLookup([], "C14")).toEqual([]);
  });

  it("returns [] when no entry has a matching prefix", () => {
    const idx = buildPrefixIndex([row("D_X", ["A.1"])]);
    expect(prefixLookup(idx, "C14")).toEqual([]);
  });

  it("returns [] for an empty needle (defensive)", () => {
    const idx = buildPrefixIndex([row("D_X", ["A.1"])]);
    expect(prefixLookup(idx, "")).toEqual([]);
  });

  it("respects dot-boundary — 'C14' does NOT match 'C140.x'", () => {
    const idx = buildPrefixIndex([
      row("D_CHILD_TRUE", ["C14.1"]),
      row("D_CHILD_FALSE", ["C140.x"]),
      row("D_DEEP", ["C14.2"]),
    ]);
    expect(prefixLookup(idx, "C14")).toEqual(["D_CHILD_TRUE", "D_DEEP"]);
  });

  it("returns descendants in sorted-tree-number order across branches", () => {
    const idx = buildPrefixIndex([
      row("D_A1", ["A.1"]),
      row("D_A2", ["A.2"]),
      row("D_B1", ["B.1"]),
    ]);
    expect(prefixLookup(idx, "A")).toEqual(["D_A1", "D_A2"]);
  });
});

describe("computeDescendantUis", () => {
  it("returns [self] when the descriptor has no children in the index", () => {
    const r = row("D_LEAF", ["C14.1"]);
    const idx = buildPrefixIndex([r]);
    expect(computeDescendantUis(r, idx)).toEqual(["D_LEAF"]);
  });

  it("returns [self, ...children] in sorted-tree-number order", () => {
    const parent = row("D_PARENT", ["C14"]);
    const c1 = row("D_C1", ["C14.1"]);
    const c2 = row("D_C2", ["C14.2"]);
    const idx = buildPrefixIndex([parent, c1, c2]);
    expect(computeDescendantUis(parent, idx)).toEqual([
      "D_PARENT",
      "D_C1",
      "D_C2",
    ]);
  });

  it("dedupes across multiple tree numbers (same descriptor reachable from two branches)", () => {
    // D_MULTI has two trees; D_SHARED has one tree under each branch's parent.
    // Without dedup the result would contain D_SHARED twice.
    const multi = row("D_MULTI", ["A.1", "B.1"]);
    const sharedUnderA = row("D_SHARED_A", ["A.1.1"]);
    const sharedUnderB = row("D_SHARED_B", ["B.1.1"]);
    const idx = buildPrefixIndex([multi, sharedUnderA, sharedUnderB]);
    const out = computeDescendantUis(multi, idx);
    expect(out[0]).toBe("D_MULTI");
    expect(out.slice(1).sort()).toEqual(["D_SHARED_A", "D_SHARED_B"]);
    expect(out.length).toBe(3);
  });

  it("dedupes when the same descriptor matches under two of its own tree numbers", () => {
    // Synthetic: D_PARENT has trees ["A.1", "A"]. A descendant at A.1.x is
    // reachable from both "A.1" and "A". Should appear only once in output.
    const parent = row("D_PARENT", ["A.1", "A"]);
    const grand = row("D_GRAND", ["A.1.1"]);
    const idx = buildPrefixIndex([parent, grand]);
    const out = computeDescendantUis(parent, idx);
    expect(out[0]).toBe("D_PARENT");
    expect(out.slice(1)).toEqual(["D_GRAND"]);
    expect(out.length).toBe(2);
  });

  it("caps at DESCENDANT_HARD_CAP=200 with self always at index 0", () => {
    const parent = row("D_ROOT", ["X"]);
    const children: Row[] = [];
    for (let i = 0; i < 250; i++) {
      children.push(row(`D_CHILD_${String(i).padStart(3, "0")}`, [`X.${i}`]));
    }
    const idx = buildPrefixIndex([parent, ...children]);
    const out = computeDescendantUis(parent, idx);
    expect(out.length).toBe(200);
    expect(out[0]).toBe("D_ROOT");
  });

  it("returns [self] when the descriptor has empty treeNumbers", () => {
    const r = row("D_NOTREES", []);
    const idx = buildPrefixIndex([r]);
    expect(computeDescendantUis(r, idx)).toEqual(["D_NOTREES"]);
  });
});
