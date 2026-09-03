/**
 * #2580 — the shared citation string logic the four Vancouver builders now
 * import instead of each keeping its own copy.
 *
 * The mutation-sensitive case is the literal `"NULL"` string: the columns are
 * `String? @db.VarChar` and some rows carry the four-character word rather than
 * a SQL NULL, so the old `if (volume)` guard passed it straight through and a
 * downloaded CV read `2024;NULL(NULL):NULL.`. Every assertion below on `"NULL"`
 * fails against that guard.
 */
import { describe, it, expect } from "vitest";
import { citationIdentifier, formatVolIssuePages } from "@/lib/citation";

describe("formatVolIssuePages", () => {
  it("assembles NLM punctuation from the pieces that are present", () => {
    expect(formatVolIssuePages("83", "4", "500-510")).toBe("83(4):500-510");
    expect(formatVolIssuePages("83", null, null)).toBe("83");
    expect(formatVolIssuePages(null, "Suppl 1", null)).toBe("(Suppl 1)");
    expect(formatVolIssuePages(null, null, "S5")).toBe(":S5");
    expect(formatVolIssuePages("83", null, "500-510")).toBe("83:500-510");
  });

  it("returns '' when nothing is present, so the caller prints the year alone", () => {
    expect(formatVolIssuePages(null, null, null)).toBe("");
    expect(formatVolIssuePages(undefined, undefined, undefined)).toBe("");
  });

  it("treats the literal string 'NULL' as absent, in any casing (#2580)", () => {
    // The whole defect: these are truthy strings, so the old falsy-only guard
    // emitted them verbatim into the document.
    expect(formatVolIssuePages("NULL", "NULL", "NULL")).toBe("");
    expect(formatVolIssuePages("null", "Null", "nUlL")).toBe("");
    // A real value survives alongside a "NULL" sibling — the block is not
    // discarded wholesale.
    expect(formatVolIssuePages("83", "NULL", "500-510")).toBe("83:500-510");
    expect(formatVolIssuePages("NULL", "4", null)).toBe("(4)");
  });

  it("treats whitespace-only as absent and trims what survives", () => {
    expect(formatVolIssuePages("   ", "\t", " ")).toBe("");
    expect(formatVolIssuePages(" 83 ", " 4 ", " 500-510 ")).toBe("83(4):500-510");
  });

  it("does NOT sweep in other absent-looking values", () => {
    // Deliberately narrow — a page range or volume could legitimately look
    // like one of these, and no evidence says the corpus uses them.
    expect(formatVolIssuePages("N/A", null, null)).toBe("N/A");
    expect(formatVolIssuePages(null, null, "-")).toBe(":-");
    expect(formatVolIssuePages("0", null, null)).toBe("0");
  });
});

describe("citationIdentifier", () => {
  it("labels and hyperlinks a real PubMed id", () => {
    expect(citationIdentifier("38670054")).toEqual({
      label: "PMID",
      value: "38670054",
      href: "https://pubmed.ncbi.nlm.nih.gov/38670054/",
    });
  });

  it("labels a source-prefixed external id by its source, with NO PubMed link", () => {
    // The reported defect: this used to render "PMID: SCOPUS:105037533819" and,
    // in the .docx builders, a dead pubmed.ncbi link around it.
    expect(citationIdentifier("SCOPUS:105037533819")).toEqual({
      label: "Scopus",
      value: "105037533819",
      href: null,
    });
    expect(citationIdentifier("OPENALEX:W2741809807")).toEqual({
      label: "OpenAlex",
      value: "W2741809807",
      href: null,
    });
    expect(citationIdentifier("WOS:000123456")).toEqual({
      label: "Web of Science",
      value: "000123456",
      href: null,
    });
  });

  it("names an unrecognised prefix generically rather than guessing", () => {
    expect(citationIdentifier("FOO:1")).toEqual({ label: "External", value: "1", href: null });
  });

  it("never surfaces the churn-prone synthetic negative pmid", () => {
    // ReciterDB recomputes it on every rebuild; it is an internal key, not a
    // citable id. The co-pubs routes carry pmid as a number, hence both forms.
    expect(citationIdentifier(-3)).toEqual({ label: "Source", value: "External", href: null });
    expect(citationIdentifier("-3")).toEqual({ label: "Source", value: "External", href: null });
  });

  it("accepts a numeric PubMed pmid (the co-pubs routes' shape)", () => {
    expect(citationIdentifier(38670054)).toEqual({
      label: "PMID",
      value: "38670054",
      href: "https://pubmed.ncbi.nlm.nih.gov/38670054/",
    });
  });
});
