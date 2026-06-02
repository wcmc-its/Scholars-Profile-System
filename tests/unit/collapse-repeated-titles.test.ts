/**
 * #702 follow-up — the People "Matched in publications" snippet is a single
 * ~150-char fragment cut from the concatenated `publicationTitles` blob. A prolific author
 * with many identically-titled papers ("Inflammatory breast cancer.") packs the
 * same sentence into that window repeatedly, producing a stuttered snippet.
 * `collapseRepeatedTitles` dedups consecutive duplicate title-sentences
 * (tag-/case-insensitively) and keeps the first few distinct ones.
 */
import { describe, expect, it } from "vitest";
import { collapseRepeatedTitles } from "@/components/search/people-result-card";

describe("collapseRepeatedTitles", () => {
  it("collapses an identically-repeated title (the screenshot case) to one", () => {
    const rep = "Inflammatory <mark>breast cancer</mark>.";
    expect(collapseRepeatedTitles(`${rep} ${rep} ${rep} ${rep} ${rep}`)).toBe(rep);
  });

  it("dedups regardless of terminal punctuation (? and !)", () => {
    const rep = "Déjà vu for <mark>breast cancer</mark> two?";
    expect(collapseRepeatedTitles(`${rep} ${rep} ${rep}`)).toBe(rep);
  });

  it("keeps distinct titles, capped at the first three", () => {
    const a = "Triple-negative <mark>breast cancer</mark> outcomes.";
    const b = "Genomics of <mark>breast cancer</mark>.";
    const c = "Hormonal therapy in <mark>breast cancer</mark>.";
    const d = "Screening for <mark>breast cancer</mark>.";
    expect(collapseRepeatedTitles(`${a} ${b} ${c} ${d}`)).toBe(`${a} ${b} ${c}`);
  });

  it("dedups case-insensitively and ignoring mark tags", () => {
    expect(
      collapseRepeatedTitles("<mark>Breast Cancer</mark>. breast cancer. BREAST <mark>cancer</mark>."),
    ).toBe("<mark>Breast Cancer</mark>.");
  });

  it("passes a single unterminated fragment through unchanged", () => {
    const frag = "A truncated title fragment with a <mark>match</mark> inside";
    expect(collapseRepeatedTitles(frag)).toBe(frag);
  });

  it("returns an empty string for empty input", () => {
    expect(collapseRepeatedTitles("")).toBe("");
  });
});
