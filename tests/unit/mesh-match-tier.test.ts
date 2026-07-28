/**
 * Unit coverage for the MeSH match-tier ladder, including the `partial` tier added
 * by the decompose-and-resolve fallback (SEARCH_MESH_RESOLUTION_FALLBACK). The key
 * safety invariant: a `partial` (interpreted) match admits/attributes strictly
 * BENEATH every verbatim tier, so a fallback guess can never out-rank a real match.
 *
 * Also covers entry-term tier parity (SEARCH_MESH_ENTRY_TIER_PARITY): a FULL-QUERY
 * entry-term hit is a verbatim match and earns the `exact` tier, so two spellings of
 * one descriptor stop scoring differently — while a partial-coverage entry-term hit
 * (the #692 generic-strip retry) does not.
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
import { isFullQueryMeshMatch } from "@/lib/api/normalize";

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

/**
 * Entry-term tier parity (`SEARCH_MESH_ENTRY_TIER_PARITY`) — measured on prod
 * 2026-07-27:
 * `gene therapy` and `genetic therapy` resolve to the SAME descriptor (`Genetic
 * Therapy`, D015316) and score differently — entry-term (attribution 1.15 / admit
 * 0.03, 921 scholars) vs exact (1.5 / 0.1, 848 scholars), only 2 of the top 6
 * scholars in common. When the user's WHOLE query IS the entry term, the match is
 * verbatim and must earn the verbatim tier.
 *
 * 🔴 These explicit mappings are the ONLY coverage of the promotion. The "MESH weight
 * ladders" suite below asserts weight ORDER (partial < entry < anchored-entry < exact),
 * which is untouched by a tier PROMOTION — it would stay green if `fullQueryMatch` were
 * dropped on the floor, or wired backwards. Order tests cannot catch this class of bug.
 */
describe("meshMatchTier — entry-term tier parity", () => {
  it("promotes a FULL-QUERY entry-term match to the exact tier", () => {
    expect(meshMatchTier("entry-term", 0, { fullQueryMatch: true })).toBe("exact");
  });

  it("leaves a non-full-query entry-term match on the floor tier", () => {
    // The #692 generic-strip retry arm: entry-term, but resolved from the STRIPPED
    // query, so it covers only part of what the user typed.
    expect(meshMatchTier("entry-term", 0, { fullQueryMatch: false })).toBe("entry");
  });

  it("ignores anchorCount once the query matched in full", () => {
    // The defect was that a curated anchor — a fact about human curation, not about the
    // match — decided the weight. Full-query parity has to override it, not tie-break.
    expect(meshMatchTier("entry-term", 2, { fullQueryMatch: true })).toBe("exact");
  });

  it("keeps `anchored-entry` reachable — it is NOT dead code", () => {
    // Flag-off (opts omitted) and the retry-derived case both land here.
    expect(meshMatchTier("entry-term", 2)).toBe("anchored-entry");
  });

  it("never promotes a `partial` — an interpretation is not a verbatim match", () => {
    // The window fallback and the #1342 singularize retry both stamp `partial`; if either
    // could be promoted, a decompose-and-resolve GUESS would attribute like a real match.
    expect(meshMatchTier("partial", 0, { fullQueryMatch: true })).toBe("partial");
    expect(meshMatchTier("partial", 5, { fullQueryMatch: true })).toBe("partial");
  });
});

/**
 * The predicate the four call sites (`/api/search`, the SSR search page, the Matcha
 * spine, the Recall@3 dryrun) feed into `fullQueryMatch`. It is factored into one helper
 * precisely so those four cannot drift — a divergence between the route and the SSR page
 * is the badge-count ≠ result-list class of bug.
 */
describe("isFullQueryMeshMatch (what may be promoted)", () => {
  it("matches when query and matched form agree AFTER normalization", () => {
    expect(isFullQueryMeshMatch("gene therapy", "Gene Therapy")).toBe(true);
    expect(isFullQueryMeshMatch("  Genetic Therapy  ", "Genetic Therapy")).toBe(true);
    // normalizeForMatch strips punctuation and the connector "and"
    expect(isFullQueryMeshMatch("cardio-oncology", "Cardio Oncology")).toBe(true);
  });

  it("REJECTS a stripped/subset query — the #692 retry must not be promoted", () => {
    // `contentQuery` is a token SUBSET of what the user typed. Comparing against it
    // instead of the user's query is exactly what would manufacture verbatim confidence.
    expect(isFullQueryMeshMatch("gene therapy research", "gene therapy")).toBe(false);
    expect(isFullQueryMeshMatch("pediatric asthma", "Asthma")).toBe(false);
  });

  it("REJECTS a different concept, and never reads empty as parity", () => {
    expect(isFullQueryMeshMatch("gene therapy", "Genetics")).toBe(false);
    // The resolver has a 3-char floor, so a query normalizing to "" resolved nothing;
    // `"" === ""` must not read as a full-query match.
    expect(isFullQueryMeshMatch("", "")).toBe(false);
    expect(isFullQueryMeshMatch("   ", "")).toBe(false);
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
