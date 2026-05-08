import { describe, expect, it } from "vitest";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";

describe("canonicalizeSponsor — exact / alias", () => {
  it("resolves canonical short names directly", () => {
    expect(canonicalizeSponsor("NCI")).toBe("NCI");
    expect(canonicalizeSponsor("nci")).toBe("NCI");
    expect(canonicalizeSponsor("  NCI  ")).toBe("NCI");
  });

  it("resolves curated aliases to the canonical short", () => {
    expect(canonicalizeSponsor("Bristol-Myers Squibb")).toBe("BMS");
    expect(canonicalizeSponsor("GlaxoSmithKline")).toBe("GSK");
  });
});

describe("canonicalizeSponsor — full-name and normalized matching", () => {
  it("resolves full names to canonical shorts", () => {
    expect(canonicalizeSponsor("National Cancer Institute")).toBe("NCI");
    expect(canonicalizeSponsor("Ovarian Cancer Research Alliance")).toBe("OCRA");
  });

  it("strips trailing legal suffixes", () => {
    expect(canonicalizeSponsor("Pfizer Inc.")).toBe("Pfizer");
    expect(canonicalizeSponsor("AstraZeneca PLC")).toBe("AstraZeneca");
    expect(canonicalizeSponsor("Genentech, Inc.")).toBe("Genentech");
    expect(canonicalizeSponsor("Eli Lilly and Company")).toBe("Eli Lilly");
  });

  it("strips a leading 'The'", () => {
    expect(canonicalizeSponsor("The Wellcome Trust")).toBe("Wellcome");
  });

  it("collapses internal whitespace", () => {
    expect(canonicalizeSponsor("  National   Cancer   Institute  ")).toBe("NCI");
  });
});

describe("canonicalizeSponsor — InfoEd quirks (issue #78 follow-up)", () => {
  it("treats '&' the same as 'and' in full names", () => {
    expect(canonicalizeSponsor("National Institute of Allergy & Infectious Diseases")).toBe("NIAID");
    expect(canonicalizeSponsor("National Heart, Lung, & Blood Institute")).toBe("NHLBI");
    expect(canonicalizeSponsor("National Institute of Neurological Disorders & Stroke")).toBe("NINDS");
    expect(canonicalizeSponsor("National Institute of Diabetes & Digestive & Kidney Diseases")).toBe("NIDDK");
    expect(canonicalizeSponsor("National Institute of Child Health & Human Development")).toBe("NICHD");
    expect(canonicalizeSponsor("National Institute of Biomedical Imaging & Bioengineering")).toBe("NIBIB");
  });

  it("strips a leading 'United States ' prefix", () => {
    expect(canonicalizeSponsor("United States Department of Defense")).toBe("DOD");
  });

  it("strips trailing /NIH/DHHS suffixes", () => {
    expect(canonicalizeSponsor("National Eye Institute/NIH/DHHS")).toBe("NEI");
  });

  it("resolves NIH OD with the long-form alias", () => {
    expect(canonicalizeSponsor("National Institutes of Health, Office of the Director")).toBe("OD");
  });

  it("resolves the new foundation entries", () => {
    expect(canonicalizeSponsor("American Italian Cancer Foundation")).toBe("AICF");
    expect(canonicalizeSponsor("Pershing Square Sohn Cancer Research Alliance, The")).toBe(
      "Pershing Square Sohn",
    );
  });
});

describe("canonicalizeSponsor — fall-through", () => {
  it("returns null for sponsors not in the canonical lookup", () => {
    expect(canonicalizeSponsor("Some Tiny Family Foundation")).toBeNull();
    expect(canonicalizeSponsor("XYZ Holdings, LLC")).toBeNull();
  });

  it("returns null for empty / null / undefined input", () => {
    expect(canonicalizeSponsor(null)).toBeNull();
    expect(canonicalizeSponsor(undefined)).toBeNull();
    expect(canonicalizeSponsor("")).toBeNull();
    expect(canonicalizeSponsor("   ")).toBeNull();
  });
});
