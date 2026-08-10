/**
 * NCI Table 2A "Peer-Reviewed" classification (`cancer-center-peer-review.ts`,
 * DT2A rule #4). Deterministic — no mocks needed.
 */
import { describe, expect, it } from "vitest";

import { isPeerReviewedFundingSource } from "@/lib/edit/cancer-center-peer-review";

describe("isPeerReviewedFundingSource", () => {
  it("is peer-reviewed whenever nihAward is true, regardless of the specific institute name", () => {
    expect(isPeerReviewedFundingSource("National Cancer Institute", true)).toBe(true);
    // A non-NCI institute is still an NIH award -- rule #4 says "NCI, NIH", not "NCI only".
    expect(isPeerReviewedFundingSource("National Institute of Allergy & Infectious Diseases", true)).toBe(true);
  });

  it("does NOT match on the substring \"NIH\" alone when nihAward is false -- must use the real flag", () => {
    // A hypothetical sponsor name containing "NIH" but flagged non-NIH by OSRA.
    expect(isPeerReviewedFundingSource("NIH Care Management Research and Educational Foundation", false)).toBe(false);
  });

  it("matches a real org from the closed allowlist by name, case-insensitively", () => {
    expect(isPeerReviewedFundingSource("National Science Foundation", false)).toBe(true);
    expect(isPeerReviewedFundingSource("Leukemia & Lymphoma Society, Inc.", false)).toBe(true);
    expect(isPeerReviewedFundingSource("susan g. komen breast cancer foundation, inc.", false)).toBe(true);
    expect(isPeerReviewedFundingSource("Patient-Centered Outcomes Research Institute", false)).toBe(true);
  });

  it("does not false-positive a similarly-named org that isn't on the list", () => {
    // Lymphoma Research Foundation is a real, DIFFERENT org from Leukemia & Lymphoma Society.
    expect(isPeerReviewedFundingSource("Lymphoma Research Foundation", false)).toBe(false);
    expect(isPeerReviewedFundingSource("American Heart Association", false)).toBe(false);
  });

  it("defaults the 3 caveated orgs (ACS, VA, DOD) to false -- conservative, not a guess", () => {
    expect(isPeerReviewedFundingSource("American Cancer Society", false)).toBe(false);
    expect(isPeerReviewedFundingSource("United States Department of Defense", false)).toBe(false);
    expect(isPeerReviewedFundingSource("Central Office of the Veterans Administration", false)).toBe(false);
  });

  it("is false for an unrelated non-federal, non-listed sponsor", () => {
    expect(isPeerReviewedFundingSource("Columbia University", false)).toBe(false);
  });

  it("matches TRDRP and St. Baldrick's regardless of hyphen/apostrophe spelling variants", () => {
    // Regression: the keyword list originally only had the space (not hyphenated)
    // spelling of TRDRP's real, commonly-hyphenated name -- a plausible OSRA
    // spelling would have silently missed it.
    expect(isPeerReviewedFundingSource("The California Tobacco-Related Disease Research Program", false)).toBe(true);
    expect(isPeerReviewedFundingSource("The California Tobacco Related Disease Research Program", false)).toBe(true);
    // Regression: only a straight-apostrophe keyword existed, unlike the
    // curly-apostrophe variant already handled for Alex's Lemonade Stand.
    expect(isPeerReviewedFundingSource("St. Baldrick’s Foundation", false)).toBe(true);
    expect(isPeerReviewedFundingSource("St. Baldrick's Foundation", false)).toBe(true);
  });
});
