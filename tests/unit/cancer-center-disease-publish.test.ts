/**
 * `lib/cancer-center-disease-publish.ts` — the one published / to-review
 * predicate the /edit roster and (later) the public center page share.
 */
import { describe, expect, it } from "vitest";

import {
  diseaseRowStatus,
  isDiseasePublished,
  type DiseasePublishRow,
  type DiseaseRowStatus,
} from "@/lib/cancer-center-disease-publish";

const row = (confidence: string | null, decision: string | null): DiseasePublishRow => ({
  assignment: confidence === null ? null : { confidence },
  decision: decision === null ? null : { decision },
});

describe("diseaseRowStatus — truth table", () => {
  const cases: ReadonlyArray<[string | null, string | null, boolean, DiseaseRowStatus]> = [
    // A human decision always wins, whatever the switch or confidence.
    ["high", "confirmed", true, "confirmed"],
    ["high", "confirmed", false, "confirmed"],
    ["low", "confirmed", true, "confirmed"],
    ["high", "rejected", true, "rejected"],
    ["high", "rejected", false, "rejected"],
    ["medium", "rejected", true, "rejected"],
    // Manual add: a confirmed decision with no assignment.
    [null, "confirmed", true, "confirmed"],
    [null, "confirmed", false, "confirmed"],
    // Drift: a decision whose assignment disappeared.
    [null, "rejected", true, "rejected"],
    // No decision: only HIGH with the switch on auto-publishes.
    ["high", null, true, "auto"],
    ["high", null, false, "pending"],
    ["medium", null, true, "pending"],
    ["medium", null, false, "pending"],
    ["low", null, true, "pending"],
    ["low", null, false, "pending"],
  ];

  it.each(cases)("confidence=%s decision=%s autoPublish=%s -> %s", (confidence, decision, autoPublish, expected) => {
    expect(diseaseRowStatus(row(confidence, decision), autoPublish)).toBe(expected);
  });
});

describe("isDiseasePublished", () => {
  it("is confirmed OR auto, nothing else", () => {
    expect(isDiseasePublished(row("high", null), true)).toBe(true);
    expect(isDiseasePublished(row("high", null), false)).toBe(false);
    expect(isDiseasePublished(row("medium", null), true)).toBe(false);
    expect(isDiseasePublished(row("low", "confirmed"), false)).toBe(true);
    expect(isDiseasePublished(row(null, "confirmed"), false)).toBe(true);
    expect(isDiseasePublished(row("high", "rejected"), true)).toBe(false);
  });

  it("accepts a wider row shape structurally (extra fields are ignored)", () => {
    const wide = {
      diseaseCode: "BREAST",
      assignment: { confidence: "high", rank: 1, score: 9 },
      decision: null,
      drifted: false,
    };
    expect(isDiseasePublished(wide, true)).toBe(true);
  });
});
