/**
 * Issue #688 — narrower-term provenance computation + flag resolution.
 *
 * The pure `computeMatchProvenance` is the contract: given a scholar's MeSH UIs
 * and a resolved descriptor's descendant set, it returns the narrower term(s)
 * that explain a subsumption match — or `undefined` when there's nothing to
 * explain. Real data anchor: `Microbiome` → Microbiota (D064307), descendants
 * include Mycobiome (D000072761); a Mycobiome-only scholar should read
 * "Mycobiome — narrower term of Microbiota".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeMatchProvenance } from "@/lib/api/match-provenance";
import { resolvePeopleMatchProvenance } from "@/lib/api/search-flags";

// Microbiota (D064307) descendant set (real tree-walk order from mesh_descriptor).
const MICROBIOTA = "D064307";
const DESCENDANTS = [
  MICROBIOTA, // [0] = self / parent (invariant)
  "D000069196", // Gastrointestinal Microbiome
  "D059013", // Microbial Consortia
  "D000072761", // Mycobiome
  "D000074284", // Periphyton
  "D000098903", // Skin Microbiome
  "D000083422", // Virome
];
const LABELS = new Map<string, string>([
  ["D000069196", "Gastrointestinal Microbiome"],
  ["D059013", "Microbial Consortia"],
  ["D000072761", "Mycobiome"],
  ["D000074284", "Periphyton"],
  ["D000098903", "Skin Microbiome"],
  ["D000083422", "Virome"],
]);

describe("computeMatchProvenance (#688)", () => {
  it("surfaces a single narrower term the scholar is tagged with", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D000072761"], // Mycobiome only
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: LABELS,
      }),
    ).toEqual({ parentTerm: "Microbiota", descendantTerms: ["Mycobiome"] });
  });

  it("returns multiple narrower terms in tree-walk order, dropping unrelated UIs", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D000083422", "D000072761", "D012345" /* unrelated */],
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: LABELS,
      }),
    ).toEqual({
      parentTerm: "Microbiota",
      // Mycobiome precedes Virome in descendantUis order, regardless of input order.
      descendantTerms: ["Mycobiome", "Virome"],
    });
  });

  it("returns undefined when the scholar matched only the resolved descriptor itself", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: [MICROBIOTA], // direct match, no narrower term
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: LABELS,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the scholar carries no MeSH UIs", () => {
    for (const publicationMeshUi of [undefined, [] as string[]]) {
      expect(
        computeMatchProvenance({
          publicationMeshUi,
          descendantUis: DESCENDANTS,
          parentTerm: "Microbiota",
          labels: LABELS,
        }),
      ).toBeUndefined();
    }
  });

  it("returns undefined when the descriptor has no descendants (leaf)", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D000072761"],
        descendantUis: ["D000072761"], // self only
        parentTerm: "Mycobiome",
        labels: new Map(),
      }),
    ).toBeUndefined();
  });

  it("falls back to the UI code when a label is missing", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D000072761"],
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: new Map(), // no labels resolved
      }),
    ).toEqual({ parentTerm: "Microbiota", descendantTerms: ["D000072761"] });
  });
});

describe("resolvePeopleMatchProvenance (#688)", () => {
  const original = process.env.SEARCH_PEOPLE_MATCH_PROVENANCE;
  beforeEach(() => {
    delete process.env.SEARCH_PEOPLE_MATCH_PROVENANCE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PEOPLE_MATCH_PROVENANCE;
    else process.env.SEARCH_PEOPLE_MATCH_PROVENANCE = original;
  });

  it("defaults to off when the env is unset", () => {
    expect(resolvePeopleMatchProvenance()).toBe(false);
  });

  it("is on only for the exact value 'on'", () => {
    process.env.SEARCH_PEOPLE_MATCH_PROVENANCE = "on";
    expect(resolvePeopleMatchProvenance()).toBe(true);
    process.env.SEARCH_PEOPLE_MATCH_PROVENANCE = "true";
    expect(resolvePeopleMatchProvenance()).toBe(false);
    process.env.SEARCH_PEOPLE_MATCH_PROVENANCE = "ON";
    expect(resolvePeopleMatchProvenance()).toBe(false);
  });
});
