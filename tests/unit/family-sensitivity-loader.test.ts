/**
 * #801 sensitivity seed — a curated label that names no real family is a silent no-op, and
 * a more dangerous one than the #800 case. `family_sensitivity_overlay` is exact-string-
 * joined against `scholar_family` on the (supercategory, family_label) pair at read time,
 * so an unmatched label seeds a row that gates nothing. With METHODS_LENS_SENSITIVE_GATE
 * on, that means the family renders PUBLICLY while the curated list still reads as complete.
 *
 * Five rows had drifted this way in prod — three of them A2 renames whose live
 * counterparts carried no overlay row at all — before the loader gained this guard.
 *
 * This locks down the set difference; the surrounding DB query is trivial.
 */
import { describe, expect, it } from "vitest";

import { computeSkipKeys, findUnknownFamilies } from "@/etl/family-sensitivity";

const row = (supercategory: string, familyLabel: string) => ({
  supercategory,
  familyLabel,
  sourceNote: null,
});

// Mirrors the loader's rowKey. The separator is NUL, not a space, so a label that itself
// contains the separator can never collide with a different (supercategory, label) pair.
const key = (supercategory: string, familyLabel: string) => `${supercategory}\u0000${familyLabel}`;

const known = new Set([
  key("animal_cell_models", "Genetically engineered mouse models"),
  key("animal_cell_models", "Conditional knockout mouse models"),
  key("animal_cell_models", "Immune cell depletion models"),
  key("molecular_biochem_reagents", "Bacterial toxin reagents"),
]);

describe("findUnknownFamilies", () => {
  it("returns nothing when every curated pair names a real family", () => {
    const rows = [
      row("animal_cell_models", "Genetically engineered mouse models"),
      row("molecular_biochem_reagents", "Bacterial toxin reagents"),
    ];
    expect(findUnknownFamilies(rows, known)).toEqual([]);
  });

  it("flags a label an A2 rebuild renamed out from under the CSV", () => {
    // The exact prod drift: the rebuild dropped the leading "In vivo ", so the curated row
    // matched nothing while the renamed family sat unprotected on public profiles.
    const rows = [row("animal_cell_models", "In vivo immune cell depletion models")];
    expect(findUnknownFamilies(rows, known).map((r) => r.familyLabel)).toEqual([
      "In vivo immune cell depletion models",
    ]);
  });

  it("flags a curated family with no heir in the taxonomy", () => {
    // "Knockout mouse models" was split/merged away; only the conditional variant remains.
    const rows = [row("animal_cell_models", "Knockout mouse models")];
    expect(findUnknownFamilies(rows, known)).toHaveLength(1);
  });

  it("flags a real label filed under the wrong supercategory", () => {
    const rows = [row("animal_cell_models", "Bacterial toxin reagents")];
    expect(findUnknownFamilies(rows, known)).toHaveLength(1);
  });

  it("matches on the exact string — case and inner whitespace are significant", () => {
    // The read-time join is exact string equality, so neither would ever gate anything.
    // (Leading/trailing whitespace can't reach here — parseCsv trims each field.)
    const rows = [
      row("animal_cell_models", "genetically engineered mouse models"),
      row("animal_cell_models", "Genetically  engineered mouse models"),
    ];
    expect(findUnknownFamilies(rows, known)).toHaveLength(2);
  });

  it("treats an empty curated set as clean", () => {
    expect(findUnknownFamilies([], known)).toEqual([]);
  });
});

describe("computeSkipKeys (#1993)", () => {
  it("skips a family with NO steward overlay row but a Public FamilyTierDecision", () => {
    // The exact #1993 defect: a Public tier leaves nothing in this loader's own
    // overlay table, so the steward-rows query alone would miss it entirely.
    const skip = computeSkipKeys(
      [],
      [{ supercategory: "animal_cell_models", familyLabel: "Xenograft tumor models" }],
    );
    expect(skip.has(key("animal_cell_models", "Xenograft tumor models"))).toBe(true);
  });

  it("still skips a family via the steward overlay row alone (belt-and-braces)", () => {
    const skip = computeSkipKeys(
      [{ supercategory: "animal_cell_models", familyLabel: "Genetically engineered mouse models" }],
      [],
    );
    expect(skip.has(key("animal_cell_models", "Genetically engineered mouse models"))).toBe(true);
  });

  it("does not skip a family present in neither source", () => {
    const skip = computeSkipKeys(
      [{ supercategory: "animal_cell_models", familyLabel: "Conditional knockout mouse models" }],
      [{ supercategory: "animal_cell_models", familyLabel: "Immune cell depletion models" }],
    );
    expect(skip.has(key("animal_cell_models", "Bacterial toxin reagents"))).toBe(false);
  });

  it("returns an empty set when both sources are empty", () => {
    expect(computeSkipKeys([], []).size).toBe(0);
  });
});
