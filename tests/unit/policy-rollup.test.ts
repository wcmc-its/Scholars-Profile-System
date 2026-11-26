import { describe, expect, it } from "vitest";
import { authorityBadgeLabel, parseLocations, toPolicyRollup } from "@/lib/citations/policy-rollup";

describe("policy rollup", () => {
  it("is null when nothing cites the paper", () => {
    expect(toPolicyRollup({ authorityBodies: null, guidelineCount: 0, reviewCount: 0 })).toBeNull();
  });

  it("keeps well-formed authority bodies and drops anything else", () => {
    expect(
      toPolicyRollup({
        authorityBodies: [{ body: "WHO", count: 4 }, { body: "NICE" }, "junk", null],
        guidelineCount: 9,
        reviewCount: 6,
      }),
    ).toEqual({ authority: [{ body: "WHO", count: 4 }], guidelines: 9, reviews: 6 });
  });

  it("labels badges by body and count", () => {
    expect(authorityBadgeLabel("WHO", 4)).toBe("Cited in 4 WHO guidelines");
    expect(authorityBadgeLabel("National Academies", 1)).toBe("National Academies report");
  });
});

describe("parseLocations", () => {
  const page = "https://www.ncbi.nlm.nih.gov/books/NBK000001/";
  it("drops a bare chapter link when a section of that page is listed, and repeated labels", () => {
    const stored = [
      { url: `${page}#sec1`, label: "Results" },
      { url: page, label: "Table" },
      { url: `${page}#sec2`, label: "Discussion" },
      { url: "https://www.ncbi.nlm.nih.gov/books/NBK000002/", label: "References" },
      { url: "https://www.ncbi.nlm.nih.gov/books/NBK000003/", label: "references" },
      { url: "https://example.org/x", label: "Elsewhere" },
    ];
    const want = [
      { url: `${page}#sec1`, label: "Results" },
      { url: `${page}#sec2`, label: "Discussion" },
      { url: "https://www.ncbi.nlm.nih.gov/books/NBK000002/", label: "References" },
    ];
    expect(parseLocations(stored)).toEqual(want);
    expect(parseLocations(JSON.stringify(stored))).toEqual(want);
    expect(parseLocations("not json")).toEqual([]);
    expect(parseLocations(null)).toEqual([]);
  });
});
