import { describe, expect, it } from "vitest";

import {
  appealByStageSummary,
  careerStageLabel,
  dueUrgency,
  fitTier,
  formatDue,
} from "@/lib/match-display";

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

describe("careerStageLabel", () => {
  it("maps buckets to short labels and null to empty", () => {
    expect(careerStageLabel("early")).toBe("Early career");
    expect(careerStageLabel("grad")).toBe("Graduate");
    expect(careerStageLabel(null)).toBe("");
  });
});

describe("appealByStageSummary", () => {
  it("names the top stage for a skewed spread (Harry Weaver-shaped)", () => {
    expect(appealByStageSummary({ early: 0.9, senior: 0.1 })).toBe("Best fit: Early career");
  });
  it("reads as broad when the spread is flat (A-T Children's Project-shaped)", () => {
    expect(
      appealByStageSummary({ grad: 0.6, postdoc: 0.65, early: 0.7, mid: 0.65, senior: 0.6 }),
    ).toBe("Appeals broadly across career stages");
  });
  it("is null when there is no signal", () => {
    expect(appealByStageSummary({})).toBeNull();
  });
  it("joins two stages that tie near the top", () => {
    expect(appealByStageSummary({ grad: 0.2, postdoc: 0.9, early: 0.85, mid: 0.3, senior: 0.1 })).toBe(
      "Best fit: Postdoc, Early career",
    );
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
