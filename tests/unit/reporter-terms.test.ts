import { describe, expect, it } from "vitest";
import { MAX_GRANT_KEYWORDS, parseReporterTerms } from "@/lib/reporter-terms";

describe("parseReporterTerms", () => {
  it("parses semicolon-delimited pref_terms", () => {
    expect(
      parseReporterTerms("Adult;Alternative Splicing;Bar Codes", null),
    ).toEqual(["adult", "alternative splicing", "bar codes"]);
  });

  it("parses angle-bracket-wrapped terms when pref_terms is absent", () => {
    expect(parseReporterTerms(null, "<Adult><Adult Human><Bar Codes>")).toEqual(
      ["adult", "adult human", "bar codes"],
    );
  });

  // #2182 — this used to PREFER pref_terms and discard terms entirely. Only
  // `terms` carries MeSH descriptor and entry-term names, so discarding it
  // left on-disease grants resolving to no descriptor at all.
  it("unions both vocabularies when present, pref_terms first", () => {
    expect(parseReporterTerms("Genetics;RNA", "<Adult><Adult Human>")).toEqual([
      "genetics",
      "rna",
      "adult",
      "adult human",
    ]);
  });

  it("keeps the MeSH descriptor name that only `terms` carries", () => {
    // Shape taken from live RePORTER on U01CA260352: pref_terms has the RCDC
    // surface form, terms has the MeSH descriptor. Resolution is an exact
    // normalized lookup, so only the latter resolves to Breast Neoplasms.
    const parsed = parseReporterTerms(
      "Malignant Breast Neoplasm;Breast Cancer Risk Factor",
      "<Breast Cancer><Breast Neoplasms>",
    );
    expect(parsed).toContain("breast neoplasms");
    expect(parsed).toContain("breast cancer");
    // ...and still keeps what pref_terms contributed.
    expect(parsed).toContain("malignant breast neoplasm");
  });

  it("falls back to terms when pref_terms is empty or whitespace-only", () => {
    expect(parseReporterTerms("", "<Adult><RNA>")).toEqual(["adult", "rna"]);
    expect(parseReporterTerms("   ", "<Adult>")).toEqual(["adult"]);
    expect(parseReporterTerms(";; ;", "<Adult>")).toEqual(["adult"]);
  });

  it("trims, lowercases, and drops empty entries", () => {
    expect(parseReporterTerms("  Adult ;; RNA  ;", null)).toEqual([
      "adult",
      "rna",
    ]);
  });

  it("de-dupes case- and whitespace-variant terms, first occurrence wins", () => {
    expect(parseReporterTerms("Adult;adult; ADULT ;RNA", null)).toEqual([
      "adult",
      "rna",
    ]);
  });

  it("drops empty <> segments in the terms fallback", () => {
    expect(parseReporterTerms(null, "<Adult><><RNA>")).toEqual(["adult", "rna"]);
  });

  it("caps the result at MAX_GRANT_KEYWORDS, keeping returned order", () => {
    const many = Array.from(
      { length: MAX_GRANT_KEYWORDS + 20 },
      (_, i) => `term${i}`,
    );
    const parsed = parseReporterTerms(many.join(";"), null);
    expect(parsed).toHaveLength(MAX_GRANT_KEYWORDS);
    expect(parsed![0]).toBe("term0");
    expect(parsed![MAX_GRANT_KEYWORDS - 1]).toBe(
      `term${MAX_GRANT_KEYWORDS - 1}`,
    );
  });

  it("returns null when neither field yields a usable term", () => {
    expect(parseReporterTerms(null, null)).toBeNull();
    expect(parseReporterTerms(undefined, undefined)).toBeNull();
    expect(parseReporterTerms("", "")).toBeNull();
    expect(parseReporterTerms("  ;; ", "<><>")).toBeNull();
  });
});

describe("#2182 — the cap must not bind before the disease term", () => {
  // Measured on live RePORTER 2026-08-04: pref_terms runs 89-124 entries and
  // terms 201-288, and the MeSH descriptor name sits at union index 98-131.
  // At the old cap of 50 the union change alone would have achieved nothing.
  it("keeps a descriptor name that sits beyond the old 50-term cap", () => {
    const pref = Array.from({ length: 120 }, (_, i) => `pref${i}`).join(";");
    const terms = `${Array.from({ length: 60 }, (_, i) => `<t${i}>`).join("")}<Breast Neoplasms>`;
    const parsed = parseReporterTerms(pref, terms);
    expect(parsed).toContain("breast neoplasms");
    expect(parsed!.indexOf("breast neoplasms")).toBeGreaterThan(50);
  });

  it("still caps, so a pathological upstream cannot flow through unbounded", () => {
    const huge = Array.from({ length: MAX_GRANT_KEYWORDS + 250 }, (_, i) => `t${i}`).join(";");
    expect(parseReporterTerms(huge, null)).toHaveLength(MAX_GRANT_KEYWORDS);
  });
});
