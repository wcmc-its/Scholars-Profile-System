/**
 * Shared MeSH tree-number ANCESTOR helper (search reason-from-doc, commit 1).
 *
 * The reverse of `computeDescendants`: given a descriptor's tree numbers, find
 * the descriptors whose tree numbers PREFIX them (the concepts whose subtree
 * contains it), self-inclusive. Both the query resolver and the people-doc ETL
 * builder rely on this, so the prefix semantics are pinned here.
 */
import { describe, it, expect } from "vitest";

import {
  buildMeshAncestorIndex,
  treeNumberPrefixes,
  ancestorUisFor,
} from "@/lib/mesh-tree-ancestors";

describe("treeNumberPrefixes", () => {
  it("returns dot-segment prefixes longest-to-shortest, self-inclusive", () => {
    expect(treeNumberPrefixes("C04.557.470")).toEqual(["C04.557.470", "C04.557", "C04"]);
  });

  it("returns just the tree number for a single segment", () => {
    expect(treeNumberPrefixes("C04")).toEqual(["C04"]);
  });
});

describe("ancestorUisFor", () => {
  // A small slice of a real MeSH-shaped tree:
  //   C04            Neoplasms                       (Dneo)
  //   C04.557        Neoplasms by Histologic Type    (Dhist)
  //   C04.557.470    Neoplasms, Glandular ...        (Dgland)
  //   C04.557.470.200  Adenocarcinoma                (Dadeno)  <- leaf
  // Plus an UNRELATED branch that must NOT leak in:
  //   C20            Immune System Diseases          (Dimmune)
  const rows = [
    { ui: "Dneo", treeNumbers: ["C04"] },
    { ui: "Dhist", treeNumbers: ["C04.557"] },
    { ui: "Dgland", treeNumbers: ["C04.557.470"] },
    { ui: "Dadeno", treeNumbers: ["C04.557.470.200"] },
    { ui: "Dimmune", treeNumbers: ["C20"] },
  ];
  const index = buildMeshAncestorIndex(rows);

  it("maps a leaf descriptor to its full ancestor chain (self first)", () => {
    const got = ancestorUisFor(index, "Dadeno", ["C04.557.470.200"]);
    expect(got[0]).toBe("Dadeno"); // self leads, mirrors computeDescendants
    expect(new Set(got)).toEqual(new Set(["Dadeno", "Dgland", "Dhist", "Dneo"]));
  });

  it("does not leak descriptors from a sibling/unrelated branch", () => {
    const got = ancestorUisFor(index, "Dadeno", ["C04.557.470.200"]);
    expect(got).not.toContain("Dimmune");
  });

  it("dedupes a descriptor reachable via two of the input's tree numbers", () => {
    // A descriptor cross-classified under two children of the SAME ancestor →
    // that ancestor must appear once.
    const got = ancestorUisFor(index, "Dx", ["C04.557.470.200", "C04.557"]);
    // C04.557 (Dhist) is an ancestor via BOTH inputs; count it once. Dadeno owns
    // C04.557.470.200, so it's an ancestor concept of Dx too.
    expect(got.filter((u) => u === "Dhist")).toHaveLength(1);
    expect(new Set(got)).toEqual(new Set(["Dx", "Dadeno", "Dgland", "Dhist", "Dneo"]));
  });

  it("returns self only when the descriptor has no tree numbers", () => {
    expect(ancestorUisFor(index, "Dorphan", [])).toEqual(["Dorphan"]);
  });
});
