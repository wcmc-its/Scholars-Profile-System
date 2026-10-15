import { describe, expect, it } from "vitest";

import {
  ABSTRACT_TITLE_MIN_OVERLAP,
  abstractTitleOverlap,
  grantAbstractMatchesTitle,
} from "@/lib/grant-abstract-match";

// Synthetic fixtures only (public repo): the shapes the pilot calibration found,
// written fresh, no real titles or abstracts.
const TITLE = "Thymic regulation of T cell aging in a mouse model of chronic inflammation";
const OWN_ABSTRACT =
  "PROJECT SUMMARY Age-related decline of the thymus limits the output of naive T cells. " +
  "We will use a mouse model of chronic inflammation to define how thymic epithelial signals " +
  "regulate T cell aging, and test whether restoring them reverses inflammatory phenotypes.";
const OTHER_PROJECT =
  "ABSTRACT This randomized trial compares two psychotherapy protocols for adolescents with " +
  "major depressive disorder across community clinics, measuring symptom remission, school " +
  "attendance and family functioning over eighteen months of follow-up.";
const NETWORK_SUMMARY =
  "PROJECT SUMMARY The overarching goal of the Example Trials Network is to identify acceptable, " +
  "feasible and scalable interventions. The network supports clinical research sites, a data " +
  "management center and a laboratory center that serve all protocols.";

describe("grantAbstractMatchesTitle", () => {
  it("keeps a matching abstract", () => {
    expect(grantAbstractMatchesTitle(TITLE, OWN_ABSTRACT)).toBe(true);
  });

  it("drops another project's abstract (#3071 award-number swap)", () => {
    expect(grantAbstractMatchesTitle(TITLE, OTHER_PROJECT)).toBe(false);
    expect(abstractTitleOverlap(TITLE, OTHER_PROJECT).matched).toBe(0);
  });

  it("drops a parent network summary attached to a site award", () => {
    expect(
      grantAbstractMatchesTitle("Vaccine Site Preparation - Uptown and Riverside", NETWORK_SUMMARY),
    ).toBe(false);
  });

  it("keeps an abstract that paraphrases most title words but restates one (1 of 6 clears the cut)", () => {
    const title = "Imaging of Cognition, Learning and Memory in Aging (ExRes)";
    const abs =
      "The proposed work aims to understand the neural basis of cognitive reserve: why some older " +
      "adults keep their function despite brain pathology. We will scan participants repeatedly.";
    const o = abstractTitleOverlap(title, abs);
    expect(o).toEqual({ titleTokens: 6, matched: 1 });
    expect(o.matched / o.titleTokens).toBeGreaterThanOrEqual(ABSTRACT_TITLE_MIN_OVERLAP);
    expect(grantAbstractMatchesTitle(title, abs)).toBe(true);
  });

  it("matches word forms on a shared 5-char prefix, case and punctuation aside", () => {
    expect(
      abstractTitleOverlap("Regulatory Networks in Tumors", "how REGULATION of tumor networks..."),
    ).toEqual({ titleTokens: 3, matched: 3 });
  });

  it("ignores stopwords, generic grant words, short words and numbers in the title", () => {
    expect(
      abstractTitleOverlap("A Novel Study of the Role of X in 2024: Project 3 Core", OTHER_PROJECT),
    ).toEqual({
      titleTokens: 0,
      matched: 0,
    });
  });

  it("never judges a title with fewer than three content words", () => {
    expect(grantAbstractMatchesTitle("Example Center", OTHER_PROJECT)).toBe(true);
    expect(grantAbstractMatchesTitle("Pathway Analysis", OTHER_PROJECT)).toBe(true);
    expect(grantAbstractMatchesTitle("", OTHER_PROJECT)).toBe(true);
    expect(grantAbstractMatchesTitle(null, OTHER_PROJECT)).toBe(true);
    // Three content words is enough to judge.
    expect(grantAbstractMatchesTitle("Pathway Analysis Tuberculosis", OTHER_PROJECT)).toBe(false);
  });

  it("treats an empty abstract as a match (nothing to drop)", () => {
    expect(grantAbstractMatchesTitle(TITLE, null)).toBe(true);
    expect(grantAbstractMatchesTitle(TITLE, undefined)).toBe(true);
    expect(grantAbstractMatchesTitle(TITLE, "")).toBe(true);
    expect(grantAbstractMatchesTitle(TITLE, "   \n ")).toBe(true);
  });
});
