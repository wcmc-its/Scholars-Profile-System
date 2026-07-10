import { describe, expect, it } from "vitest";

import {
  buildResearcherCsv,
  careerStageLabel,
  dueUrgency,
  fitTier,
  formatDue,
  fundingStatusLabel,
  researcherBlurb,
  stageFit,
  topicFitScores,
} from "@/lib/match-display";

describe("topicFitScores", () => {
  it("scales relative to the strongest match (top → 100)", () => {
    expect(topicFitScores([10, 8.8, 9.1])).toEqual([100, 88, 91]);
  });
  it("returns zeros when there is no signal", () => {
    expect(topicFitScores([0, 0])).toEqual([0, 0]);
    expect(topicFitScores([])).toEqual([]);
  });
});

describe("fitTier", () => {
  it("buckets relative to the strongest match in the set", () => {
    expect(fitTier(1.05, 1.05)).toBe("Strong match");
    expect(fitTier(0.8, 1.0)).toBe("Strong match");
    expect(fitTier(0.5, 1.0)).toBe("Good match");
    expect(fitTier(0.2, 1.0)).toBe("Possible match");
  });
  it("never divides by zero / never renders a number", () => {
    expect(fitTier(0, 0)).toBe("Possible match");
    expect(fitTier(0.5, 0)).toBe("Possible match");
    expect(fitTier(0, 1)).toBe("Possible match");
  });
});

describe("formatDue", () => {
  it("formats midnight-UTC date stamps in UTC (no US-Eastern day shift)", () => {
    // A date-only column arrives as midnight UTC; a local format in
    // US-Eastern would render the PREVIOUS day (Aug 31 for Sep 1).
    expect(formatDue("2026-09-01")).toBe("Sep 1, 2026");
    expect(formatDue("2026-09-01T00:00:00.000Z")).toBe("Sep 1, 2026");
  });
  it("is null for absent or unparseable input", () => {
    expect(formatDue(null)).toBeNull();
    expect(formatDue("not-a-date")).toBeNull();
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
  it("appends an ESI clause with years when eligible, and omits it otherwise", () => {
    expect(
      researcherBlurb({
        pubCount: 5,
        minYear: 2022,
        topicLabel: "gene therapy",
        careerStage: "early",
        esiEligible: true,
        yearsSinceDegree: 4,
      }),
    ).toBe("5 publications on gene therapy since 2022; early-career; ESI-eligible (4 yrs since terminal degree).");
    expect(
      researcherBlurb({ pubCount: 1, minYear: null, topicLabel: "x", careerStage: null, esiEligible: false }),
    ).toBe("1 publication on x.");
  });
});

describe("careerStageLabel", () => {
  it("maps buckets to short labels and null to empty", () => {
    expect(careerStageLabel("early")).toBe("Early career");
    expect(careerStageLabel("grad")).toBe("Graduate");
    expect(careerStageLabel(null)).toBe("");
  });
});

describe("fundingStatusLabel", () => {
  it("maps funding status to a label and nullish to empty", () => {
    expect(fundingStatusLabel("funded")).toBe("Currently funded");
    expect(fundingStatusLabel("unfunded")).toBe("Not currently funded");
    expect(fundingStatusLabel(null)).toBe("");
    expect(fundingStatusLabel(undefined)).toBe("");
  });
});

describe("buildResearcherCsv", () => {
  it("emits a header row and escapes commas in fields", () => {
    const csv = buildResearcherCsv([
      {
        cwid: "abc1234",
        name: "Elena Park",
        title: "Assistant Professor",
        department: "Hematology, Oncology",
        careerStage: "early",
        topicFit: 94,
        stageLabel: "Strong",
        esiEligible: true,
        fundingStatus: "unfunded",
        topTopicLabel: "checkpoint inhibition",
        topPubCount: 18,
      },
    ]);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      "CWID,Name,Title,Department,Career stage,Topic fit,Stage fit,ESI eligible,Funding status,Top topic,Papers on top topic",
    );
    expect(lines[1]).toContain("abc1234");
    expect(lines[1]).toContain("Early career");
    expect(lines[1]).toContain('"Hematology, Oncology"'); // comma → quoted
    expect(lines[1]).toContain("94");
    expect(lines[1]).toContain("Yes"); // ESI eligible
    expect(lines[1]).toContain("Not currently funded");
  });
  it("leaves ESI/funding cells blank when the matcher didn't supply them", () => {
    const csv = buildResearcherCsv([
      {
        cwid: "x",
        name: "N",
        title: null,
        department: null,
        careerStage: null,
        topicFit: 0,
        stageLabel: "Unknown",
        topTopicLabel: "",
        topPubCount: 0,
      },
    ]);
    // ...Unknown,,, ... → empty ESI + empty funding between Stage fit and Top topic.
    expect(csv.trim().split(/\r?\n/)[1]).toContain("Unknown,,,");
  });
});

describe("dueUrgency", () => {
  const now = Date.parse("2026-07-06T12:00:00Z");
  it("is past once the due day is fully behind now", () => {
    expect(dueUrgency("2026-07-05T00:00:00Z", now)).toBe("past");
  });
  it("is not past on the due day itself (date-only stamps)", () => {
    expect(dueUrgency("2026-07-06T00:00:00Z", now)).toBe("soon");
  });
  it("is soon within the 30-day window (boundary inclusive)", () => {
    expect(dueUrgency("2026-07-20T00:00:00Z", now)).toBe("soon");
    expect(dueUrgency("2026-08-05T12:00:00Z", now)).toBe("soon");
  });
  it("is null beyond the window, and for absent or unparseable dates", () => {
    expect(dueUrgency("2026-12-01T00:00:00Z", now)).toBeNull();
    expect(dueUrgency(null, now)).toBeNull();
    expect(dueUrgency("not-a-date", now)).toBeNull();
  });
});
