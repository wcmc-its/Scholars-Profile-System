/**
 * #800 suppression seed — a curated label that names no real family is a silent no-op.
 *
 * `family_suppression_overlay` is exact-string-joined against `scholar_family` on the
 * (supercategory, family_label) pair at read time. A typo in curated.csv therefore inserts
 * a row that matches nothing, hides nothing, and still records the run as SUCCESS. The
 * loader now set-differences the curated rows against the family table and fails closed.
 *
 * This locks down the set difference; the surrounding DB query is trivial.
 */
import { describe, expect, it } from "vitest";

import { computeSkipKeys, findUnknownFamilies } from "@/etl/family-suppression";

const row = (supercategory: string, familyLabel: string) => ({
  supercategory,
  familyLabel,
  sourceNote: null,
});

// Mirrors the loader's rowKey — the join is the exact pair, not the label alone.
const key = (supercategory: string, familyLabel: string) => `${supercategory} ${familyLabel}`;

const known = new Set(
  [
    ["computational_statistical", "Regression modeling"],
    ["computational_statistical", "Observational study design"],
    ["animal_cell_models", "Regression modeling"],
  ].map(([s, l]) => key(s, l)),
);

describe("findUnknownFamilies", () => {
  it("returns nothing when every curated pair names a real family", () => {
    const rows = [
      row("computational_statistical", "Regression modeling"),
      row("computational_statistical", "Observational study design"),
    ];
    expect(findUnknownFamilies(rows, known)).toEqual([]);
  });

  it("flags a typo'd family label", () => {
    const rows = [
      row("computational_statistical", "Regression modeling"),
      row("computational_statistical", "Regression modelling"), // British spelling
    ];
    expect(findUnknownFamilies(rows, known).map((r) => r.familyLabel)).toEqual([
      "Regression modelling",
    ]);
  });

  it("flags a real label filed under the wrong supercategory", () => {
    const rows = [row("clinical_translational", "Regression modeling")];
    expect(findUnknownFamilies(rows, known)).toHaveLength(1);
  });

  it("matches on the exact string — case and inner whitespace are significant", () => {
    // The read-time join is exact string equality, so neither would ever hide anything.
    // (Leading/trailing whitespace can't reach here — parseCsv trims each field.)
    const rows = [
      row("computational_statistical", "regression modeling"),
      row("computational_statistical", "Regression  modeling"),
    ];
    expect(findUnknownFamilies(rows, known)).toHaveLength(2);
  });

  it("treats an empty curated set as clean", () => {
    expect(findUnknownFamilies([], known)).toEqual([]);
  });
});

describe("computeSkipKeys (#1993)", () => {
  it("skips a family with NO steward overlay row but a Public FamilyTierDecision", () => {
    // The exact #1993 defect: a Public tier leaves nothing in either overlay
    // table, so the steward-rows query alone would miss it entirely.
    const skip = computeSkipKeys(
      [],
      [{ supercategory: "animal_cell_models", familyLabel: "Xenograft tumor models" }],
    );
    expect(skip.has(key("animal_cell_models", "Xenograft tumor models"))).toBe(true);
  });

  it("still skips a family via the steward overlay row alone (belt-and-braces)", () => {
    const skip = computeSkipKeys(
      [{ supercategory: "computational_statistical", familyLabel: "Regression modeling" }],
      [],
    );
    expect(skip.has(key("computational_statistical", "Regression modeling"))).toBe(true);
  });

  it("does not skip a family present in neither source", () => {
    const skip = computeSkipKeys(
      [{ supercategory: "computational_statistical", familyLabel: "Regression modeling" }],
      [{ supercategory: "animal_cell_models", familyLabel: "Regression modeling" }],
    );
    expect(skip.has(key("clinical_translational", "Regression modeling"))).toBe(false);
  });

  it("returns an empty set when both sources are empty", () => {
    expect(computeSkipKeys([], []).size).toBe(0);
  });
});
