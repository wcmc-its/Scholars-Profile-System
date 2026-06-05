/**
 * Tests for lib/coi-gap/pipeline.ts — the COI-gap detection core.
 *
 * Focus is the correctness guards that keep the confidence meaningful and stop
 * false accusations: author attribution (initials in author-ref position, exact
 * match), ASCO multi-author blob slicing, co-author / home-institution / grant-id
 * suppression, funder-clause classification, and recall-biased normalization.
 * Fixtures use real PubMed statement shapes (paraphrased) observed in the 2022
 * corpus during the Phase 0 Track-A validation.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeStatement,
  attribute,
  deriveScholar,
  extractEntities,
  fuzzyScore,
  isPureNegation,
  isStructured,
  looksLikeGrantId,
  looksLikePersonName,
  normalizeEntity,
  scholarSlice,
} from "@/lib/coi-gap/pipeline";

describe("deriveScholar", () => {
  it("derives first+last initials and a surname matcher", () => {
    const s = deriveScholar("John", "Smith");
    expect(s.surname).toBe("Smith");
    expect(s.initials).toBe("JS");
    expect(s.initialsAlt).toBe("SJ");
    expect(s.surnameRe?.test("Dr. Smith reports fees")).toBe(true);
  });
  it("handles empty names", () => {
    const s = deriveScholar(null, "");
    expect(s.surname).toBe("");
    expect(s.surnameRe).toBeNull();
  });
});

describe("isPureNegation", () => {
  it("treats boilerplate disclosures as negation", () => {
    expect(isPureNegation("The authors declare no competing interests.")).toBe(true);
    expect(isPureNegation("No competing interests were disclosed.")).toBe(true);
    expect(isPureNegation("The authors have nothing to disclose.")).toBe(true);
    expect(isPureNegation("")).toBe(true);
  });
  it("does not treat a real disclosure as negation", () => {
    expect(isPureNegation("Dr. Smith is a consultant for Pfizer.")).toBe(false);
  });
});

describe("helper predicates", () => {
  it("recognizes grant identifiers", () => {
    expect(looksLikeGrantId("K23 HL140199")).toBe(true);
    expect(looksLikeGrantId("R01CA123456")).toBe(true);
    expect(looksLikeGrantId("Pfizer")).toBe(false);
  });
  it("recognizes person names", () => {
    expect(looksLikePersonName("A. A. Sauve")).toBe(true);
    expect(looksLikePersonName("Y. Yang")).toBe(true);
    expect(looksLikePersonName("Boston Scientific")).toBe(false);
  });
  it("normalizes entities by stripping legal suffixes", () => {
    expect(normalizeEntity("Pfizer Inc.")).toBe("pfizer");
    expect(normalizeEntity("Bristol-Myers Squibb Company")).toBe("bristol myers squibb");
  });
  it("fuzzy-matches entity variants", () => {
    expect(fuzzyScore("Pfizer Inc", "Pfizer")).toBe(1);
    expect(fuzzyScore("Boston Scientific Corporation", "Boston Scientific")).toBeGreaterThan(0.6);
    expect(fuzzyScore("Pfizer", "Merck")).toBe(0);
  });
});

describe("attribution", () => {
  const saxena = deriveScholar("Ashish", "Saxena"); // initials AS

  it("attributes a clause to the scholar by surname", () => {
    const a = attribute("Dr. Jesudian is a consultant to Valeant.", deriveScholar("Arun", "Jesudian"));
    expect(a.level).toBe("scholar");
  });

  it("attributes by exact initials in author-ref position", () => {
    const a = attribute("A.P.: consulting role: Bristol Myers Squibb", deriveScholar("Anna", "Pavlick"));
    expect(a.level).toBe("scholar");
  });

  it("does NOT mistake a sponsor-list token (HalioDx SAS) for the scholar's initials", () => {
    // The clause is another author's (JT) disclosure; "SAS" must not read as "AS".
    const a = attribute("JT has received fees from Pfizer, Genentech and HalioDx SAS.", saxena);
    expect(a.level).toBe("other");
  });

  it("flags a clause naming a different author as other", () => {
    const a = attribute("SMM has received consulting fees from Boston Scientific.", saxena);
    expect(a.level).toBe("other");
  });
});

describe("structured ASCO/ICMJE blobs", () => {
  const blob =
    "Eleni Andreopoulou Honoraria: AstraZeneca, AbbVie Consulting or Advisory Role: Eisai " +
    "Kevin Holcomb Research Funding: Fujirebio Diagnostics";

  it("detects a structured multi-author blob", () => {
    expect(isStructured(blob)).toBe(true);
  });

  it("slices out only the scholar's own section", () => {
    const slice = scholarSlice(blob, deriveScholar("Eleni", "Andreopoulou"));
    expect(slice).toContain("Andreopoulou");
    expect(slice).toContain("AstraZeneca");
    expect(slice).not.toContain("Kevin Holcomb"); // next author's section excluded
  });

  it("surfaces the scholar's orgs and NOT a co-author's", () => {
    const r = analyzeStatement(blob, deriveScholar("Eleni", "Andreopoulou"), []);
    const entities = r.candidates.map((c) => c.entity);
    expect(entities).toContain("AstraZeneca");
    expect(entities).toContain("AbbVie");
    expect(entities).not.toContain("Fujirebio Diagnostics"); // belongs to Kevin Holcomb
  });
});

describe("analyzeStatement — end to end", () => {
  it("returns nothing for a pure-negation statement", () => {
    const r = analyzeStatement("The authors declare no competing interests.", deriveScholar("John", "Smith"), []);
    expect(r.isNegation).toBe(true);
    expect(r.candidates).toHaveLength(0);
  });

  it("surfaces a High candidate for a clean scholar-attributed disclosure", () => {
    const r = analyzeStatement(
      "Dr. Jesudian is a consultant to Valeant Pharmaceuticals.",
      deriveScholar("Arun", "Jesudian"),
      [],
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      entity: "Valeant Pharmaceuticals",
      tier: "High",
      attribution: "scholar",
      category: "personal",
    });
  });

  it("surfaces High candidates via exact initials attribution", () => {
    const r = analyzeStatement(
      "A.P.: consulting or advisory role: Bristol Myers Squibb, Regeneron",
      deriveScholar("Anna", "Pavlick"),
      [],
    );
    const entities = r.candidates.map((c) => c.entity);
    expect(entities).toContain("Bristol Myers Squibb");
    expect(entities).toContain("Regeneron");
    expect(r.candidates.every((c) => c.attribution === "scholar")).toBe(true);
  });

  it("SUPPRESSES a co-author's disclosure list (the dominant false positive)", () => {
    const r = analyzeStatement(
      "JT has received fees for consultancy from Pfizer, Genentech and HalioDx SAS.",
      deriveScholar("Ashish", "Saxena"),
      [],
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.suppressed.coauthor).toBeGreaterThan(0);
  });

  it("never surfaces a grant identifier and classes grant funding as funder", () => {
    const r = analyzeStatement(
      "Dr. Podolanczuk is supported by NIH grant K23 HL140199 and a grant from the American Lung Association.",
      deriveScholar("Anna", "Podolanczuk"),
      [],
    );
    expect(r.candidates.map((c) => c.entity).join(" ")).not.toMatch(/K23|HL140199/);
    expect(r.suppressed.funderEmployer).toBeGreaterThan(0);
  });

  it("never surfaces the scholar's home institution", () => {
    const r = analyzeStatement(
      "A.A. Sauve has filed a patent in conjunction with Cornell University.",
      deriveScholar("Anthony", "Sauve"),
      [],
    );
    expect(r.candidates.map((c) => c.entity).join(" ")).not.toMatch(/Cornell/);
  });

  it("suppresses an entity already in the disclosed set (recall-biased)", () => {
    const r = analyzeStatement("Dr. Smith is a consultant for Pfizer Inc.", deriveScholar("John", "Smith"), ["Pfizer"]);
    expect(r.candidates).toHaveLength(0);
    expect(r.suppressed.nearDisclosed).toBeGreaterThan(0);
  });

  it("classifies institutional research support (even a named pharma) as funder, not a personal gap", () => {
    const r = analyzeStatement(
      "Dr. Siegler has received research support from Gilead.",
      deriveScholar("Eugenia", "Siegler"),
      [],
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.suppressed.funderEmployer).toBeGreaterThan(0);
  });

  it("uses an injected canonicalizer to collapse a variant onto a disclosed entity", () => {
    const canonicalize = (s: string) => (/pfizer/i.test(s) ? "Pfizer" : null);
    const r = analyzeStatement(
      "Dr. Smith is a consultant for Pfizer Pharmaceuticals International.",
      deriveScholar("John", "Smith"),
      ["Pfizer Inc"],
      { canonicalize },
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.suppressed.nearDisclosed).toBeGreaterThan(0);
  });

  it("dedupes repeated entities within a statement, keeping the highest tier", () => {
    const r = analyzeStatement(
      "Dr. Smith is a consultant for Boston Scientific. Boston Scientific provided fees to Dr. Smith.",
      deriveScholar("John", "Smith"),
      [],
    );
    const bs = r.candidates.filter((c) => c.normalized === normalizeEntity("Boston Scientific"));
    expect(bs).toHaveLength(1);
  });
});

describe("extractEntities", () => {
  it("extracts a gazetteer company under a personal cue", () => {
    const ents = extractEntities("Dr. Smith is a consultant for Pfizer.");
    expect(ents.some((e) => e.raw === "Pfizer" && e.cat === "personal")).toBe(true);
  });
  it("classifies a gazetteer company under a funder cue as funder", () => {
    const ents = extractEntities("received research support from Gilead");
    expect(ents.some((e) => e.raw === "Gilead" && e.cat === "funder")).toBe(true);
  });
});
