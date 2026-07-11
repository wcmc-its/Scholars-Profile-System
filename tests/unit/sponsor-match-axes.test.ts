/**
 * Pure Stage-2 axis helpers (design §5a rarity + §6 cluster dedup). No db/network.
 */
import { describe, expect, it } from "vitest";
import { dampedIdf, mergeTermClusters } from "@/lib/api/sponsor-match-axes";

describe("dampedIdf (§6 rarity)", () => {
  it("rewards rarity — a rarer concept scores higher (Munchausen > Cancer)", () => {
    expect(dampedIdf(0.0005, 10)).toBeGreaterThan(dampedIdf(0.4, 10)); // Munchausen vs Cancer
  });

  it("caps so a 1-in-corpus concept can't dominate", () => {
    expect(dampedIdf(1e-9, 2)).toBe(2); // -ln(1e-9)=20.7 → capped to 2
  });

  it("ubiquitous concept (coverage ≥ 1) contributes no rarity", () => {
    expect(dampedIdf(1, 10)).toBe(0);
    expect(dampedIdf(1.5, 10)).toBe(0);
  });

  it("missing / non-positive coverage ⇒ maximally rare (cap), never NaN", () => {
    expect(dampedIdf(0, 5)).toBe(5);
    expect(dampedIdf(-1, 5)).toBe(5);
    expect(dampedIdf(Number.NaN, 5)).toBe(5);
  });
});

describe("mergeTermClusters (§5a redundant-phrasing dedup)", () => {
  // "cancer, oncology, leukemia" — oncology ≈ cancer (same set), leukemia ⊂ cancer.
  const terms = [
    { term: "cancer", descendantUis: ["D009369", "D007938", "D001943"], centrality: 0.9 },
    { term: "oncology", descendantUis: ["D009369", "D007938", "D001943"], centrality: 0.7 },
    { term: "leukemia", descendantUis: ["D007938"], centrality: 0.8 },
    { term: "immunotherapy", descendantUis: ["D007167"], centrality: 0.85 },
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

  it("keeps genuinely distinct concepts apart (no over-merge)", () => {
    const distinct = [
      { term: "a", descendantUis: ["D1", "D2"], centrality: 0.5 },
      { term: "b", descendantUis: ["D3", "D4"], centrality: 0.5 },
    ];
    expect(mergeTermClusters(distinct, 0.6)).toHaveLength(2);
  });

  it("respects the Jaccard threshold — partial overlap below τ stays split", () => {
    const partial = [
      { term: "a", descendantUis: ["D1", "D2", "D3", "D4"], centrality: 0.5 },
      { term: "b", descendantUis: ["D4", "D5", "D6", "D7"], centrality: 0.5 }, // Jaccard 1/7 ≈ 0.14
    ];
    expect(mergeTermClusters(partial, 0.6)).toHaveLength(2); // below τ
    expect(mergeTermClusters(partial, 0.1)).toHaveLength(1); // above τ
  });

  it("a term with no resolved descriptors never merges (passes through as a singleton)", () => {
    const withEmpty = [
      { term: "cancer", descendantUis: ["D009369"], centrality: 0.9 },
      { term: "unresolvable", descendantUis: [], centrality: 0.9 },
    ];
    const clusters = mergeTermClusters(withEmpty, 0.6);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.members.includes("unresolvable"))!.members).toEqual(["unresolvable"]);
  });
});
