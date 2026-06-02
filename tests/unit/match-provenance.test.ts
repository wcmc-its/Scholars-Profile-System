/**
 * Issue #688 / #702 — match provenance + matched-on fields + flag resolution.
 *
 * The pure `computeMatchProvenance` is the contract: given a scholar's MeSH UIs
 * and a resolved descriptor's descendant set, it returns the framing that
 * explains the attribution match — `narrower` for a strictly-narrower descendant
 * (#688), `concept` for a direct descriptor match (#702), or `undefined` when
 * the MeSH boost didn't explain the hit. Real data anchor: `Microbiome` →
 * Microbiota (D064307), descendants include Mycobiome (D000072761); a
 * Mycobiome-only scholar reads "Mycobiome — narrower term of Microbiota", a
 * Microbiota-tagged scholar reads "publications tagged Microbiota".
 *
 * `computeMatchedOnFields` (#702) maps the highlight field keys that fired to
 * the human field labels that drive the last-resort "Matched on …" chip.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeMatchProvenance,
  computeMatchedOnFields,
} from "@/lib/api/match-provenance";
import {
  resolvePeopleMatchProvenance,
  resolvePeopleMatchExplain,
} from "@/lib/api/search-flags";

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

describe("computeMatchProvenance — narrower terms (#688)", () => {
  it("surfaces a single narrower term the scholar is tagged with", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D000072761"], // Mycobiome only
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: LABELS,
      }),
    ).toEqual({ kind: "narrower", parentTerm: "Microbiota", descendantTerms: ["Mycobiome"] });
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
      kind: "narrower",
      parentTerm: "Microbiota",
      // Mycobiome precedes Virome in descendantUis order, regardless of input order.
      descendantTerms: ["Mycobiome", "Virome"],
    });
  });

  it("prefers the narrower framing when the scholar carries BOTH the parent and a descendant", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: [MICROBIOTA, "D000072761"], // parent + Mycobiome
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: LABELS,
      }),
    ).toEqual({ kind: "narrower", parentTerm: "Microbiota", descendantTerms: ["Mycobiome"] });
  });

  it("falls back to the UI code when a label is missing", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D000072761"],
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: new Map(), // no labels resolved
      }),
    ).toEqual({ kind: "narrower", parentTerm: "Microbiota", descendantTerms: ["D000072761"] });
  });
});

describe("computeMatchProvenance — direct concept match (#702)", () => {
  it("explains a direct descriptor match the scholar is tagged with", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: [MICROBIOTA], // direct match, no narrower term
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: LABELS,
      }),
    ).toEqual({ kind: "concept", parentTerm: "Microbiota" });
  });

  it("explains a direct match on a leaf descriptor (no descendants)", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D000072761"],
        descendantUis: ["D000072761"], // self only
        parentTerm: "Mycobiome",
        labels: new Map(),
      }),
    ).toEqual({ kind: "concept", parentTerm: "Mycobiome" });
  });
});

describe("computeMatchProvenance — nothing to explain", () => {
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

  it("returns undefined when no descriptor resolved (empty descendant set)", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: [MICROBIOTA],
        descendantUis: [],
        parentTerm: "",
        labels: new Map(),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the scholar carries neither the descriptor nor a descendant", () => {
    expect(
      computeMatchProvenance({
        publicationMeshUi: ["D012345", "D067890"], // unrelated only — matched on text, not MeSH
        descendantUis: DESCENDANTS,
        parentTerm: "Microbiota",
        labels: LABELS,
      }),
    ).toBeUndefined();
  });
});

describe("computeMatchedOnFields (#702)", () => {
  it("maps highlight keys to deduped, priority-ordered field labels", () => {
    // Out-of-order input, name twice (preferredName + fullName) → one "name".
    expect(
      computeMatchedOnFields([
        "publicationTitles",
        "overview",
        "fullName",
        "preferredName",
        "primaryDepartment",
      ]),
    ).toEqual(["name", "department", "overview", "publications"]);
  });

  it("collapses both publication fields to a single 'publications'", () => {
    expect(computeMatchedOnFields(["publicationMesh", "publicationTitles"])).toEqual([
      "publications",
    ]);
  });

  it("ignores unknown keys and returns empty when nothing known fired", () => {
    expect(computeMatchedOnFields(["leadership.chairOf", "somethingElse"])).toEqual([]);
    expect(computeMatchedOnFields([])).toEqual([]);
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

describe("resolvePeopleMatchExplain (#702)", () => {
  const original = process.env.SEARCH_PEOPLE_MATCH_EXPLAIN;
  beforeEach(() => {
    delete process.env.SEARCH_PEOPLE_MATCH_EXPLAIN;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PEOPLE_MATCH_EXPLAIN;
    else process.env.SEARCH_PEOPLE_MATCH_EXPLAIN = original;
  });

  it("defaults to off when the env is unset", () => {
    expect(resolvePeopleMatchExplain()).toBe(false);
  });

  it("is on only for the exact value 'on'", () => {
    process.env.SEARCH_PEOPLE_MATCH_EXPLAIN = "on";
    expect(resolvePeopleMatchExplain()).toBe(true);
    process.env.SEARCH_PEOPLE_MATCH_EXPLAIN = "true";
    expect(resolvePeopleMatchExplain()).toBe(false);
    process.env.SEARCH_PEOPLE_MATCH_EXPLAIN = "ON";
    expect(resolvePeopleMatchExplain()).toBe(false);
  });
});
