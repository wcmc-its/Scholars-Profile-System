import { describe, expect, it } from "vitest";

import {
  MENTORING_DISTRIBUTION_THRESHOLD,
  formatMentoringDistribution,
  formatProgramLabel,
  mentoringDistributionBucket,
} from "@/lib/mentoring-labels";

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

  it("expands 'POSTDOC' to 'Postdoc mentee'", () => {
    // Issue #183 — ED postdoc role records use programType="POSTDOC"
    // (uppercase to match the AOC/MDPHD shape). The unstyled "Postdoc"
    // string (in the unknown-values test below) is intentionally NOT
    // matched — programType values are normalized at ETL write time.
    expect(formatProgramLabel("POSTDOC")).toBe("Postdoc mentee");
  });

  it("passes unknown values through unchanged", () => {
    expect(formatProgramLabel("Postdoc")).toBe("Postdoc");
    expect(formatProgramLabel("Something New")).toBe("Something New");
  });

  it("returns null for null input", () => {
    expect(formatProgramLabel(null)).toBeNull();
  });
});

describe("mentoringDistributionBucket", () => {
  it("collapses AOC variants to 'MD'", () => {
    expect(mentoringDistributionBucket("AOC")).toBe("MD");
    expect(mentoringDistributionBucket("AOC-2025")).toBe("MD");
  });

  it("collapses both MD-PhD source values to 'MD-PhD'", () => {
    expect(mentoringDistributionBucket("MDPHD")).toBe("MD-PhD");
    expect(mentoringDistributionBucket("MD-PhD")).toBe("MD-PhD");
  });

  it("collapses Jenzabar 'PhD' to 'PhD'", () => {
    // The subhead bucket is degree-level only; specific program names
    // ("Neuroscience", "Pharmacology") are intentionally NOT split out
    // here — those live on individual chips and on the Slice B group
    // headers, not on the section header line.
    expect(mentoringDistributionBucket("PhD")).toBe("PhD");
  });

  it("maps 'POSTDOC' to 'Postdoc' and 'ECR' to 'ECR'", () => {
    expect(mentoringDistributionBucket("POSTDOC")).toBe("Postdoc");
    expect(mentoringDistributionBucket("ECR")).toBe("ECR");
  });

  it("sends null and unknown program types to 'other'", () => {
    expect(mentoringDistributionBucket(null)).toBe("other");
    expect(mentoringDistributionBucket("Something New")).toBe("other");
  });
});

describe("formatMentoringDistribution", () => {
  const mentees = (types: Array<string | null>) =>
    types.map((programType) => ({ programType }));

  it(`returns null below the ${MENTORING_DISTRIBUTION_THRESHOLD}-mentee threshold`, () => {
    // Even a clean multi-bucket split is suppressed for small lists —
    // the bare "N mentees" count carries enough shape, and the subhead
    // distribution starts adding signal only once N is large.
    expect(
      formatMentoringDistribution(mentees(["AOC", "PhD", "POSTDOC"])),
    ).toBeNull();
  });

  it("returns null at threshold when every mentee falls in one bucket", () => {
    // "8 mentees — 8 PhD" is tautological; the helper signals the
    // caller to fall back to the plain count.
    expect(
      formatMentoringDistribution(mentees(Array(8).fill("PhD"))),
    ).toBeNull();
  });

  it("renders buckets in fixed MD → PhD → MD-PhD → Postdoc → ECR → other order", () => {
    const list = mentees([
      "ECR",
      "POSTDOC",
      "POSTDOC",
      "POSTDOC",
      "MD-PhD",
      "PhD",
      "PhD",
      "AOC",
    ]);
    expect(formatMentoringDistribution(list)).toBe(
      "1 MD · 2 PhD · 1 MD-PhD · 3 Postdoc · 1 ECR",
    );
  });

  it("omits zero-count buckets so the line stays compact", () => {
    // No postdocs / ECR / other in this portfolio — those buckets must
    // not render with "0 X" entries.
    const list = mentees([
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      "PhD",
    ]);
    expect(formatMentoringDistribution(list)).toBe("7 MD · 1 PhD");
  });

  it("buckets unknown and null programTypes into 'other'", () => {
    const list = mentees([
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      "AOC",
      null,
      "Mystery Program",
    ]);
    expect(formatMentoringDistribution(list)).toBe("7 MD · 2 other");
  });
});
