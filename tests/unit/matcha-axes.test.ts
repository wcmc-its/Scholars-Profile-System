/**
 * Pure Stage-2 term clustering (design §5a). No db/network.
 *
 * The `dampedIdf` suite that used to sit here is gone with the function. It was a green
 * suite for a rarity axis nothing called — which is exactly what made the dead code
 * survive review. See `sponsor-match-contract.ts` (`weightFactor`).
 */
import { describe, expect, it } from "vitest";
import {
  mergeTermClusters,
  selectWithMethodFloor,
  type ClusterTerm,
} from "@/lib/api/matcha-axes";

describe("mergeTermClusters (§5a redundant-phrasing dedup)", () => {
  // "cancer, oncology, leukemia" — oncology ≈ cancer (same set), leukemia ⊂ cancer.
  const terms: ClusterTerm[] = [
    { term: "cancer", descendantUis: ["D009369", "D007938", "D001943"], centrality: 0.9, kind: "concept" },
    { term: "oncology", descendantUis: ["D009369", "D007938", "D001943"], centrality: 0.7, kind: "concept" },
    { term: "leukemia", descendantUis: ["D007938"], centrality: 0.8, kind: "concept" },
    { term: "immunotherapy", descendantUis: ["D007167"], centrality: 0.85, kind: "method" },
  ];

  it("merges equivalents/subsets into one cluster, keeps the distinct term separate", () => {
    const clusters = mergeTermClusters(terms, 0.6);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].members).toEqual(["cancer", "oncology", "leukemia"]);
    expect(clusters[1].members).toEqual(["immunotherapy"]);
  });

  it("unions the descriptor set and takes the max member centrality", () => {
    const [cancer] = mergeTermClusters(terms, 0.6);
    expect(new Set(cancer.descendantUis)).toEqual(new Set(["D009369", "D007938", "D001943"]));
    expect(cancer.centrality).toBe(0.9); // max(0.9, 0.7, 0.8)
  });

  // `kind` splits the rail's Concept and Method panels. The cluster takes its FIRST
  // member's kind — the same member that supplies the representative term it is displayed
  // under, so the panel and the label can never disagree.
  it("takes the kind of the first (representative) member", () => {
    const clusters = mergeTermClusters(terms, 0.6);
    expect(clusters[0].kind).toBe("concept"); // cancer/oncology/leukemia
    expect(clusters[1].kind).toBe("method"); // immunotherapy
  });

  it("keeps genuinely distinct concepts apart (no over-merge)", () => {
    const distinct: ClusterTerm[] = [
      { term: "a", descendantUis: ["D1", "D2"], centrality: 0.5, kind: "concept" },
      { term: "b", descendantUis: ["D3", "D4"], centrality: 0.5, kind: "concept" },
    ];
    expect(mergeTermClusters(distinct, 0.6)).toHaveLength(2);
  });

  it("respects the Jaccard threshold — partial overlap below τ stays split", () => {
    const partial: ClusterTerm[] = [
      { term: "a", descendantUis: ["D1", "D2", "D3", "D4"], centrality: 0.5, kind: "concept" },
      { term: "b", descendantUis: ["D4", "D5", "D6", "D7"], centrality: 0.5, kind: "concept" }, // Jaccard 1/7 ≈ 0.14
    ];
    expect(mergeTermClusters(partial, 0.6)).toHaveLength(2); // below τ
    expect(mergeTermClusters(partial, 0.1)).toHaveLength(1); // above τ
  });

  it("a term with no resolved descriptors never merges (passes through as a singleton)", () => {
    const withEmpty: ClusterTerm[] = [
      { term: "cancer", descendantUis: ["D009369"], centrality: 0.9, kind: "concept" },
      { term: "unresolvable", descendantUis: [], centrality: 0.9, kind: "concept" },
    ];
    const clusters = mergeTermClusters(withEmpty, 0.6);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.members.includes("unresolvable"))!.members).toEqual(["unresolvable"]);
  });
});

