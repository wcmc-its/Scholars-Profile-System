import { describe, it, expect } from "vitest";
import { extractLastNameSort } from "@/lib/name-sort";

describe("extractLastNameSort", () => {
  it("takes the surname token from 'Given … Last'", () => {
    expect(extractLastNameSort("Laura Santambrogio")).toBe("santambrogio");
    expect(extractLastNameSort("David J. Simon")).toBe("simon");
    expect(extractLastNameSort("Anna C Pavlick")).toBe("pavlick");
    expect(extractLastNameSort("Minerva A Romero Arenas")).toBe("arenas");
  });

  it("strips generational/honorific suffixes", () => {
    expect(extractLastNameSort("John Smith Jr")).toBe("smith");
    expect(extractLastNameSort("Jane Doe III")).toBe("doe");
    expect(extractLastNameSort("Sam Roe Esq")).toBe("roe");
  });

  it("handles single-token and empty names", () => {
    expect(extractLastNameSort("Madonna")).toBe("madonna");
    expect(extractLastNameSort("")).toBe("");
    expect(extractLastNameSort("   ")).toBe("");
  });

  it("strips a ' - <Department>' name-collision disambiguation suffix (#2049)", () => {
    expect(extractLastNameSort("Alessandro Fichera - Surgery")).toBe("fichera");
    expect(extractLastNameSort("Jesse Codner - Cardiothoracic Surgery")).toBe(
      "codner",
    );
    // Hyphenated surnames with no surrounding spaces are untouched.
    expect(extractLastNameSort("Mary Smith-Jones")).toBe("smith-jones");
  });

  it("strips a trailing ' (<Unit>)' disambiguation suffix (#2214)", () => {
    expect(extractLastNameSort("Jane Doe (Radiology)")).toBe("doe");
    expect(extractLastNameSort("Jane Doe (Pediatric Surgery)")).toBe("doe");
    // Whitespace either side of the parenthetical is tolerated.
    expect(extractLastNameSort("Jane Doe  (Radiology)  ")).toBe("doe");
    // Generational suffix BEHIND the parenthetical still strips.
    expect(extractLastNameSort("John Smith Jr (Surgery)")).toBe("smith");
    // Both disambiguation forms, nesting either way round.
    expect(extractLastNameSort("Jane Doe (Surgery - Cardiothoracic)")).toBe("doe");
    expect(extractLastNameSort("Jane Doe (Radiology) - Medicine")).toBe("doe");
  });

  /**
   * #2214's blast radius: OpenSearch keyword sort is byte order and "(" (0x28)
   * precedes "a" (0x61), so ANY key that keeps the parenthesis takes row 1 of
   * the A–Z browse ahead of every real surname. Assert the property, not just
   * the one string.
   */
  it("never emits a key that would sort ahead of every surname (#2214)", () => {
    for (const n of [
      "Jane Doe (Radiology)",
      "John Smith Jr (Surgery)",
      "Jane Doe (Surgery - Cardiothoracic)",
    ]) {
      const key = extractLastNameSort(n);
      expect(key.startsWith("(")).toBe(false);
      expect(key < "a").toBe(false);
    }
  });

  it("leaves genuine name particles and non-trailing parentheses alone", () => {
    // Particles are not special-cased — the anchor is the last token.
    expect(extractLastNameSort("Vincent van Gogh")).toBe("gogh");
    expect(extractLastNameSort("Robert De Niro")).toBe("niro");
    expect(extractLastNameSort("Ana del Rio")).toBe("rio");
    expect(extractLastNameSort("Juan de la Cruz")).toBe("cruz");
    // Apostrophes and hyphens are part of the surname token.
    expect(extractLastNameSort("Sinead O'Connor")).toBe("o'connor");
    expect(extractLastNameSort("Mary Smith-Jones")).toBe("smith-jones");
    expect(extractLastNameSort("Jean-Luc Picard")).toBe("picard");
    expect(extractLastNameSort("Ana Rodriguez-Garcia (Medicine)")).toBe("rodriguez-garcia");
    // A parenthetical that is NOT trailing is a nickname, not a unit.
    expect(extractLastNameSort("John (Jack) Smith")).toBe("smith");
  });

  it("orders people last-name-first when used as a sort key", () => {
    const names = [
      "Laura Santambrogio",
      "Amy Chadburn",
      "David J. Simon",
      "Vered Stearns",
      // #2214 — sorts under "R", not at row 1.
      "Nina Reyes (Radiology)",
    ];
    const sorted = [...names].sort(
      (a, b) =>
        extractLastNameSort(a).localeCompare(extractLastNameSort(b)) ||
        a.localeCompare(b),
    );
    expect(sorted).toEqual([
      "Amy Chadburn",
      "Nina Reyes (Radiology)",
      "Laura Santambrogio",
      "David J. Simon",
      "Vered Stearns",
    ]);
  });
});
