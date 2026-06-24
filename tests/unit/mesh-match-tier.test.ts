/**
 * Unit coverage for the MeSH match-tier ladder, including the `partial` tier added
 * by the decompose-and-resolve fallback (SEARCH_MESH_RESOLUTION_FALLBACK). The key
 * safety invariant: a `partial` (interpreted) match admits/attributes strictly
 * BENEATH every verbatim tier, so a fallback guess can never out-rank a real match.
 */
import { describe, it, expect } from "vitest";
import {
  meshMatchTier,
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
