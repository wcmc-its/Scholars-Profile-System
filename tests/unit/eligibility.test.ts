import { describe, expect, it } from "vitest";
import {
  ELIGIBLE_ROLES,
  TOP_SCHOLARS_ELIGIBLE_ROLES,
  type RoleCategory,
} from "@/lib/eligibility";

describe("ELIGIBLE_ROLES (design-spec-v1.7.1.md:377-385)", () => {
  it("contains exactly the four eligibility-carve roles", () => {
    expect(ELIGIBLE_ROLES).toEqual([
      "full_time_faculty",
      "postdoc",
      "fellow",
      "doctoral_student",
    ]);
  });
});

describe("TOP_SCHOLARS_ELIGIBLE_ROLES (CONTEXT.md D-14 narrowed override)", () => {
  it("narrows to full-time faculty only — Phase 2 surface-specific carve", () => {
    expect(TOP_SCHOLARS_ELIGIBLE_ROLES).toEqual(["full_time_faculty"]);
  });
});

describe("RoleCategory type (compile-time check)", () => {
  it("includes all 10 spec-mandated categories", () => {
    // Each literal asserted against the type via a typed array.
    // If any member is misspelled or missing from the union, this fails to compile.
    const allRoles: RoleCategory[] = [
      "full_time_faculty",
      "affiliated_faculty",
      "postdoc",
      "fellow",
      "non_faculty_academic",
      "non_academic",
      "doctoral_student",
      "instructor",
      "lecturer",
      "emeritus",
    ];
    expect(allRoles).toHaveLength(10);
  });

  it("ELIGIBLE_ROLES is a subset of RoleCategory", () => {
    // If ELIGIBLE_ROLES contains a string that isn't a RoleCategory, this fails to compile.
    const carve: ReadonlyArray<RoleCategory> = ELIGIBLE_ROLES;
    expect(carve.length).toBe(4);
  });
});
