import { describe, expect, it } from "vitest";
import {
  TRANSLATIONAL_STAGES,
  TRANSLATIONAL_STAGE_LABELS,
  displayStage,
  isTranslationalStage,
  parseTranslationalStage,
  parseTranslationalStageConfidence,
  translationalStageLabel,
} from "@/lib/translational-stage";

describe("TRANSLATIONAL_STAGES", () => {
  it("lists the four displayable stages in fixed order, each with a label", () => {
    expect([...TRANSLATIONAL_STAGES]).toEqual(["T0", "T1", "T2", "T3-4"]);
    expect(TRANSLATIONAL_STAGE_LABELS).toEqual({
      T0: "Basic research",
      T1: "Early translation",
      T2: "Clinical trials and efficacy",
      "T3-4": "Practice and population health",
    });
  });
});

describe("parseTranslationalStage", () => {
  it("accepts the five known raw values, NA included", () => {
    for (const v of ["T0", "T1", "T2", "T3-4", "NA"]) expect(parseTranslationalStage(v)).toBe(v);
  });
  it("rejects anything else rather than guessing", () => {
    for (const v of ["T3", "T4", "t0", " T0", "T0 ", "", "na", "unknown", 0, null, undefined, {}]) {
      expect(parseTranslationalStage(v)).toBeNull();
    }
  });
});

describe("parseTranslationalStageConfidence", () => {
  it("accepts high / medium / low", () => {
    for (const v of ["high", "medium", "low"]) expect(parseTranslationalStageConfidence(v)).toBe(v);
  });
  it("rejects anything else", () => {
    for (const v of ["High", "very high", "", 1, null, undefined]) {
      expect(parseTranslationalStageConfidence(v)).toBeNull();
    }
  });
});

describe("isTranslationalStage", () => {
  it("is true only for the four displayable stages", () => {
    for (const v of TRANSLATIONAL_STAGES) expect(isTranslationalStage(v)).toBe(true);
    for (const v of ["NA", "T3", "", null, undefined, 2]) expect(isTranslationalStage(v)).toBe(false);
  });
});

describe("displayStage", () => {
  it("shows a T stage at high or medium confidence", () => {
    expect(displayStage("T0", "high")).toBe("T0");
    expect(displayStage("T1", "medium")).toBe("T1");
    expect(displayStage("T3-4", "high")).toBe("T3-4");
  });
  it("shows a valid stage when confidence is missing", () => {
    expect(displayStage("T2", null)).toBe("T2");
    expect(displayStage("T2", undefined)).toBe("T2");
  });
  it("hides every stage at low confidence", () => {
    for (const v of TRANSLATIONAL_STAGES) expect(displayStage(v, "low")).toBeNull();
  });
  it("hides NA whatever the confidence", () => {
    expect(displayStage("NA", "high")).toBeNull();
    expect(displayStage("NA", null)).toBeNull();
  });
  it("hides a missing or unknown stage", () => {
    expect(displayStage(null, "high")).toBeNull();
    expect(displayStage(undefined, undefined)).toBeNull();
    expect(displayStage("", "high")).toBeNull();
    expect(displayStage("T5", "high")).toBeNull();
    expect(displayStage("t0", "high")).toBeNull();
  });
});

describe("translationalStageLabel", () => {
  it("labels the four stages", () => {
    expect(translationalStageLabel("T0")).toBe("Basic research");
    expect(translationalStageLabel("T3-4")).toBe("Practice and population health");
  });
  it("passes unknown values through", () => {
    expect(translationalStageLabel("NA")).toBe("NA");
    expect(translationalStageLabel("T9")).toBe("T9");
  });
});
