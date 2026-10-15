import { describe, expect, it } from "vitest";

import {
  ABSTRACT_TITLE_MIN_OVERLAP,
  abstractTitleOverlap,
  grantAbstractMatchesTitle,
} from "@/lib/grant-abstract-match";

// Synthetic fixtures only (public repo): the shapes the pilot calibration found,
// written fresh, no real titles or abstracts.
const TITLE = "Zebrafish fin regeneration signaling in a model of chronic wound repair";
const OWN_ABSTRACT =
  "PROJECT SUMMARY Adult zebrafish regrow an amputated fin within weeks. We will use a model of " +
  "chronic wound repair to define how regeneration signaling from the fin epidermis is lost, and " +
  "test whether restoring that signaling rescues repair in older fish.";
const OTHER_PROJECT =
  "ABSTRACT This field survey compares two irrigation schedules for dwarf citrus orchards across " +
  "coastal farms, measuring fruit yield, leaf color and soil salinity over three growing seasons.";
const NETWORK_SUMMARY =
  "PROJECT SUMMARY The overarching goal of the Example Lunar Agriculture Consortium is to identify " +
  "acceptable, feasible and scalable crop systems. The consortium supports field stations, a data " +
  "management center and a seed bank that serve all protocols.";

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
      grantAbstractMatchesTitle(
        "Greenhouse Plot Readiness - Northfield and Lakeside",
        NETWORK_SUMMARY,
      ),
    ).toBe(false);
  });

  it("keeps an abstract that paraphrases most title words but restates one (1 of 6 clears the cut)", () => {
    const title = "Mapping of Vigilance, Foraging and Memory in Aging Meerkats";
    const abs =
      "The proposed work asks why some elderly meerkats keep their alertness and food-finding " +
      "skill despite decline. We will observe wild colonies repeatedly across several seasons.";
    const o = abstractTitleOverlap(title, abs);
    expect(o).toEqual({ titleTokens: 6, matched: 1 });
    expect(o.matched / o.titleTokens).toBeGreaterThanOrEqual(ABSTRACT_TITLE_MIN_OVERLAP);
    expect(grantAbstractMatchesTitle(title, abs)).toBe(true);
  });

  it("drops an abstract just under the cut (1 of 7, 1 of 8 title words)", () => {
    const abs = "We will observe wild meerkats repeatedly across several seasons.";
    for (const [title, titleTokens] of [
      ["Mapping of Vigilance, Foraging, Burrowing and Memory in Aging Meerkats", 7],
      ["Mapping of Vigilance, Foraging, Burrowing, Grooming and Memory in Aging Meerkats", 8],
    ] as const) {
      const o = abstractTitleOverlap(title, abs);
      expect(o).toEqual({ titleTokens, matched: 1 });
      expect(o.matched / o.titleTokens).toBeLessThan(ABSTRACT_TITLE_MIN_OVERLAP);
      expect(grantAbstractMatchesTitle(title, abs)).toBe(false);
    }
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
    expect(grantAbstractMatchesTitle("Pathway Analysis Glimmerpox", OTHER_PROJECT)).toBe(false);
  });

  it("treats an empty abstract as a match (nothing to drop)", () => {
    expect(grantAbstractMatchesTitle(TITLE, null)).toBe(true);
    expect(grantAbstractMatchesTitle(TITLE, undefined)).toBe(true);
    expect(grantAbstractMatchesTitle(TITLE, "")).toBe(true);
    expect(grantAbstractMatchesTitle(TITLE, "   \n ")).toBe(true);
  });
});
