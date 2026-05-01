import { describe, it, expect } from "vitest";
import { subtopicLabel } from "@/lib/subtopic";

describe("subtopicLabel", () => {
  it("title-cases a multi-word underscore slug", () => {
    expect(subtopicLabel("breast_screening_risk_prediction")).toBe("Breast Screening Risk Prediction");
  });
  it("title-cases a two-word underscore slug", () => {
    expect(subtopicLabel("cancer_genomics")).toBe("Cancer Genomics");
  });
  it("is lossy on acronym slugs (accepted Phase 3 limitation)", () => {
    expect(subtopicLabel("hiv_aids")).toBe("Hiv Aids");
  });
  it("returns empty string for empty input", () => {
    expect(subtopicLabel("")).toBe("");
  });
  it("title-cases a single word with no underscore", () => {
    expect(subtopicLabel("single")).toBe("Single");
  });
  it("title-cases a single character", () => {
    expect(subtopicLabel("a")).toBe("A");
  });
});
