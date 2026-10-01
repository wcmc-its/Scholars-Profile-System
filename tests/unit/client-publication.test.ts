import { describe, expect, it } from "vitest";
import { toClientPublication } from "@/lib/profile/client-publication";

describe("toClientPublication (#2213)", () => {
  it("drops the server-only ranking fields and keeps every rendered field", () => {
    const pub = {
      pmid: "1",
      title: "T",
      authorsString: "A B",
      journal: "J",
      year: 2020,
      publicationType: "Academic Article",
      citationCount: 3,
      reciteraiImpact: 42,
      dateAddedToEntrez: new Date("2020-01-01"),
      doi: null,
      pmcid: null,
      pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/1/",
      ecommonsLink: null,
      authorship: { isFirst: true, isLast: false, isPenultimate: false },
      isConfirmed: true,
      meshTerms: [{ ui: "D1", label: "L" }],
      hasAbstract: true,
      wcmAuthors: [],
      score: 0.5,
    };
    const out = toClientPublication(pub);
    for (const k of ["dateAddedToEntrez", "reciteraiImpact", "isConfirmed", "score"]) {
      expect(out).not.toHaveProperty(k);
    }
    const {
      dateAddedToEntrez: _d,
      reciteraiImpact: _r,
      isConfirmed: _c,
      score: _s,
      ...rendered
    } = pub;
    expect(out).toEqual(rendered);
  });
});
