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

  it("OTHER led by Weill Cornell is WCM (investigator-initiated); other OTHER stays academic", () => {
    expect(sponsorClassFromCtgov("OTHER", "Weill Medical College of Cornell University")).toBe(
      "wcm",
    );
    expect(sponsorClassFromCtgov("OTHER", "Weill Cornell Medicine")).toBe("wcm");
    expect(sponsorClassFromCtgov("OTHER", "Memorial Sloan Kettering Cancer Center")).toBe(
      "academic",
    );
    expect(sponsorClassFromCtgov("OTHER", "Cornell University")).toBe("academic");
    expect(sponsorClassFromCtgov("OTHER", null)).toBe("academic");
    // Only OTHER is re-read by name: a WCM-named INDUSTRY lead stays industry.
    expect(sponsorClassFromCtgov("INDUSTRY", "Weill Cornell Medicine")).toBe("industry");
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
    ["Weill Cornell Medicine", "wcm"],
    ["Weill Medical College of Cornell University", "wcm"],
    ["WCMC", "wcm"],
    ["Memorial Sloan Kettering Cancer Center", "academic"],
    ["Columbia University", "academic"],
    ["Leukemia & Lymphoma Society", "academic"],
    ["Conquer Cancer Foundation", "academic"],
    // Non-profits whose legal name carries a company suffix are not Industry.
    ["American Cancer Society, Inc.", "academic"],
    ["The Leukemia & Lymphoma Society, Inc.", "academic"],
    ["Prostate Cancer Foundation Inc", "academic"],
    // "pharma" only as a word: a pharmacology department is not a company.
    ["Weill Cornell Medicine Department of Pharmacology", "wcm"],
    ["Columbia University Department of Pharmacology", "academic"],
    ["Jazz Pharmaceuticals", "industry"],
    ["Acme Pharma", "industry"],
    // The Canadian cooperative group is not NIH.
    ["National Cancer Institute of Canada Clinical Trials Group", "network"],
    ["NCIC Clinical Trials Group", "network"],
    ["Canadian Cancer Trials Group", "network"],
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

  it("labels wcm with the mockup's WCM (investigator-initiated)", () => {
    expect(sponsorClassLabel("wcm")).toBe("WCM (investigator-initiated)");
  });

  it("isSponsorClass accepts only the seven keys", () => {
    expect(isSponsorClass("academic")).toBe(true);
    expect(isSponsorClass("wcm")).toBe(true);
    expect(isSponsorClass("unknown")).toBe(false);
    expect(isSponsorClass(null)).toBe(false);
  });
});
