import { describe, expect, it } from "vitest";

import { formatProgramLabel } from "@/lib/mentoring-labels";

describe("formatProgramLabel", () => {
  it("collapses AOC variants to 'MD mentee'", () => {
    expect(formatProgramLabel("AOC")).toBe("MD mentee");
    expect(formatProgramLabel("AOC-2025")).toBe("MD mentee");
    expect(formatProgramLabel("AOC-something-else")).toBe("MD mentee");
  });

  it("normalizes both MD-PhD source values to 'MD-PhD mentee'", () => {
    // AOC source: "MDPHD" (compact)
    expect(formatProgramLabel("MDPHD")).toBe("MD-PhD mentee");
    // Jenzabar source: "MD-PhD" (hyphenated). Both populations are the
    // same trainee bucket; rollup must surface them as one group.
    expect(formatProgramLabel("MD-PhD")).toBe("MD-PhD mentee");
  });

  it("normalizes Jenzabar 'PhD' to 'PhD mentee'", () => {
    expect(formatProgramLabel("PhD")).toBe("PhD mentee");
  });

  it("expands 'ECR' to 'Early career mentee'", () => {
    expect(formatProgramLabel("ECR")).toBe("Early career mentee");
  });

  it("passes unknown values through unchanged", () => {
    expect(formatProgramLabel("Postdoc")).toBe("Postdoc");
    expect(formatProgramLabel("Something New")).toBe("Something New");
  });

  it("returns null for null input", () => {
    expect(formatProgramLabel(null)).toBeNull();
  });
});
