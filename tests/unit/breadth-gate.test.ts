/**
 * ADR-011 breadth gate — unit coverage for the pure token-coverage functions.
 * Worked examples are the ones named in the ADR itself, so a regression here
 * is a regression the ADR's own reasoning already flagged as load-bearing.
 */
import { describe, expect, it } from "vitest";
import { contentWordCoverage, unconsumedContentTokens } from "@/lib/api/breadth-gate";

describe("unconsumedContentTokens / contentWordCoverage", () => {
  it("both tokens consumed — lung cancer / Lung Cancer", () => {
    expect(unconsumedContentTokens("lung cancer", "Lung Cancer")).toEqual([]);
    expect(contentWordCoverage("lung cancer", "Lung Cancer")).toBe(1);
  });

  it("both tokens consumed — gene therapy / Gene Therapy entry term", () => {
    expect(unconsumedContentTokens("gene therapy", "Gene Therapy")).toEqual([]);
    expect(contentWordCoverage("gene therapy", "Gene Therapy")).toBe(1);
  });

  it("scope-shift example — functional mri drops 'functional' against MRI", () => {
    expect(unconsumedContentTokens("functional mri", "MRI")).toEqual(["functional"]);
    expect(contentWordCoverage("functional mri", "MRI")).toBe(0.5);
  });

  it("qualifier-drop example — pediatric asthma drops 'pediatric' against Asthma", () => {
    expect(unconsumedContentTokens("pediatric asthma", "Asthma")).toEqual(["pediatric"]);
    expect(contentWordCoverage("pediatric asthma", "Asthma")).toBe(0.5);
  });

  it("is case-insensitive and ignores punctuation, matching normalizeForMatch's rules", () => {
    expect(unconsumedContentTokens("Cardio-Oncology", "cardio oncology")).toEqual([]);
  });

  it("drops the standalone connector word 'and', same as normalizeForMatch", () => {
    expect(
      unconsumedContentTokens("Pathology and Laboratory Medicine", "Pathology & Laboratory Medicine"),
    ).toEqual([]);
  });

  it("dedupes repeated query tokens instead of double-counting them", () => {
    expect(unconsumedContentTokens("cancer cancer research", "Research")).toEqual(["cancer"]);
    expect(contentWordCoverage("cancer cancer research", "Research")).toBeCloseTo(0.5);
  });

  it("an empty/unmatchable query reads as fully covered, not 0/0", () => {
    expect(contentWordCoverage("", "anything")).toBe(1);
    expect(contentWordCoverage("!!!", "anything")).toBe(1);
  });

  it("a fully unconsumed query reports every distinct token", () => {
    expect(unconsumedContentTokens("epidemiological monitoring", "Neoplasms")).toEqual([
      "epidemiological",
      "monitoring",
    ]);
    expect(contentWordCoverage("epidemiological monitoring", "Neoplasms")).toBe(0);
  });
});
