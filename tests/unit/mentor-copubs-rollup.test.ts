import { describe, expect, it } from "vitest";

import { copubId, type CoPublicationFull } from "@/lib/api/mentoring";

function pub(overrides: Partial<CoPublicationFull>): CoPublicationFull {
  return {
    pmid: 12345678,
    title: "A study of X in Y",
    journal: "J. Test",
    year: 2024,
    doi: null,
    pmcid: null,
    volume: null,
    issue: null,
    pages: null,
    citationCount: 0,
    abstract: null,
    authors: [],
    ...overrides,
  };
}

describe("copubId (issue #189)", () => {
  it("returns the PMID as a string when available", () => {
    expect(copubId(pub({ pmid: 38670054 }))).toBe("38670054");
  });

  it("falls back to a sha1 hash when PMID is missing or zero", () => {
    const noPmidWithDoi = pub({
      pmid: 0,
      doi: "10.1234/abc.def",
      title: "Whatever",
    });
    const id = copubId(noPmidWithDoi);
    expect(id).toMatch(/^nopmid_[0-9a-f]{40}$/);
  });

  it("is deterministic across calls (DOI seed)", () => {
    const p = pub({ pmid: 0, doi: "10.1234/abc.def" });
    expect(copubId(p)).toBe(copubId(p));
  });

  it("is deterministic across calls (title seed when no PMID and no DOI)", () => {
    const p = pub({ pmid: 0, doi: null, title: "  Untitled  Preprint  " });
    const first = copubId(p);
    // Same content, different whitespace — normalization collapses spaces.
    const second = copubId(pub({ pmid: 0, doi: null, title: "Untitled Preprint" }));
    expect(first).toBe(second);
  });

  it("distinguishes different PMID-less pubs", () => {
    const a = copubId(pub({ pmid: 0, doi: "10.1/aaa" }));
    const b = copubId(pub({ pmid: 0, doi: "10.1/bbb" }));
    expect(a).not.toBe(b);
  });

  it("falls back to title when DOI is empty string", () => {
    const id = copubId(pub({ pmid: 0, doi: "", title: "Title only" }));
    expect(id).toMatch(/^nopmid_[0-9a-f]{40}$/);
  });
});
