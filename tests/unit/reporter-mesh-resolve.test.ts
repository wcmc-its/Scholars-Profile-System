import { describe, expect, it } from "vitest";
import {
  MESH_RESOLVE_STOPWORDS,
  resolveGrantKeywords,
} from "@/etl/reporter/mesh";
import { normalizeForMatch, type MeshResolution } from "@/lib/api/search-taxonomy";

/** Minimal MeshResolution for a descriptor UI — only `descriptorUi` is read
 *  by `resolveGrantKeywords`; the rest satisfy the type. */
function resolution(descriptorUi: string): MeshResolution {
  return {
    descriptorUi,
    name: descriptorUi,
    matchedForm: descriptorUi,
    confidence: "exact",
    scopeNote: null,
    entryTerms: [],
    curatedTopicAnchors: [],
    descendantUis: [descriptorUi],
  };
}

/** Stub resolver keyed on the *normalized* form (what `resolveGrantKeywords`
 *  passes in); any term not in the map is unresolved. */
function stubResolver(map: Record<string, string>) {
  return async (term: string): Promise<MeshResolution | null> => {
    const ui = map[term];
    return ui ? resolution(ui) : null;
  };
}

describe("resolveGrantKeywords", () => {
  it("resolves keywords to deduped descriptor UIs with full coverage", async () => {
    const out = await resolveGrantKeywords(
      ["neoplasms", "inflammation"],
      stubResolver({ neoplasms: "D009369", inflammation: "D007249" }),
    );
    expect(out.meshDescriptorUis).toEqual(["D009369", "D007249"]);
    expect(out.meshResolutionCoverage).toBe(1);
  });

  it("counts an unresolved term in the denominator, lowering coverage", async () => {
    const out = await resolveGrantKeywords(
      ["neoplasms", "made up term"],
      stubResolver({ neoplasms: "D009369" }),
    );
    expect(out.meshDescriptorUis).toEqual(["D009369"]);
    expect(out.meshResolutionCoverage).toBe(0.5);
  });

  it("dedupes descriptor UIs when two terms resolve to the same descriptor", async () => {
    const out = await resolveGrantKeywords(
      ["cancer", "malignant neoplasms"],
      stubResolver({ cancer: "D009369", malignantneoplasms: "D009369" }),
    );
    // Both forms resolve (numerator 2 of 2) but collapse to one descriptor.
    expect(out.meshDescriptorUis).toEqual(["D009369"]);
    expect(out.meshResolutionCoverage).toBe(1);
  });

  it("skips stopword terms — excluded from descriptors and from coverage", async () => {
    const out = await resolveGrantKeywords(
      ["goals", "inflammation"],
      stubResolver({ goals: "D006040", inflammation: "D007249" }),
    );
    // "goals" is a stopword: never resolved, not in the denominator → 1/1.
    expect(out.meshDescriptorUis).toEqual(["D007249"]);
    expect(out.meshResolutionCoverage).toBe(1);
  });

  it("returns nulls when every keyword is a stopword", async () => {
    const out = await resolveGrantKeywords(
      ["goals", "data set", "research personnel"],
      stubResolver({ goals: "D006040" }),
    );
    expect(out.meshDescriptorUis).toBeNull();
    expect(out.meshResolutionCoverage).toBeNull();
  });

  it("returns nulls for an empty keyword list", async () => {
    const out = await resolveGrantKeywords([], stubResolver({}));
    expect(out.meshDescriptorUis).toBeNull();
    expect(out.meshResolutionCoverage).toBeNull();
  });

  it("drops sub-3-character normalized forms before resolving", async () => {
    const out = await resolveGrantKeywords(
      ["ab", "rna"],
      stubResolver({ ab: "D000001", rna: "D012313" }),
    );
    // "ab" normalizes to 2 chars → dropped; only "rna" is in the denominator.
    expect(out.meshDescriptorUis).toEqual(["D012313"]);
    expect(out.meshResolutionCoverage).toBe(1);
  });

  it("dedupes keywords that normalize to the same form", async () => {
    const out = await resolveGrantKeywords(
      ["COVID-19", "covid 19"],
      stubResolver({ covid19: "D000086382" }),
    );
    // Both normalize to "covid19" → one form, one resolution.
    expect(out.meshDescriptorUis).toEqual(["D000086382"]);
    expect(out.meshResolutionCoverage).toBe(1);
  });

  it("yields coverage 0 with null descriptors when no form resolves", async () => {
    const out = await resolveGrantKeywords(
      ["unknownthing", "anotherone"],
      stubResolver({}),
    );
    // Denominator 2, numerator 0 — distinct from the all-stopword null case.
    expect(out.meshDescriptorUis).toBeNull();
    expect(out.meshResolutionCoverage).toBe(0);
  });
});

describe("MESH_RESOLVE_STOPWORDS", () => {
  it("holds normalized forms covering check-tags, wrong-sense, and generic terms", () => {
    expect(MESH_RESOLVE_STOPWORDS.has(normalizeForMatch("Humans"))).toBe(true);
    expect(MESH_RESOLVE_STOPWORDS.has(normalizeForMatch("lead"))).toBe(true);
    expect(MESH_RESOLVE_STOPWORDS.has(normalizeForMatch("research personnel"))).toBe(true);
    // A genuine topical term is not stopworded.
    expect(MESH_RESOLVE_STOPWORDS.has(normalizeForMatch("neoplasms"))).toBe(false);
  });
});
