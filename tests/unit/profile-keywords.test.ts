import { describe, expect, it } from "vitest";
import { aggregateKeywords, normalizeMeshTerms } from "@/lib/api/profile";

function pub(
  type: string | null,
  meshTerms: unknown,
): { publicationType: string | null; publication: { meshTerms: unknown } } {
  return { publicationType: type, publication: { meshTerms } };
}

describe("normalizeMeshTerms", () => {
  it("returns empty array for non-array inputs", () => {
    expect(normalizeMeshTerms(null)).toEqual([]);
    expect(normalizeMeshTerms(undefined)).toEqual([]);
    expect(normalizeMeshTerms({})).toEqual([]);
    expect(normalizeMeshTerms("string")).toEqual([]);
  });

  it("preserves resolved {ui, label} entries", () => {
    expect(
      normalizeMeshTerms([
        { ui: "D015316", label: "Genetic Therapy" },
        { ui: "D008168", label: "Lung" },
      ]),
    ).toEqual([
      { ui: "D015316", label: "Genetic Therapy" },
      { ui: "D008168", label: "Lung" },
    ]);
  });

  it("coerces empty-string ui to null", () => {
    expect(normalizeMeshTerms([{ ui: "", label: "X" }])).toEqual([
      { ui: null, label: "X" },
    ]);
  });

  it("drops entries with missing label", () => {
    expect(
      normalizeMeshTerms([
        { ui: "D1", label: "A" },
        { ui: "D2" },
        { ui: "D3", label: null },
      ]),
    ).toEqual([{ ui: "D1", label: "A" }]);
  });
});

describe("aggregateKeywords", () => {
  it("returns empty result for no publications", () => {
    expect(aggregateKeywords([])).toEqual({
      totalAcceptedPubs: 0,
      keywords: [],
    });
  });

  it("counts each keyword once per publication and sorts count desc", () => {
    const pubs = [
      pub("Academic Article", [
        { ui: "D015316", label: "Genetic Therapy" },
        { ui: "D008168", label: "Lung" },
      ]),
      pub("Academic Article", [{ ui: "D015316", label: "Genetic Therapy" }]),
      pub("Review", [{ ui: "D008168", label: "Lung" }]),
    ];
    const result = aggregateKeywords(pubs);
    expect(result.totalAcceptedPubs).toBe(3);
    expect(result.keywords).toEqual([
      { descriptorUi: "D015316", displayLabel: "Genetic Therapy", pubCount: 2 },
      { descriptorUi: "D008168", displayLabel: "Lung", pubCount: 2 },
    ]);
  });

  it("breaks count ties alphabetically by displayLabel", () => {
    const pubs = [
      pub("Academic Article", [
        { ui: "D2", label: "Beta" },
        { ui: "D1", label: "Alpha" },
      ]),
    ];
    const result = aggregateKeywords(pubs);
    expect(result.keywords.map((k) => k.displayLabel)).toEqual(["Alpha", "Beta"]);
  });

  it("excludes Retraction and Erratum publications from totals and counts", () => {
    const pubs = [
      pub("Academic Article", [{ ui: "D1", label: "Alpha" }]),
      pub("Retraction", [{ ui: "D1", label: "Alpha" }]),
      pub("Erratum", [{ ui: "D1", label: "Alpha" }]),
    ];
    const result = aggregateKeywords(pubs);
    expect(result.totalAcceptedPubs).toBe(1);
    expect(result.keywords).toEqual([
      { descriptorUi: "D1", displayLabel: "Alpha", pubCount: 1 },
    ]);
  });

  it("dedupes keywords within a single publication", () => {
    const pubs = [
      pub("Academic Article", [
        { ui: "D1", label: "Alpha" },
        { ui: "D1", label: "Alpha" }, // malformed double-entry
      ]),
    ];
    expect(aggregateKeywords(pubs).keywords).toEqual([
      { descriptorUi: "D1", displayLabel: "Alpha", pubCount: 1 },
    ]);
  });

  it("preserves unresolved-UI keywords with descriptorUi: null", () => {
    const pubs = [
      pub("Academic Article", [
        { ui: null, label: "Some unresolved label" },
        { ui: null, label: "Some unresolved label" }, // second pub same label
      ]),
      pub("Academic Article", [{ ui: null, label: "Some unresolved label" }]),
    ];
    const result = aggregateKeywords(pubs);
    expect(result.keywords).toEqual([
      { descriptorUi: null, displayLabel: "Some unresolved label", pubCount: 2 },
    ]);
  });

  it("ignores non-array meshTerms gracefully", () => {
    const pubs = [
      pub("Academic Article", null),
      pub("Academic Article", "garbage"),
      pub("Academic Article", [{ ui: "D1", label: "Alpha" }]),
    ];
    const result = aggregateKeywords(pubs);
    expect(result.totalAcceptedPubs).toBe(3); // pubs still count toward total
    expect(result.keywords).toEqual([
      { descriptorUi: "D1", displayLabel: "Alpha", pubCount: 1 },
    ]);
  });
});
