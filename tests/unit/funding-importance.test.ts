/**
 * `scoreFundingImportance` (#742) — the pure importance score that sorts active
 * funding in `loadActiveFunding`. Higher = more important. The gate the handoff
 * cares about: an NHLBI R01 PI must outrank a BioPharma Alliance Agreement Co-I.
 * No DB, no network.
 */
import { describe, expect, it } from "vitest";

import {
  scoreFundingImportance,
  type FundingImportanceInput,
} from "@/lib/edit/funding-importance";

/** A funding input with sensible defaults; override only what a case exercises. */
function grant(over: Partial<FundingImportanceInput> = {}): FundingImportanceInput {
  return {
    role: "PI",
    funder: "NCI",
    title: "Project",
    programType: "Grant",
    mechanism: "R01",
    nihIc: "NCI",
    awardNumber: "5R01CA000000-01",
    isSubaward: false,
    ...over,
  };
}

describe("scoreFundingImportance", () => {
  it("ranks an NHLBI R01 PI strictly above a BioPharma Alliance Agreement Co-I", () => {
    const r01 = grant({ role: "PI", funder: "NHLBI", nihIc: "NHLBI", mechanism: "R01" });
    const alliance = grant({
      role: "Co-I",
      funder: "Acme Therapeutics, Inc.",
      title: "Co-development alliance",
      programType: "BioPharma Alliance Agreement",
      mechanism: null,
      nihIc: null,
      awardNumber: null,
    });
    expect(scoreFundingImportance(r01)).toBeGreaterThan(scoreFundingImportance(alliance));
  });

  it("ranks an R01 PI above a K23 PI (research mechanism tier)", () => {
    const r01 = grant({ mechanism: "R01" });
    const k23 = grant({ mechanism: "K23" });
    expect(scoreFundingImportance(r01)).toBeGreaterThan(scoreFundingImportance(k23));
  });

  it("ranks PI above Co-I for an otherwise-identical grant", () => {
    const pi = grant({ role: "PI" });
    const coI = grant({ role: "Co-I" });
    expect(scoreFundingImportance(pi)).toBeGreaterThan(scoreFundingImportance(coI));
  });

  it("ranks an NIH award above an industry / company-funder award at the same role", () => {
    const nih = grant({ role: "Co-I", funder: "NCI", mechanism: "R01" });
    const company = grant({
      role: "Co-I",
      funder: "Acme Biosciences, LLC",
      programType: "Contract with funding",
      mechanism: null,
      nihIc: null,
      awardNumber: null,
    });
    expect(scoreFundingImportance(nih)).toBeGreaterThan(scoreFundingImportance(company));
  });

  it("classifies an NIH award by the award-number activity code when mechanism is null", () => {
    const fallback = grant({
      mechanism: null,
      nihIc: null,
      awardNumber: "5R01CA123456-03",
    });
    // Parsed as an R01 (NIH major, 600) + PI (50) — same as an explicit-mechanism R01 PI.
    expect(scoreFundingImportance(fallback)).toBe(scoreFundingImportance(grant({ mechanism: "R01" })));
    // …and strictly above the "otherwise" foundation tier (300) for the same role.
    const foundation = grant({
      funder: "Doris Duke Charitable Foundation",
      mechanism: null,
      nihIc: null,
      awardNumber: null,
    });
    expect(scoreFundingImportance(fallback)).toBeGreaterThan(scoreFundingImportance(foundation));
  });

  it("scores NIH center mechanisms above training/career awards", () => {
    const p30 = grant({ mechanism: "P30" });
    const t32 = grant({ mechanism: "T32" });
    expect(scoreFundingImportance(p30)).toBeGreaterThan(scoreFundingImportance(t32));
  });

  it("scores equipment purchases below every research/contract tier", () => {
    const equipment = grant({
      role: "PI",
      funder: "Internal core",
      programType: "Equipment",
      title: "Confocal microscope",
      mechanism: null,
      nihIc: null,
      awardNumber: null,
    });
    const industry = grant({
      role: "Co-I",
      funder: "Acme Pharma, Inc.",
      programType: "Contract with funding",
      mechanism: null,
      nihIc: null,
      awardNumber: null,
    });
    expect(scoreFundingImportance(equipment)).toBeLessThan(scoreFundingImportance(industry));
  });

  it("tolerates null/undefined-ish inputs without throwing", () => {
    // @ts-expect-error — exercising the defensive null guard.
    expect(scoreFundingImportance(null)).toBe(0);
    const bare = grant({
      role: "",
      funder: "",
      title: "",
      programType: "",
      mechanism: null,
      nihIc: null,
      awardNumber: null,
    });
    // Empty programType/funder/title ⇒ "otherwise" tier (300) + unknown role (5).
    expect(scoreFundingImportance(bare)).toBe(305);
  });
});
