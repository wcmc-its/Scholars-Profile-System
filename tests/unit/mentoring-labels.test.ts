import { describe, expect, it } from "vitest";

import {
  MENTORING_DISTRIBUTION_THRESHOLD,
  formatMentoringDistribution,
  formatProgramLabel,
  menteeTerminalYear,
  mentoringDistributionBucket,
  partitionMenteesByBucket,
  truncateGroupedMentees,
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

describe("menteeTerminalYear", () => {
  it("returns graduationYear when set (AOC/PhD/MD-PhD students)", () => {
    expect(
      menteeTerminalYear({ graduationYear: 2024, appointmentRange: null }),
    ).toBe(2024);
  });

  it("returns appointment endYear for ended postdocs", () => {
    expect(
      menteeTerminalYear({
        graduationYear: null,
        appointmentRange: { startYear: 2020, endYear: 2023 },
      }),
    ).toBe(2023);
  });

  it("pins active postdocs (endYear null) above any real year", () => {
    // Active postdocs sort above ended postdocs and recent graduates so
    // a profile mixing current and former trainees surfaces the active
    // ones first within their co-pub tier.
    const active = menteeTerminalYear({
      graduationYear: null,
      appointmentRange: { startYear: 2024, endYear: null },
    });
    expect(active).toBeGreaterThan(2099);
  });

  it("returns 0 when neither year source is populated", () => {
    expect(
      menteeTerminalYear({ graduationYear: null, appointmentRange: null }),
    ).toBe(0);
  });
});

describe("partitionMenteesByBucket", () => {
  const m = (programType: string | null, name: string) => ({
    programType,
    name,
  });

  it("returns groups in fixed MD → PhD → MD-PhD → Postdoc → ECR → Other order", () => {
    const groups = partitionMenteesByBucket([
      m("ECR", "Ecr-A"),
      m("POSTDOC", "Post-A"),
      m("MD-PhD", "MdPhd-A"),
      m("PhD", "Phd-A"),
      m("AOC", "Md-A"),
      m(null, "Other-A"),
    ]);
    expect(groups.map((g) => g.bucket)).toEqual([
      "MD",
      "PhD",
      "MD-PhD",
      "Postdoc",
      "ECR",
      "other",
    ]);
  });

  it("omits empty buckets entirely (no '0 chips' placeholder groups)", () => {
    // Two buckets present out of six; the helper must not emit headers
    // for MD-PhD/Postdoc/ECR/Other if those buckets have no mentees.
    const groups = partitionMenteesByBucket([
      m("AOC", "Md-A"),
      m("AOC", "Md-B"),
      m("PhD", "Phd-A"),
    ]);
    expect(groups.map((g) => g.bucket)).toEqual(["MD", "PhD"]);
  });

  it("preserves input order within each bucket", () => {
    // The grouped tier expects callers to pre-sort by terminal-year then
    // name (SPEC §4.2). Partition must not reorder within a bucket.
    const groups = partitionMenteesByBucket([
      m("AOC", "Z-first"),
      m("PhD", "Phd-A"),
      m("AOC", "A-second"),
      m("PhD", "Phd-B"),
    ]);
    expect(groups[0]).toEqual({
      bucket: "MD",
      mentees: [m("AOC", "Z-first"), m("AOC", "A-second")],
    });
    expect(groups[1]).toEqual({
      bucket: "PhD",
      mentees: [m("PhD", "Phd-A"), m("PhD", "Phd-B")],
    });
  });

  it("collapses AOC variants and both MD-PhD spellings into the right buckets", () => {
    const groups = partitionMenteesByBucket([
      m("AOC-2025", "Md-A"),
      m("AOC", "Md-B"),
      m("MDPHD", "MdPhd-A"),
      m("MD-PhD", "MdPhd-B"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].bucket).toBe("MD");
    expect(groups[0].mentees).toHaveLength(2);
    expect(groups[1].bucket).toBe("MD-PhD");
    expect(groups[1].mentees).toHaveLength(2);
  });

  it("buckets null and unknown programTypes into 'other'", () => {
    const groups = partitionMenteesByBucket([
      m("AOC", "Md-A"),
      m(null, "Unknown-A"),
      m("Mystery Program", "Unknown-B"),
    ]);
    const other = groups.find((g) => g.bucket === "other");
    expect(other?.mentees).toHaveLength(2);
  });

  it("returns an empty array when given no mentees", () => {
    expect(partitionMenteesByBucket([])).toEqual([]);
  });
});

describe("truncateGroupedMentees", () => {
  // Bare bucket objects, since the helper is generic over its mentee
  // shape. Using the same partition shape that `partitionMenteesByBucket`
  // produces so a typical pipeline maps directly through.
  const group = (
    bucket: "MD" | "PhD" | "MD-PhD" | "Postdoc" | "ECR" | "other",
    n: number,
    prefix?: string,
  ) => ({
    bucket,
    mentees: Array.from({ length: n }, (_, i) => ({
      id: `${prefix ?? bucket}-${i + 1}`,
    })),
  });

  it("returns every chip unhidden when the limit exceeds the total count", () => {
    // N=8 (4 MD + 4 PhD), limit=12 — every mentee visible, totalHidden=0.
    // Caller renders no "Show all N →" affordance in this state.
    const { visible, totalHidden } = truncateGroupedMentees(
      [group("MD", 4), group("PhD", 4)],
      12,
    );
    expect(visible).toHaveLength(2);
    expect(visible[0].mentees).toHaveLength(4);
    expect(visible[0].hiddenInGroup).toBe(0);
    expect(visible[1].mentees).toHaveLength(4);
    expect(visible[1].hiddenInGroup).toBe(0);
    expect(totalHidden).toBe(0);
  });

  it("emits hiddenInGroup on the mid-cut bucket (spec table #7)", () => {
    // N=14 (4 MD + 10 PhD), limit=12 — MD fully visible (4),
    // PhD truncated to 8 with `hiddenInGroup=2`.
    const { visible, totalHidden } = truncateGroupedMentees(
      [group("MD", 4), group("PhD", 10)],
      12,
    );
    expect(visible).toHaveLength(2);
    expect(visible[0].bucket).toBe("MD");
    expect(visible[0].hiddenInGroup).toBe(0);
    expect(visible[1].bucket).toBe("PhD");
    expect(visible[1].mentees).toHaveLength(8);
    expect(visible[1].hiddenInGroup).toBe(2);
    expect(totalHidden).toBe(2);
  });

  it("omits buckets entirely below the cut (spec table #8)", () => {
    // N=20 (4 MD + 8 PhD + 8 Postdoc), limit=12 — cut lands exactly
    // at MD+PhD = 12. Postdoc bucket has no visible chips, so it must
    // NOT appear in `visible` — rendering "Postdoc · 8" with no chips
    // beneath it is the visual-debt failure mode spec §7.2 calls out.
    const { visible, totalHidden } = truncateGroupedMentees(
      [group("MD", 4), group("PhD", 8), group("Postdoc", 8)],
      12,
    );
    expect(visible).toHaveLength(2);
    expect(visible.map((v) => v.bucket)).toEqual(["MD", "PhD"]);
    expect(visible[0].hiddenInGroup).toBe(0);
    expect(visible[1].hiddenInGroup).toBe(0);
    expect(totalHidden).toBe(8);
  });

  it("handles cut landing mid-group when downstream buckets also exist", () => {
    // N=20 (4 MD + 6 PhD + 10 Postdoc), limit=12 — MD (4) + PhD (6)
    // visible in full, Postdoc cut to 2 with `hiddenInGroup=8`.
    // Verifies mid-cut accounting plus downstream-bucket suppression
    // both work in one traversal.
    const { visible, totalHidden } = truncateGroupedMentees(
      [group("MD", 4), group("PhD", 6), group("Postdoc", 10)],
      12,
    );
    expect(visible).toHaveLength(3);
    expect(visible[2].bucket).toBe("Postdoc");
    expect(visible[2].mentees).toHaveLength(2);
    expect(visible[2].hiddenInGroup).toBe(8);
    expect(totalHidden).toBe(8);
  });

  it("preserves the within-group order from input (no internal sort)", () => {
    // Caller is responsible for sort order (SPEC §4.2 — class-year-desc,
    // then name). Helper must not reshuffle within a bucket.
    const phds = [{ id: "Z" }, { id: "A" }, { id: "M" }];
    const { visible } = truncateGroupedMentees([{ bucket: "PhD", mentees: phds }], 2);
    expect(visible[0].mentees.map((c) => c.id)).toEqual(["Z", "A"]);
    expect(visible[0].hiddenInGroup).toBe(1);
  });

  it("returns empty visible + totalHidden=0 when no groups are passed", () => {
    expect(truncateGroupedMentees([], 12)).toEqual({
      visible: [],
      totalHidden: 0,
    });
  });

  it("returns empty visible when limit is 0, sums all into totalHidden", () => {
    // Edge case in the comparator path — if a caller passed limit=0
    // (no chips visible), every group ends up below the cut.
    const { visible, totalHidden } = truncateGroupedMentees(
      [group("MD", 4), group("PhD", 5)],
      0,
    );
    expect(visible).toEqual([]);
    expect(totalHidden).toBe(9);
  });
});
