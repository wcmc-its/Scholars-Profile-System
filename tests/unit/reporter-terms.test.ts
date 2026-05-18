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

  it("prefers pref_terms over terms when both are present", () => {
    expect(parseReporterTerms("Genetics;RNA", "<Adult><Adult Human>")).toEqual([
      "genetics",
      "rna",
    ]);
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