describe("selectWithMethodFloor (#1780 — reserve method slots inside the cap)", () => {
  type C = { term: string; kind: "concept" | "method"; centrality: number };
  const c = (term: string, kind: "concept" | "method", centrality: number): C => ({ term, kind, centrality });
  const OPTS = { max: 8, methodFloor: 3, methodThreshold: 0.35 };
  const kinds = (out: C[]) => out.map((x) => x.kind);

  it("rescues qualifying methods a plain top-8 cut would drop (disease-primary ask)", () => {
    // 8 concepts outrank the two methods, so the plain cut keeps zero methods.
    const input = [
      c("A", "concept", 1.0), c("B", "concept", 0.9), c("C", "concept", 0.8), c("D", "concept", 0.7),
      c("E", "concept", 0.6), c("F", "concept", 0.55), c("G", "concept", 0.5), c("H", "concept", 0.45),
      c("iPSC", "method", 0.4), c("PET", "method", 0.38),
    ];
    const out = selectWithMethodFloor(input, OPTS);
    expect(out).toHaveLength(8);
    expect(out.map((x) => x.term)).toContain("iPSC");
    expect(out.map((x) => x.term)).toContain("PET");
    // Displaced the two LOWEST concepts, never a method.
    expect(out.map((x) => x.term)).not.toContain("H"); // 0.45
    expect(out.map((x) => x.term)).not.toContain("G"); // 0.5
    expect(kinds(out).filter((k) => k === "method")).toHaveLength(2);
  });

  it("caps the reserve at methodFloor even when more methods qualify", () => {
    const input = [
      c("A", "concept", 1.0), c("B", "concept", 0.9), c("C", "concept", 0.8), c("D", "concept", 0.7),
      c("E", "concept", 0.6), c("F", "concept", 0.55), c("G", "concept", 0.5), c("H", "concept", 0.45),
      c("m1", "method", 0.4), c("m2", "method", 0.39), c("m3", "method", 0.38), c("m4", "method", 0.37),
    ];
    const out = selectWithMethodFloor(input, OPTS);
    expect(out).toHaveLength(8);
    expect(kinds(out).filter((k) => k === "method")).toHaveLength(3); // exactly the floor
    expect(out.map((x) => x.term)).not.toContain("m4"); // 4th method not forced in
  });

  it("is a no-op for a method-primary ask (methods already fill the cut)", () => {
    const input = [
      c("m1", "method", 0.95), c("m2", "method", 0.9), c("m3", "method", 0.8), c("m4", "method", 0.7),
      c("m5", "method", 0.6), c("x", "concept", 0.45), c("y", "concept", 0.4), c("z", "concept", 0.3),
      c("w", "concept", 0.25),
    ];
    const out = selectWithMethodFloor(input, OPTS);
    expect(out).toHaveLength(8);
    expect(kinds(out).filter((k) => k === "method")).toHaveLength(5); // all five kept, unchanged
  });

  it("does not reserve a method that fails the threshold", () => {
    const input = [
      c("A", "concept", 1.0), c("B", "concept", 0.9), c("C", "concept", 0.8), c("D", "concept", 0.7),
      c("E", "concept", 0.6), c("F", "concept", 0.55), c("G", "concept", 0.5), c("H", "concept", 0.45),
      c("weak", "method", 0.3), // below 0.35
    ];
    const out = selectWithMethodFloor(input, OPTS);
    expect(out).toHaveLength(8);
    expect(out.map((x) => x.term)).not.toContain("weak");
    expect(kinds(out).every((k) => k === "concept")).toBe(true);
  });

  it("sorts the survivors by centrality (fixes the model-order cut)", () => {
    const input = [
      c("A", "concept", 0.5), c("B", "concept", 1.0), c("C", "concept", 0.7),
    ];
    const out = selectWithMethodFloor(input, OPTS);
    expect(out.map((x) => x.term)).toEqual(["B", "C", "A"]);
  });
});
