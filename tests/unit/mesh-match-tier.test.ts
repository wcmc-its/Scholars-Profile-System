/**
 * Unit coverage for the MeSH match-tier ladder, including the `partial` tier added
 * by the decompose-and-resolve fallback (SEARCH_MESH_RESOLUTION_FALLBACK). The key
 * safety invariant: a `partial` (interpreted) match admits/attributes strictly
 * BENEATH every verbatim tier, so a fallback guess can never out-rank a real match.
 */
import { describe, it, expect } from "vitest";
import {
  meshMatchTier,
  meshConfidenceRank,
  MESH_RANK_VERBATIM,
  MESH_ADMIT_WEIGHT,
  MESH_ATTRIBUTION_WEIGHT,
} from "@/lib/search";

describe("meshMatchTier", () => {
  it("maps confidence → tier", () => {
    expect(meshMatchTier("exact", 0)).toBe("exact");
    expect(meshMatchTier("entry-term", 1)).toBe("anchored-entry");
    expect(meshMatchTier("entry-term", 0)).toBe("entry");
    expect(meshMatchTier("partial", 0)).toBe("partial");
    // anchors are irrelevant once the confidence is partial
    expect(meshMatchTier("partial", 5)).toBe("partial");
  });
});

describe("MESH weight ladders", () => {
  it("partial admits below every verbatim tier (the fallback-safety invariant)", () => {
    const w = MESH_ADMIT_WEIGHT;
    expect(w.partial).toBeLessThan(w.entry);
    expect(w.entry).toBeLessThan(w["anchored-entry"]);
    expect(w["anchored-entry"]).toBeLessThan(w.exact);
  });

  it("partial attributes below every verbatim tier", () => {
    const w = MESH_ATTRIBUTION_WEIGHT;
    expect(w.partial).toBeLessThan(w.entry);
    expect(w.entry).toBeLessThan(w["anchored-entry"]);
    expect(w["anchored-entry"]).toBeLessThan(w.exact);
  });
});

/**
 * #1972 — the #692 generic-strip retry is skipped when the full query already resolved.
 * `partial` (the window fallback's decompose-and-resolve guess) must NOT count as
 * resolved for that purpose, or turning SEARCH_MESH_RESOLUTION_FALLBACK on suppresses
 * the retry and DEMOTES queries whose stripped form resolves verbatim. Measured on
 * deployed staging: 3 of 35 free-typed queries demoted, e.g. `chronic fatigue` →
 * `Fatigue` at `exact` (fallback off) vs `partial` (fallback on).
 */
describe("meshConfidenceRank (#1972 — what may suppress the generic-strip retry)", () => {
  it("orders null < partial < entry-term < exact", () => {
    expect(meshConfidenceRank(null)).toBe(0);
    expect(meshConfidenceRank(undefined)).toBe(0);
    expect(meshConfidenceRank(null)).toBeLessThan(meshConfidenceRank("partial"));
    expect(meshConfidenceRank("partial")).toBeLessThan(meshConfidenceRank("entry-term"));
    expect(meshConfidenceRank("entry-term")).toBeLessThan(meshConfidenceRank("exact"));
  });

  it("a miss AND a partial fall below the verbatim threshold, so both retry", () => {
    expect(meshConfidenceRank(null)).toBeLessThan(MESH_RANK_VERBATIM);
    expect(meshConfidenceRank("partial")).toBeLessThan(MESH_RANK_VERBATIM);
  });

  it("a verbatim match does NOT retry (#692 §4.1 full-query-first stays intact)", () => {
    expect(meshConfidenceRank("entry-term")).toBeGreaterThanOrEqual(MESH_RANK_VERBATIM);
    expect(meshConfidenceRank("exact")).toBeGreaterThanOrEqual(MESH_RANK_VERBATIM);
  });
});
