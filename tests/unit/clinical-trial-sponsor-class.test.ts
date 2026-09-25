import { describe, expect, it } from "vitest";

import {
  isSponsorClass,
  sponsorClassFromCtgov,
  sponsorClassFromOncore,
  sponsorClassLabel,
} from "@/lib/clinical-trial-sponsor-class";

describe("sponsorClassFromCtgov", () => {
  it.each([
    ["INDUSTRY", "industry"],
    ["NIH", "nih"],
    ["FED", "federal"],
    ["NETWORK", "network"],
    ["OTHER", "academic"],
    ["OTHER_GOV", "other"],
    ["INDIV", "other"],
    ["industry", "industry"],
  ])("%s → %s", (raw, want) => {
    expect(sponsorClassFromCtgov(raw)).toBe(want);
  });

  it("AMBIG, UNKNOWN, junk and missing are null", () => {
    for (const raw of ["AMBIG", "UNKNOWN", "", "nonsense", null, undefined]) {
      expect(sponsorClassFromCtgov(raw)).toBeNull();
    }
  });
});

describe("sponsorClassFromOncore", () => {
  it.each([
    ["National Cancer Institute (NCI)", "nih"],
    ["NIH/NHLBI", "nih"],
    ["Department of Defense", "federal"],
    ["U.S. Food and Drug Administration", "federal"],
    ["NRG Oncology", "network"],
    ["Alliance for Clinical Trials in Oncology", "network"],
    ["SWOG Cancer Research Network", "network"],
    ["Children's Oncology Group", "network"],
    ["Genentech, Inc.", "industry"],
    ["IDEAYA Biosciences", "industry"],
    ["Merck Sharp & Dohme LLC", "industry"],
    ["Weill Cornell Medicine", "academic"],
    ["Memorial Sloan Kettering Cancer Center", "academic"],
    ["Columbia University", "academic"],
    ["Leukemia & Lymphoma Society", "other"],
    ["Conquer Cancer Foundation", "other"],
  ])("%s → %s", (name, want) => {
    expect(sponsorClassFromOncore(name)).toBe(want);
  });

  it("returns null for blanks and names it cannot place", () => {
    expect(sponsorClassFromOncore(null)).toBeNull();
    expect(sponsorClassFromOncore("  ")).toBeNull();
    expect(sponsorClassFromOncore("Dr. Jane Smith")).toBeNull();
  });
});

describe("labels", () => {
  it("labels every class, network as the mockup's Cooperative group, null as Unknown", () => {
    expect(sponsorClassLabel("industry")).toBe("Industry");
    expect(sponsorClassLabel("network")).toBe("Cooperative group");
    expect(sponsorClassLabel("federal")).toBe("Other federal");
    expect(sponsorClassLabel(null)).toBe("Unknown");
    expect(sponsorClassLabel("bogus")).toBe("Unknown");
  });

  it("isSponsorClass accepts only the six keys", () => {
    expect(isSponsorClass("academic")).toBe(true);
    expect(isSponsorClass("unknown")).toBe(false);
    expect(isSponsorClass(null)).toBe(false);
  });
});
