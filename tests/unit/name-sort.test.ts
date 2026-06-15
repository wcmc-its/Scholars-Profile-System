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

  it("orders people last-name-first when used as a sort key", () => {
    const names = ["Laura Santambrogio", "Amy Chadburn", "David J. Simon", "Vered Stearns"];
    const sorted = [...names].sort(
      (a, b) =>
        extractLastNameSort(a).localeCompare(extractLastNameSort(b)) ||
        a.localeCompare(b),
    );
    expect(sorted).toEqual([
      "Amy Chadburn",
      "Laura Santambrogio",
      "David J. Simon",
      "Vered Stearns",
    ]);
  });
});
