/**
 * `renameBlastRadiusText` — the confirm-dialog sentence a steward reads
 * before an org-unit role label rename (#2542 Phase 3,
 * `components/edit/org-unit-role-roster.tsx`).
 *
 * Pins every branch verbatim (not a substring/regex match) because this
 * exact function has had two consecutive review-eyeball defects: a PEOPLE
 * count paired with a UNIT noun, then — after that fix — the equal-counts
 * branch (the `singleHolder`/`director` case) reporting HOLDERS where the
 * requirement is UNITS. Both were caught by eye, not by a test.
 *
 * Pure-function only: no DOM, no Prisma, no component render.
 */
import { describe, expect, it } from "vitest";

import { renameBlastRadiusText } from "@/components/edit/org-unit-role-roster";

describe("renameBlastRadiusText", () => {
  it("multi-holder, multi-unit: states both grains", () => {
    expect(
      renameBlastRadiusText({ entityType: "center", holderCount: 400, unitCount: 3 }),
    ).toBe("This changes the label shown for 400 holders across 3 centers.");
  });

  it("equal counts, N > 1: names UNITS, not holders (the director case)", () => {
    expect(
      renameBlastRadiusText({ entityType: "center", holderCount: 3, unitCount: 3 }),
    ).toBe("This changes the label shown for 3 centers.");
  });

  it("equal counts, N = 1: singular noun, no '1 centers'", () => {
    expect(
      renameBlastRadiusText({ entityType: "center", holderCount: 1, unitCount: 1 }),
    ).toBe("This changes the label shown for 1 center.");
  });

  it("multi-holder, exactly one unit: still states both grains", () => {
    expect(
      renameBlastRadiusText({ entityType: "center", holderCount: 5, unitCount: 1 }),
    ).toBe("This changes the label shown for 5 holders across 1 center.");
  });

  it("zero holders: the no-effect sentence", () => {
    expect(
      renameBlastRadiusText({ entityType: "center", holderCount: 0, unitCount: 0 }),
    ).toBe("Nothing currently holds this role — the rename has no effect on any profile.");
  });

  it("non-center entityType: noun is not hardcoded to 'center'", () => {
    expect(
      renameBlastRadiusText({ entityType: "department", holderCount: 2, unitCount: 2 }),
    ).toBe("This changes the label shown for 2 departments.");
  });
});
