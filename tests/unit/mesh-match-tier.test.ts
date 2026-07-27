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
  meshRetryIsSameDescriptorUpgrade,
  MESH_RANK_VERBATIM,
  MESH_ADMIT_WEIGHT,
  MESH_ATTRIBUTION_WEIGHT,
} from "@/lib/search";
import { isAllDeprioritized } from "@/lib/api/deprioritized-terms";

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

/**
 * #1972 — what the retry may DO once it has run. Fixtures are the real
 * descriptors measured on deployed staging (2026-07-26, 122 `<topic> <generic
 * modifier>` queries): letting the retry replace the concept produced 9
 * regressions, all of them a specific descriptor losing to a broad or
 * wrong-domain one. Confidence-only upgrades were the other 49 and were all good.
 */
describe("meshRetryIsSameDescriptorUpgrade (#1972 — a retry may not swap the concept)", () => {
  const stemCells = { descriptorUi: "D013234", confidence: "partial" as const };
  // "stem cells effects" strips BOTH `cells` and `effects` → "stem".
  const stemMicroscopy = { descriptorUi: "D018112", confidence: "entry-term" as const };
  const kidneyDiseases = { descriptorUi: "D007674", confidence: "partial" as const };
  const kidneyOrgan = { descriptorUi: "D007668", confidence: "exact" as const };
  const asthmaPartial = { descriptorUi: "D001249", confidence: "partial" as const };
  const asthmaExact = { descriptorUi: "D001249", confidence: "exact" as const };

  it("ACCEPTS a same-descriptor confidence upgrade (the 49 wins)", () => {
    expect(meshRetryIsSameDescriptorUpgrade(asthmaPartial, asthmaExact)).toBe(true);
  });

  it("REJECTS a concept swap even when the retry is more confident (the 9 regressions)", () => {
    expect(meshRetryIsSameDescriptorUpgrade(stemCells, stemMicroscopy)).toBe(false);
    expect(meshRetryIsSameDescriptorUpgrade(kidneyDiseases, kidneyOrgan)).toBe(false);
  });

  it("REJECTS a sideways or weaker retry on the same descriptor", () => {
    expect(meshRetryIsSameDescriptorUpgrade(asthmaExact, asthmaPartial)).toBe(false);
    expect(meshRetryIsSameDescriptorUpgrade(asthmaPartial, asthmaPartial)).toBe(false);
  });

  /**
   * The rule above is only safe because callers gate it on the matched WINDOW holding
   * real content. `cancer research` resolves `Research`/partial (the size-1 window arm
   * needs an exact descriptor NAME, so the entry-term `cancer` is skipped and the filler
   * `research` wins). Descriptor-equality alone would block the retry that recovers
   * `Neoplasms` — so these two must disagree, and `isAllDeprioritized` is what separates
   * them. Verified live on staging with the retry neutralised (`<q> zzzqqx`).
   */
  it("is NOT sufficient on its own — the filler-window case must bypass it", () => {
    const research = { descriptorUi: "D012106", confidence: "partial" as const };
    const neoplasms = { descriptorUi: "D009369", confidence: "entry-term" as const };
    expect(meshRetryIsSameDescriptorUpgrade(research, neoplasms)).toBe(false);
    // ...so the caller MUST take the other arm for this query, or `cancer research`
    // regresses from Neoplasms to Research.
    expect(isAllDeprioritized("research")).toBe(true);
    expect(isAllDeprioritized("safety")).toBe(true);
    expect(isAllDeprioritized("prevalence")).toBe(true);
    // The 9 measured regressions keep their protection — each window has a content token.
    expect(isAllDeprioritized("stem cells")).toBe(false);
    expect(isAllDeprioritized("kidney disease")).toBe(false);
    expect(isAllDeprioritized("health policy")).toBe(false);
  });

  it("REJECTS when either side is absent — the null arm is the CALLER's decision", () => {
    // Callers keep pre-#1972 behavior when the full query resolved nothing, so this
    // helper must never be the thing that green-lights a first resolution.
    expect(meshRetryIsSameDescriptorUpgrade(null, asthmaExact)).toBe(false);
    expect(meshRetryIsSameDescriptorUpgrade(asthmaPartial, null)).toBe(false);
    expect(meshRetryIsSameDescriptorUpgrade(undefined, undefined)).toBe(false);
  });
});
