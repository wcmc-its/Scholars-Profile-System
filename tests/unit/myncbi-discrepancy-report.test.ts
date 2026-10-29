import { describe, expect, it } from "vitest";
import {
  authoredBy,
  compareBibliography,
  isSuspectList,
  parseMyncbiDiscrepancyParams,
  surnameKeys,
  type CitationItem,
} from "@/lib/edit/myncbi-discrepancy-report";

const c = (pmid: string, year: number | null = 2020): CitationItem => ({ pmid, title: `Paper ${pmid}`, source: "J", year });

describe("compareBibliography", () => {
  it("splits the list into matched and missing, and the profile's rest into extra", () => {
    const r = compareBibliography([c("1"), c("2", 2024), c("3", 2010)], new Set(["1", "9", "8"]));
    expect(r.listed).toBe(3);
    expect(r.matched).toBe(1);
    expect(r.missing.map((m) => m.pmid)).toEqual(["2", "3"]); // newest first
    expect(r.extraPmids).toEqual(["9", "8"]); // confirmed's order kept
  });

  it("a PMID listed twice counts once", () => {
    const r = compareBibliography([c("1"), c("1")], new Set());
    expect(r.listed).toBe(1);
    expect(r.missing).toHaveLength(1);
  });

  it("an empty list leaves everything extra, nothing missing", () => {
    const r = compareBibliography([], new Set(["5"]));
    expect([r.listed, r.matched, r.missing.length, r.extraPmids]).toEqual([0, 0, 0, ["5"]]);
  });
});

describe("surnameKeys / authoredBy", () => {
  it("takes the last word of each name, splitting hyphens and dropping suffixes", () => {
    expect(surnameKeys("Ada M Lovelace-Byron Jr.", "Ada Lovelace")).toEqual(["lovelace", "byron"]);
    expect(surnameKeys(null, "")).toEqual([]);
  });

  it("matches a surname among the authors, accent- and case-blind, hyphen parts included", () => {
    expect(authoredBy("Babbage C, Lovelace A", ["lovelace"])).toBe(true);
    expect(authoredBy("Babbage C, Byron-Lovelace AA", ["lovelace"])).toBe(true);
    expect(authoredBy("Babbage C, Lövelace A", ["lovelace"])).toBe(true);
    expect(authoredBy("Ceceli AO, Huang Y, Goldstein RZ", ["lovelace"])).toBe(false);
    // An initial is not a surname: "Lovelace" in initials position never matches "a".
    expect(authoredBy("Babbage A", ["a"])).toBe(false);
  });

  it("unknown authors or no surname to test count as authored", () => {
    expect(authoredBy(null, ["lovelace"])).toBe(true);
    expect(authoredBy("Babbage C", [])).toBe(true);
  });

  it("compareBibliography sets other people's papers apart from missing", () => {
    const by = (pmid: string, authors: string | null) => ({ ...c(pmid), authors });
    const r = compareBibliography(
      [by("1", "Lovelace A"), by("2", "Babbage C"), by("3", null), by("4", "Babbage C")],
      new Set(["4"]),
      ["lovelace"],
    );
    expect(r.missing.map((m) => m.pmid)).toEqual(["1", "3"]);
    expect(r.notAuthored.map((m) => m.pmid)).toEqual(["2"]);
    expect(r.matched).toBe(1); // a confirmed paper is matched whoever the authors are
  });
});

describe("isSuspectList", () => {
  it("flags a list mostly absent from a profile that has papers; never a short list or an empty profile", () => {
    expect(isSuspectList(298, 0, 58)).toBe(true);
    expect(isSuspectList(100, 19, 40)).toBe(true);
    expect(isSuspectList(100, 20, 40)).toBe(false);
    expect(isSuspectList(4, 0, 40)).toBe(false);
    expect(isSuspectList(100, 0, 0)).toBe(false);
  });
});

describe("parseMyncbiDiscrepancyParams", () => {
  it("defaults to missing, trims, and rejects an unknown show", () => {
    expect(parseMyncbiDiscrepancyParams({ q: "  ada ", show: "bogus", type: "full_time_faculty" })).toMatchObject({
      q: "ada",
      show: "missing",
      types: ["full_time_faculty"],
    });
    expect(parseMyncbiDiscrepancyParams({ show: "all" }).show).toBe("all");
    expect(parseMyncbiDiscrepancyParams({ show: "suspect" }).show).toBe("suspect");
  });
});
