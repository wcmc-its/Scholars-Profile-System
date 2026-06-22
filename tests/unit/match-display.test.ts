import { describe, expect, it } from "vitest";

import { researcherBlurb, stageFit, topicFitScores } from "@/lib/match-display";

describe("topicFitScores", () => {
  it("scales relative to the strongest match (top → 100)", () => {
    expect(topicFitScores([10, 8.8, 9.1])).toEqual([100, 88, 91]);
  });
  it("returns zeros when there is no signal", () => {
    expect(topicFitScores([0, 0])).toEqual([0, 0]);
    expect(topicFitScores([])).toEqual([]);
  });
});

describe("stageFit", () => {
  it("buckets appeal into strong/moderate/some/limited", () => {
    expect(stageFit(0.9, true)).toEqual({ label: "Strong", tone: "strong" });
    expect(stageFit(0.5, true)).toEqual({ label: "Moderate", tone: "moderate" });
    expect(stageFit(0.1, true)).toEqual({ label: "Some", tone: "weak" });
    expect(stageFit(0, true)).toEqual({ label: "Limited", tone: "none" });
  });
  it("flags unknown stage", () => {
    expect(stageFit(0.9, false)).toEqual({ label: "Unknown", tone: "none" });
  });
});

describe("researcherBlurb", () => {
  it("templates pub evidence + career stage", () => {
    expect(
      researcherBlurb({ pubCount: 18, minYear: 2021, topicLabel: "checkpoint inhibition", careerStage: "early" }),
    ).toBe("18 publications on checkpoint inhibition since 2021; early-career.");
  });
  it("singularizes one publication and omits an unknown year", () => {
    expect(
      researcherBlurb({ pubCount: 1, minYear: null, topicLabel: "T-cell engineering", careerStage: null }),
    ).toBe("1 publication on T-cell engineering.");
  });
  it("falls back to stage alone when there are no contributing pubs", () => {
    expect(
      researcherBlurb({ pubCount: 0, minYear: null, topicLabel: "x", careerStage: "mid" }),
    ).toBe("mid-career.");
  });
});
