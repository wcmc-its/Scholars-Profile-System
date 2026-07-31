/**
 * ADR-011 breadth gate — unit coverage for the pure token-coverage functions.
 * Worked examples are the ones named in the ADR itself, so a regression here
 * is a regression the ADR's own reasoning already flagged as load-bearing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  breadthGateWeight,
  classifyBreadthGate,
  contentWordCoverage,
  unconsumedAgainstForms,
  unconsumedContentTokens,
} from "@/lib/api/breadth-gate";

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

  it("a possessive 's does not fabricate a spurious extra token (Alzheimer's disease)", () => {
    expect(unconsumedContentTokens("Alzheimer's disease", "Alzheimer Disease")).toEqual([]);
    expect(contentWordCoverage("Alzheimer's disease", "Alzheimer Disease")).toBe(1);
  });

  it("diacritics fold to their base letter instead of splitting the word (Sjögren's syndrome)", () => {
    expect(unconsumedContentTokens("Sjögren's syndrome", "Sjogren Syndrome")).toEqual([]);
  });
});

describe("unconsumedAgainstForms", () => {
  it("real case: a synonym in a NON-winning entry term redeems the query (#2097)", () => {
    // "antimicrobial resistance" doesn't overlap the winning matchedForm at all,
    // but the same descriptor's entry-term list has the near-exact synonym.
    expect(
      unconsumedAgainstForms("antimicrobial resistance", [
        "Drug Resistance, Microbial",
        "Antimicrobial Drug Resistance",
      ]),
    ).toEqual([]);
  });

  it("a genuine drop survives widening — entry terms don't always cover it", () => {
    expect(
      unconsumedAgainstForms("Cardiac amyloidosis", ["Amyloidosis", "Amyloidoses"]),
    ).toEqual(["cardiac"]);
  });
});

describe("classifyBreadthGate / breadthGateWeight", () => {
  const RESOLUTION = {
    descriptorUi: "D000686",
    matchedForm: "Amyloidosis",
    name: "Amyloidosis",
    entryTerms: ["Amyloidoses"],
  };

  it("fully consumed (after widening) never calls the resolver", async () => {
    const resolveDescriptor = async () => {
      throw new Error("should not be called — nothing left unconsumed");
    };
    const verdict = await classifyBreadthGate(
      "amyloidosis",
      RESOLUTION,
      resolveDescriptor,
    );
    expect(verdict).toBe("consumed");
  });

  it("qualifier-drop — dropped span resolves to nothing on its own (real case: Cardiac amyloidosis)", async () => {
    const resolveDescriptor = async () => null;
    const verdict = await classifyBreadthGate("Cardiac amyloidosis", RESOLUTION, resolveDescriptor);
    expect(verdict).toBe("qualifier-drop");
  });

  it("scope-shift — dropped span independently resolves to a DIFFERENT descriptor (real case: AAV gene therapy)", async () => {
    const resolution = { descriptorUi: "D003982", matchedForm: "Dependovirus", name: "Dependovirus", entryTerms: [] };
    const resolveDescriptor = async () => ({ descriptorUi: "D015316" }); // Genetic Therapy — a real, different concept
    const verdict = await classifyBreadthGate("AAV gene therapy", resolution, resolveDescriptor);
    expect(verdict).toBe("scope-shift");
  });

  it("dropped span resolving back to the SAME descriptor is not a scope-shift", async () => {
    const resolveDescriptor = async () => ({ descriptorUi: RESOLUTION.descriptorUi });
    const verdict = await classifyBreadthGate("Cardiac amyloidosis", RESOLUTION, resolveDescriptor);
    expect(verdict).toBe("qualifier-drop");
  });

  it("does not join non-adjacent dropped words into a phrase the user never typed", async () => {
    // "diabetic" and "screening" are both unconsumed, but "retinopathy" (consumed)
    // sits between them in the query — they must never be joined into "diabetic screening".
    const resolution = {
      descriptorUi: "D012164",
      matchedForm: "Retinopathy",
      name: "Retinopathy",
      entryTerms: [],
    };
    const resolveDescriptor = vi.fn(async () => null);
    const verdict = await classifyBreadthGate("diabetic retinopathy screening", resolution, resolveDescriptor);
    expect(resolveDescriptor).not.toHaveBeenCalledWith("diabetic screening");
    expect(verdict).toBe("qualifier-drop");
  });

  it("breadthGateWeight: only scope-shift gets the low weight", () => {
    const weights = { wHi: 20, wLo: 3 };
    expect(breadthGateWeight("consumed", weights)).toBe(20);
    expect(breadthGateWeight("qualifier-drop", weights)).toBe(20);
    expect(breadthGateWeight("scope-shift", weights)).toBe(3);
  });
});
