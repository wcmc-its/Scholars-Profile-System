import { describe, expect, it } from "vitest";
import { isConfidentialTitle } from "@/lib/grant-confidentiality";

// Real titles found in prod (2026-07-31) while investigating #2020 — the
// InfoEd "Confidential" checkbox wasn't set on any of these.
const REAL_HITS = [
  "Winn CDA Contact for Dr. Rohit Jain",
  "Satlin/Weill Cornell & Duke University CDA",
  "CDA COVID Supplement Application",
  "Randomized multicenter phase II trial of neoadjuvant chemotherapy plus cemiplimab vs SBRT 8Gy x 3 plus cemiplimab for c-stage IB-IIIA/IIIB (resectable) NSCLC (2024 Winn CDA)",
  "Medpace, Inc and Dr.Zachary Grinspan Weill Cornell Medicine Non-Disclosure and Confidentiality Agreement - US",
  "Scherr AstraZeneca CDA Durvalumab in combination with other agents as perioperative therapy for the treatment of muscle invasive bladder cancer in cisplatin-ineligible patients",
  "Dr. Rafii NDA with Pluristem",
  "Data Confidentiality Agreement for NYU HEAL",
  "CDA / Consulting Agreement - BL MELANIS CO., LTD",
  "Strategies to delete HIV reservoir (CDA w/ ViiV)",
  "Confidential Disclosure Agreement",
  "Confidentiality Agreement - JCTO \"20140346\"",
  "CDA with Grail",
  "NDA - Vanishing Twin Study",
  "JCOIN Friends Non-disclosure Agreement",
  "Genetic Cures for Kids NDA with Dr.Zach Grinspan",
  "CONFIDENTIAL DISCLOSURE AGREEMENT Epygenix Therapeutics, Inc., and Dr.Zachary Grinspan, MD MS,",
];

// Real titles found in the same sweep that must NOT match — a naive
// substring check on "cda"/"nda" would have false-positived on all of these.
const FALSE_POSITIVES = [
  "The LUCINDA Trial",
  "Characterization of CDADC1, a Putative CTP Deaminase Co-deleted with RB1 in Bladder Cancer",
  "Omuyambi: Traditional Healer Support to Improve HIV Viral Suppression in Rural Uganda - Foreign Subsite Supplement",
  "Biopharma Agreement with NeuroVanda Therapeutics",
  "Research Collaboration Agreement Between Linda Vahdat and Vivek Mittal",
  "Exploring Telehealth Practices to Enhance Safety, Confidentiality, and Privacy for Domestic Violence  and Gender-Based Violence (DV/GBV) Survivors",
];

describe("isConfidentialTitle (#2020)", () => {
  it.each(REAL_HITS)("flags %s", (title) => {
    expect(isConfidentialTitle(title)).toBe(true);
  });

  it.each(FALSE_POSITIVES)("does not flag %s", (title) => {
    expect(isConfidentialTitle(title)).toBe(false);
  });

  it("handles null/undefined/empty", () => {
    expect(isConfidentialTitle(null)).toBe(false);
    expect(isConfidentialTitle(undefined)).toBe(false);
    expect(isConfidentialTitle("")).toBe(false);
  });
});
