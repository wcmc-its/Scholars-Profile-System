/**
 * Unit tests for the comms-steward Method-Family surfacing matcher
 * (`docs/comms-steward-methods-visibility-spec.md` §6). Pure + DB-free: covers
 * the structural `animal_cell_models` signal, the lexical term match, benign
 * non-matches, case-insensitivity, and whole-word boundaries.
 */
import { describe, expect, it } from "vitest";

import { classifyFamily, parseTerms } from "@/etl/family-review/classify";

// The §6 seed list, exercised through the same parser the ETL uses.
const TERMS = parseTerms(
  [
    "# comment line — ignored",
    "",
    "mouse",
    "mice",
    "murine",
    "rat",
    "rodent",
    "zebrafish",
    "drosophila",
    "xenograft",
    "pdx",
    "primate",
    "macaque",
    "nhp",
    "canine",
    "porcine",
    "swine",
    "rabbit",
    "ferret",
    "knockout",
    "transgenic",
    "germline",
    "in vivo",
    "animal model",
  ].join("\n"),
);

describe("parseTerms", () => {
  it("drops comments + blank lines and lowercases", () => {
    const terms = parseTerms("# header\n\nMouse\n  Rat  \n#another\nIn Vivo\n");
    expect(terms).toEqual(["mouse", "rat", "in vivo"]);
  });
});

describe("classifyFamily — structural signal", () => {
  it("flags animal_cell_models regardless of label", () => {
    expect(
      classifyFamily("animal_cell_models", "Some benign-sounding cell assay", TERMS).reason,
    ).toBe("supercategory:animal_cell_models");
  });

  it("flags animal_cell_models even with an empty label and no terms", () => {
    expect(classifyFamily("animal_cell_models", "", []).reason).toBe(
      "supercategory:animal_cell_models",
    );
  });

  it("is case-insensitive on the supercategory", () => {
    expect(classifyFamily("Animal_Cell_Models", "Whatever", []).reason).toBe(
      "supercategory:animal_cell_models",
    );
  });
});

describe("classifyFamily — lexical signal", () => {
  it("flags a 'mouse model' label via the term list", () => {
    const { reason } = classifyFamily("imaging_methods", "Mouse model of glioma", TERMS);
    expect(reason).toBe("term:mouse");
  });

  it("matches case-insensitively (MURINE)", () => {
    expect(classifyFamily("genetics", "MURINE knockout screen", TERMS).reason).toBe(
      "term:murine",
    );
  });

  it("matches a multi-word term ('in vivo')", () => {
    expect(classifyFamily("pharmacology", "In Vivo pharmacokinetics", TERMS).reason).toBe(
      "term:in vivo",
    );
  });

  it("returns the first matching term in file order", () => {
    // "mouse" precedes "knockout" in TERMS, so it wins on a label with both.
    expect(classifyFamily("genetics", "Mouse knockout line", TERMS).reason).toBe("term:mouse");
  });
});

describe("classifyFamily — benign / boundary cases", () => {
  it("does NOT flag a benign label", () => {
    expect(classifyFamily("study_design", "Observational study design", TERMS).reason).toBeNull();
  });

  it("respects whole-word boundaries ('rat' does not fire on 'demonstrate'/'ratio')", () => {
    expect(classifyFamily("statistics", "Ratio-based demonstrate metrics", TERMS).reason).toBeNull();
  });

  it("returns null when the term list is empty and the supercategory is benign", () => {
    expect(classifyFamily("imaging_methods", "Mouse model of glioma", []).reason).toBeNull();
  });
});
