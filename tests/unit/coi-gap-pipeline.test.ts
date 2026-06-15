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
  buildAuthorRoster,
  countAuthorMentions,
  deriveScholar,
  extractEntities,
  fuzzyScore,
  isCommonGivenName,
  isMultiAuthorStatement,
  initialSurnameRefs,
  isPureNegation,
  isStructured,
  looksLikeGrantId,
  looksLikeInitialsName,
  looksLikeJunkEntity,
  looksLikePersonName,
  matchesCoAuthor,
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

  it("isolates the dotted-initials form (the only person shape production suppresses)", () => {
    expect(looksLikeInitialsName("A. A. Sauve")).toBe(true);
    expect(looksLikeInitialsName("Y. Yang")).toBe(true);
    // Bare First-Last is NOT an initials name — it must not be suppressed.
    expect(looksLikeInitialsName("Scott Kasner")).toBe(false);
    expect(looksLikeInitialsName("Boston Scientific")).toBe(false);
    expect(looksLikeInitialsName("Leon Levy")).toBe(false);
  });

  it("recognizes bare First-Last co-author names (given-name gated; diagnostic sizing only)", () => {
    // Bare "First Last" — caught for diagnostic sizing, NOT for production
    // suppression (the shape collides with founder-named orgs; see analyzeStatement).
    expect(looksLikePersonName("Scott Kasner")).toBe(true);
    expect(looksLikePersonName("Wei Zhang")).toBe(true);
    expect(looksLikePersonName("Maria Gonzalez")).toBe(true);
    expect(looksLikePersonName("Daniel O'Brien")).toBe(true); // apostrophe surname
    expect(looksLikePersonName("Fatima Al-Rashid")).toBe(true); // hyphen surname
    expect(looksLikePersonName("Scott M. Kasner")).toBe(true); // First M. Last
  });

  it("does NOT mistake real companies for person names (precision)", () => {
    // First token is not a recognized given name → not a person.
    expect(looksLikePersonName("Acme Robotics")).toBe(false);
    expect(looksLikePersonName("Helix Diagnostics")).toBe(false);
    expect(looksLikePersonName("Daiichi Sankyo")).toBe(false);
    expect(looksLikePersonName("Eli Lilly")).toBe(false); // "eli" deliberately excluded
    // Given-name first token BUT an org/domain second word → still a company.
    expect(looksLikePersonName("Marcus Therapeutics")).toBe(false);
    expect(looksLikePersonName("David Biologics")).toBe(false);
    // …and the same given-name first token with a real surname IS a person.
    expect(looksLikePersonName("Marcus Kasner")).toBe(true);
  });

  it("recognizes a given name only when common and unambiguous", () => {
    expect(isCommonGivenName("Scott")).toBe(true);
    expect(isCommonGivenName("wei")).toBe(true);
    expect(isCommonGivenName("Boston")).toBe(false); // excluded — heads a company
    expect(isCommonGivenName("Eli")).toBe(false); // excluded — Eli Lilly
    expect(isCommonGivenName("Zhang")).toBe(false); // a surname, stripped at load
  });

  it("recognizes bare junk/boilerplate single words, not real companies", () => {
    expect(looksLikeJunkEntity("All")).toBe(true);
    expect(looksLikeJunkEntity("Various")).toBe(true);
    expect(looksLikeJunkEntity("Study")).toBe(true);
    expect(looksLikeJunkEntity("Travel")).toBe(true);
    // Coined single-word and multi-word real companies are NOT junk.
    expect(looksLikeJunkEntity("Genmab")).toBe(false);
    expect(looksLikeJunkEntity("Incyte")).toBe(false);
    expect(looksLikeJunkEntity("Boston Scientific")).toBe(false);
    // A real two-word org must NOT collapse to a junk token when normalizeEntity
    // strips its corporate suffix ("Royalty Pharma" -> "royalty", "Additional
    // Ventures" -> "additional"). Single-token-ness is judged on the RAW phrase.
    expect(looksLikeJunkEntity("Royalty Pharma")).toBe(false);
    expect(looksLikeJunkEntity("Additional Ventures")).toBe(false);
    expect(looksLikeJunkEntity("Various Therapeutics")).toBe(false);
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

  describe("includeSuppressed (diagnostic export only)", () => {
    const stmt = "Dr. Smith is a consultant for Pfizer Inc.";
    const smith = () => deriveScholar("John", "Smith");

    it("still drops the Low (matched-as-disclosed) entity by default", () => {
      const r = analyzeStatement(stmt, smith(), ["Pfizer"]);
      expect(r.candidates).toHaveLength(0);
      expect(r.suppressed.nearDisclosed).toBeGreaterThan(0);
    });

    it("returns the Low entity with its nearest disclosure + reason when opted in", () => {
      const r = analyzeStatement(stmt, smith(), ["Pfizer"], { includeSuppressed: true });
      expect(r.candidates).toHaveLength(1);
      const c = r.candidates[0];
      expect(c.tier).toBe("Low");
      expect(c.nearestDisclosed).toBe("Pfizer");
      expect(c.nearestScore).toBeGreaterThanOrEqual(0.6);
      expect(c.tierReason).toMatch(/disclosed/i);
      // The suppression tally is unchanged — opting in only changes what's returned.
      expect(r.suppressed.nearDisclosed).toBeGreaterThan(0);
    });
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

describe("multi-author detection", () => {
  it("counts distinct named author-subjects", () => {
    expect(countAuthorMentions("Dr. Smith is a consultant for Pfizer.")).toBe(1);
    expect(
      countAuthorMentions(
        "Scott Kasner has received funding from Bayer. Mitchell Elkind reports honoraria from Merck.",
      ),
    ).toBe(2);
  });
  it("flags ASCO blobs and ≥2-author statements as multi-author", () => {
    expect(
      isMultiAuthorStatement(
        "Scott Kasner has received funding from Bayer. Mitchell Elkind reports honoraria from Merck.",
      ),
    ).toBe(true);
    expect(isMultiAuthorStatement("Dr. Smith is a consultant for Pfizer.")).toBe(false);
  });
});

describe("analyzeStatement — multi-author unattributed suppression", () => {
  const smith = () => deriveScholar("John", "Smith");

  it("suppresses an unattributed clause when the statement names ≥2 authors", () => {
    const r = analyzeStatement(
      "Scott Kasner has received funding from Bayer. Mitchell Elkind reports honoraria from Merck. " +
        "The authors are consultants for Boston Scientific.",
      smith(),
      [],
    );
    // Boston Scientific came from an unattributed clause in a multi-author
    // statement → not confidently the scholar's → suppressed.
    expect(r.candidates.map((c) => c.entity)).not.toContain("Boston Scientific");
    expect(r.suppressed.multiAuthor).toBeGreaterThan(0);
  });

  it("still surfaces an unattributed clause in a SINGLE-author statement", () => {
    const r = analyzeStatement("The authors are consultants for Boston Scientific.", smith(), []);
    // One subject ⇒ the lone author is the scholar ⇒ the relationship is theirs.
    expect(r.candidates.map((c) => c.entity)).toContain("Boston Scientific");
    expect(r.suppressed.multiAuthor).toBe(0);
  });

  it("still surfaces a SCHOLAR-attributed clause even in a multi-author statement", () => {
    const r = analyzeStatement(
      "Scott Kasner reports fees from Bayer. Dr. Smith is a consultant for Valeant Pharmaceuticals.",
      smith(),
      [],
    );
    // The scholar is explicitly named → their relationship surfaces.
    expect(r.candidates.map((c) => c.entity)).toContain("Valeant Pharmaceuticals");
  });
});

describe("analyzeStatement — extraction-junk suppression", () => {
  const smith = () => deriveScholar("John", "Smith");

  it("suppresses a bare junk/boilerplate word, keeping the real org", () => {
    const r = analyzeStatement("Dr. Smith is a consultant for Various and for Genmab.", smith(), []);
    const entities = r.candidates.map((c) => c.entity);
    expect(entities).not.toContain("Various");
    expect(entities).toContain("Genmab"); // coined single-word company survives
    expect(r.suppressed.junkEntity).toBeGreaterThan(0);
  });

  it("does NOT suppress a real org that a naive filter would drop (precision over recall)", () => {
    // PRECISION-OVER-RECALL regression tests, each proven by the adversarial review:
    //  - eponymous/founder-named orgs share a "First Last" shape with co-authors;
    //  - "<JunkWord> <CorpSuffix>" orgs collapse to a bare junk token after the
    //    corporate-suffix strip (Royalty Pharma -> "royalty").
    // All MUST surface — hiding a real conflict is the catastrophe we avoid.
    const realOrgs = [
      "Grace Bio-Labs", "Leon Levy", "Karl Storz", "Ludwig Cancer", "Henry Schein", "Carl Zeiss",
      "Klaus Tschira", "Royalty Pharma", "Additional Ventures",
    ];
    for (const org of realOrgs) {
      const r = analyzeStatement(`Dr. Smith holds equity in ${org}.`, smith(), []);
      expect(r.candidates.length, `${org} must surface`).toBeGreaterThan(0);
      expect(r.suppressed.junkEntity, `${org} must not be junk-suppressed`).toBe(0);
    }
  });

  it("never suppresses a known gazetteer company even if it reads like a name", () => {
    // Defense in depth: a gazetteer hit is exempt from the junk guard.
    const r = analyzeStatement("Dr. Smith is a consultant for Boston Scientific.", smith(), []);
    expect(r.candidates.map((c) => c.entity)).toContain("Boston Scientific");
  });

  it("keeps real undisclosed companies surfacing (must-survive set: not junk, not initials)", () => {
    // Each is a legitimate COI org a naive filter might drop; none may be junk, and
    // none is a dotted-initials name (the only person shape production suppresses).
    const mustSurvive = [
      "Genmab", "Incyte", "Gelesis", "Vivus", "Karyopharm", "Alnylam", "Ionis", "Sarepta", "Penumbra",
      "Acme Robotics", "Helix Diagnostics", "Cerus Endovascular", "Quanta Dialysis", "Marius Pharmaceuticals",
      "Tessa Therapeutics", "Eli Lilly", "Forest Laboratories", "Edwards Lifesciences", "Daiichi Sankyo",
      "Boston Scientific", "Becton Dickinson", "Allen Institute", "Inari Medical", "Grace Bio-Labs",
      "Leon Levy", "Karl Storz",
    ];
    for (const co of mustSurvive) {
      expect(looksLikeJunkEntity(co), `${co} must not read as junk`).toBe(false);
      expect(looksLikeInitialsName(co), `${co} must not read as a dotted-initials name`).toBe(false);
    }
  });

  it("flags bare First-Last co-author names for diagnostic sizing (NOT suppression)", () => {
    // looksLikePersonName recognizes these so the diagnostic can size co-author
    // leakage — but analyzeStatement never drops them in production.
    const names = [
      "Scott Kasner", "Wei Zhang", "Rajesh Patel", "Maria Gonzalez", "Ahmed Hassan", "Jennifer Liu",
      "David Cohen", "Carlos Ramirez", "Priya Nair", "Yuki Nakamura", "Mei Chen", "Yan Li", "Jin Park",
    ];
    for (const n of names) {
      expect(looksLikePersonName(n), `${n} should read as a person name`).toBe(true);
      // …and yet it surfaces (is not suppressed) in production.
      const r = analyzeStatement(`Dr. Smith consults for ${n}.`, smith(), []);
      expect(r.candidates.map((c) => c.entity), `${n} should still surface`).toContain(n);
    }
  });

  it("returns the suppressed junk word as a Low row only under includeSuppressed", () => {
    const stmt = "Dr. Smith consults for Acme Robotics and lists Various.";
    const prod = analyzeStatement(stmt, smith(), []);
    expect(prod.candidates.map((c) => c.entity)).not.toContain("Various");

    const diag = analyzeStatement(stmt, smith(), [], { includeSuppressed: true });
    const various = diag.candidates.find((c) => /various/i.test(c.entity));
    expect(various).toBeDefined();
    expect(various!.tier).toBe("Low");
    expect(various!.failureModeGuess).toBe("junk-token");
    expect(various!.tierReason).toMatch(/junk/i);
  });
});

describe("buildAuthorRoster", () => {
  it("parses a comma-separated surname-first byline into surname → first-initials", () => {
    const roster = buildAuthorRoster("Ashworth A, Lehman C, Druker BJ, van der Berg KL");
    expect(roster.get("ashworth")?.has("A")).toBe(true);
    expect(roster.get("lehman")?.has("C")).toBe(true);
    expect(roster.get("druker")?.has("B")).toBe(true); // first initial of "BJ"
    expect(roster.get("vanderberg")?.has("K")).toBe(true); // multi-token surname collapses
  });

  it("accumulates multiple initials for a shared surname", () => {
    const roster = buildAuthorRoster("Smith J, Smith R");
    expect(roster.get("smith")).toEqual(new Set(["J", "R"]));
  });

  it("skips group/consortium and malformed entries; null/empty ⇒ empty roster", () => {
    expect(buildAuthorRoster(null).size).toBe(0);
    expect(buildAuthorRoster("").size).toBe(0);
    // "The XYZ Consortium" has no trailing initials group → skipped.
    const roster = buildAuthorRoster("The XYZ Consortium, Lehman C");
    expect(roster.has("lehman")).toBe(true);
    expect(roster.size).toBe(1);
  });

  it("accepts a pre-split list of entries", () => {
    const roster = buildAuthorRoster(["Lehman C", "Ashworth A"]);
    expect(roster.get("lehman")?.has("C")).toBe(true);
    expect(roster.get("ashworth")?.has("A")).toBe(true);
  });
});

describe("matchesCoAuthor", () => {
  const roster = buildAuthorRoster("Lehman C, Ashworth A, Druker B");

  it("matches the escaping INITIAL + surname forms (both token orders)", () => {
    expect(matchesCoAuthor("C Lehman", roster)).toBe(true); // initial-first (the documented leak)
    expect(matchesCoAuthor("Lehman C", roster)).toBe(true); // surname-first
    expect(matchesCoAuthor("A. Ashworth", roster)).toBe(true); // dotted initial
    expect(matchesCoAuthor("A Ashworth", roster)).toBe(true); // de-dotted (prose path)
  });

  it("DELIBERATELY ignores the bare 'Given Surname' shape, even on a colliding byline", () => {
    // A bare given+surname is structurally an eponymous org; matching it would drop a
    // real funder that happens to share a co-author's surname + first-initial. So it is
    // NEVER matched on shape — the founder-org regression the adversarial review caught.
    expect(matchesCoAuthor("John Leonard", buildAuthorRoster("Leonard J"))).toBe(false);
    expect(matchesCoAuthor("Carl Zeiss", buildAuthorRoster("Zeiss C"))).toBe(false);
    expect(matchesCoAuthor("Leon Levy", buildAuthorRoster("Levy L"))).toBe(false);
    expect(matchesCoAuthor("Karl Storz", buildAuthorRoster("Storz K"))).toBe(false);
  });

  it("requires the first initial to AGREE (precision guard)", () => {
    expect(matchesCoAuthor("R Lehman", roster)).toBe(false); // surname on byline, wrong initial
  });

  it("never matches an org-shaped phrase, even with a surname collision", () => {
    expect(matchesCoAuthor("Lehman Brothers", roster)).toBe(false); // "Brothers" not a byline form
    expect(matchesCoAuthor("Ashworth Therapeutics", roster)).toBe(false); // corporate word
    expect(matchesCoAuthor("Lehman Capital Partners", roster)).toBe(false); // ≥4 / org words
  });

  it("never matches a single token or a surname absent from the byline", () => {
    expect(matchesCoAuthor("Lehman", roster)).toBe(false); // single token — too ambiguous
    expect(matchesCoAuthor("C Levy", roster)).toBe(false); // Levy not on this byline
  });

  it("DOES still match an INITIAL-form org name on a collision (gated at the clause level)", () => {
    // "B. Braun" / "C. R. Bard" are initial-form orgs that DO match a colliding byline;
    // analyzeStatement protects them by never cross-checking a scholar-attributed clause.
    expect(matchesCoAuthor("B Braun", buildAuthorRoster("Braun B"))).toBe(true);
  });

  it("returns false for an empty roster", () => {
    expect(matchesCoAuthor("C Lehman", buildAuthorRoster(null))).toBe(false);
  });
});

describe("analyzeStatement — author-roster co-author cross-check", () => {
  const smith = () => deriveScholar("John", "Smith");

  it("drops an INITIAL-form co-author name in an unattributed clause, keeping the real org", () => {
    const stmt = "Consulting fees were received from C Lehman and Acme Robotics.";
    const roster = buildAuthorRoster("Smith J, Lehman C");

    // Without a roster (back-compat): the co-author name still surfaces.
    const noRoster = analyzeStatement(stmt, smith(), []);
    expect(noRoster.candidates.map((c) => c.entity)).toContain("C Lehman");
    expect(noRoster.suppressed.coauthorRoster).toBe(0);

    // With the byline: the co-author is dropped, the real org kept.
    const withRoster = analyzeStatement(stmt, smith(), [], { roster });
    const entities = withRoster.candidates.map((c) => c.entity);
    expect(entities).not.toContain("C Lehman");
    expect(entities).toContain("Acme Robotics");
    expect(withRoster.suppressed.coauthorRoster).toBeGreaterThan(0);
  });

  it("NEVER cross-checks a SCHOLAR-attributed clause — the scholar's own tie always surfaces", () => {
    // The catastrophe direction (confirmed by adversarial review): a real,
    // scholar-attributed eponymous / initial-form org must NOT be dropped just because
    // a same-surname + first-initial co-author is on the byline.
    const collisions: Array<[string, string]> = [
      ["Dr. Smith is a consultant for Karl Storz.", "Smith J, Storz K"], // given-form org
      ["Dr. Smith holds equity in Leon Levy.", "Smith J, Levy L"],
      ["Dr. Smith is a consultant for Carl Zeiss.", "Smith J, Zeiss C"],
      ["Dr. Smith is a consultant for B. Braun.", "Smith J, Braun B"], // INITIAL-form org — gate is what saves it
    ];
    for (const [stmt, byline] of collisions) {
      const r = analyzeStatement(stmt, smith(), [], { roster: buildAuthorRoster(byline) });
      expect(r.candidates.length, `${stmt} must surface the scholar's tie`).toBeGreaterThan(0);
      expect(r.suppressed.coauthorRoster, `${stmt} must not roster-suppress`).toBe(0);
    }
  });

  it("does NOT drop a founder-named org absent from the byline", () => {
    const roster = buildAuthorRoster("Smith J, Kasner S");
    const r = analyzeStatement("Dr. Smith holds equity in Leon Levy.", smith(), [], { roster });
    expect(r.candidates.map((c) => c.entity)).toContain("Leon Levy");
    expect(r.suppressed.coauthorRoster).toBe(0);
  });

  it("does NOT drop a co-author whose initial disagrees with the byline", () => {
    const roster = buildAuthorRoster("Smith J, Lehman R"); // a DIFFERENT Lehman
    const r = analyzeStatement("Consulting fees were received from C Lehman.", smith(), [], { roster });
    expect(r.candidates.map((c) => c.entity)).toContain("C Lehman");
    expect(r.suppressed.coauthorRoster).toBe(0);
  });

  it("never drops a gazetteer org even on a colliding byline", () => {
    const roster = buildAuthorRoster("Smith J, Lilly E");
    const r = analyzeStatement("Consulting fees were received from Eli Lilly.", smith(), [], { roster });
    expect(r.candidates.map((c) => c.entity)).toContain("Eli Lilly");
    expect(r.suppressed.coauthorRoster).toBe(0);
  });

  it("returns the roster-suppressed co-author as a Low row only under includeSuppressed", () => {
    const stmt = "Consulting fees were received from C Lehman.";
    const roster = buildAuthorRoster("Smith J, Lehman C");

    const prod = analyzeStatement(stmt, smith(), [], { roster });
    expect(prod.candidates.map((c) => c.entity)).not.toContain("C Lehman");

    const diag = analyzeStatement(stmt, smith(), [], { roster, includeSuppressed: true });
    const row = diag.candidates.find((c) => c.entity === "C Lehman");
    expect(row).toBeDefined();
    expect(row!.tier).toBe("Low");
    expect(row!.failureModeGuess).toBe("co-author");
    expect(row!.tierReason).toMatch(/roster cross-check/i);
  });

  it("parses a WCM ((...))-marked authorsString fallback byline (markers stripped)", () => {
    // On pubs with a null fullAuthorsString, the authorsString fallback wraps WCM
    // authors in ((...)); the surname must still enter the roster (finding #2).
    const roster = buildAuthorRoster("Brown R, ((Lehman C)), Ashworth A");
    expect(roster.get("lehman")?.has("C")).toBe(true);
    const r = analyzeStatement("Consulting fees were received from C Lehman.", smith(), [], { roster });
    expect(r.candidates.map((c) => c.entity)).not.toContain("C Lehman");
    expect(r.suppressed.coauthorRoster).toBeGreaterThan(0);
  });
});

describe("initialSurnameRefs", () => {
  it("extracts the no-honorific first-initial + surname author subject", () => {
    expect(initialSurnameRefs("A.Ashworth is a cofounder of Tango Therapeutics")).toEqual([
      { initial: "A", surname: "Ashworth" },
    ]);
    expect(initialSurnameRefs("C Lehman is a co-founder of Clairity")).toEqual([
      { initial: "C", surname: "Lehman" },
    ]);
    // segment() de-dots "A. Ashworth" → "A Ashworth"; still recognized.
    expect(initialSurnameRefs("A Ashworth has received fees from Merck")).toEqual([
      { initial: "A", surname: "Ashworth" },
    ]);
  });

  it("does not mistake an honorific name or an org for an initial-surname subject", () => {
    expect(initialSurnameRefs("Dr Smith is a consultant for Pfizer")).toEqual([]);
    expect(initialSurnameRefs("Boston Scientific provided fees to the authors")).toEqual([]);
    expect(initialSurnameRefs("The authors declare no competing interests")).toEqual([]);
  });
});

describe("attribute — roster-confirmed first-initial-surname author subject (the dominant leak)", () => {
  const tamimi = () => deriveScholar("Rulla", "Tamimi");
  const byline = () => buildAuthorRoster("Tamimi R, Ashworth A, Lehman C");

  it("attributes a confirmed co-author's no-honorific clause to OTHER", () => {
    expect(attribute("A.Ashworth is a cofounder of Tango Therapeutics", tamimi(), byline()).level).toBe("other");
    expect(attribute("C Lehman is a co-founder of Clairity", tamimi(), byline()).level).toBe("other");
  });

  it("leaves the clause unattributed without a roster (unchanged behaviour)", () => {
    expect(attribute("A.Ashworth is a cofounder of Tango Therapeutics", tamimi()).level).toBe("unattributed");
  });

  it("does not treat a company initial-name that is NOT on the byline as an author", () => {
    const r = buildAuthorRoster("Smith J, Jones A");
    expect(attribute("B Braun is a manufacturer of devices", deriveScholar("John", "Smith"), r).level).toBe(
      "unattributed",
    );
  });

  it("requires the initial to agree before attributing to a co-author", () => {
    // Byline has Ashworth A; "R Ashworth" is a different person → not attributed.
    expect(attribute("R Ashworth is a cofounder of Tango Therapeutics", tamimi(), byline()).level).toBe(
      "unattributed",
    );
  });

  it("still attributes the scholar's OWN no-honorific clause to the scholar", () => {
    // "R Tamimi" — the scholar's surname is caught by surnameHit regardless.
    expect(attribute("R Tamimi reports fees from Merck", tamimi(), byline()).level).toBe("scholar");
  });
});

describe("analyzeStatement — Tamimi-style co-author org leakage (end to end)", () => {
  it("suppresses co-authors' leaked orgs while surfacing the scholar's genuine tie", () => {
    const tamimi = deriveScholar("Rulla", "Tamimi");
    const roster = buildAuthorRoster("Tamimi R, Ashworth A, Lehman C");
    const stmt =
      "A.Ashworth is a cofounder of Tango Therapeutics. C Lehman is a co-founder of Clairity. " +
      "Dr. Tamimi is a consultant for Merck.";

    const withRoster = analyzeStatement(stmt, tamimi, [], { roster });
    const entities = withRoster.candidates.map((c) => c.entity);
    // The co-authors' orgs (and the co-author name itself) are gone…
    expect(entities).not.toContain("Tango Therapeutics");
    expect(entities).not.toContain("Clairity");
    expect(entities).not.toContain("C Lehman");
    // …and only the scholar's genuine, scholar-attributed tie remains, as High.
    expect(entities).toEqual(["Merck"]);
    expect(withRoster.candidates[0].tier).toBe("High");

    // Without the byline, the three leaked rows still surface (back-compat).
    const noRoster = analyzeStatement(stmt, tamimi, []);
    expect(noRoster.candidates.map((c) => c.entity).sort()).toEqual(
      ["C Lehman", "Clairity", "Merck", "Tango Therapeutics"].sort(),
    );
  });
});
