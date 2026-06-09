import { describe, expect, it } from "vitest";
import {
  ELIGIBLE_ROLES,
  PUBLICLY_DISPLAYED_ROLES,
  TOP_SCHOLARS_ELIGIBLE_ROLES,
  isPubliclyDisplayed,
  type RoleCategory,
} from "@/lib/eligibility";

describe("ELIGIBLE_ROLES (design-spec-v1.7.1.md:377-385)", () => {
  it("contains exactly the three eligibility-carve roles (doctoral_student removed in #536)", () => {
    expect(ELIGIBLE_ROLES).toEqual(["full_time_faculty", "postdoc", "fellow"]);
  });

  it("no longer includes doctoral_student — hidden from algorithmic home surfaces (#536)", () => {
    expect(ELIGIBLE_ROLES).not.toContain("doctoral_student");
  });
});

describe("isPubliclyDisplayed / PUBLICLY_DISPLAYED_ROLES (#536)", () => {
  const ALL_ROLES: RoleCategory[] = [
    "full_time_faculty",
    "affiliated_faculty",
    "affiliate_alumni",
    "postdoc",
    "fellow",
    "non_faculty_academic",
    "non_academic",
    "doctoral_student",
    "instructor",
    "lecturer",
    "emeritus",
  ];

  it("hides exactly the two hidden identity classes; every other role is publicly displayed", () => {
    for (const role of ALL_ROLES) {
      const hidden = role === "doctoral_student" || role === "affiliate_alumni";
      expect(isPubliclyDisplayed(role)).toBe(!hidden);
    }
  });

  it("PUBLICLY_DISPLAYED_ROLES is every RoleCategory except the hidden classes", () => {
    expect(PUBLICLY_DISPLAYED_ROLES).not.toContain("doctoral_student");
    expect(PUBLICLY_DISPLAYED_ROLES).not.toContain("affiliate_alumni");
    expect([...PUBLICLY_DISPLAYED_ROLES].sort()).toEqual(
      ALL_ROLES.filter(
        (r) => r !== "doctoral_student" && r !== "affiliate_alumni",
      ).sort(),
    );
    // The set membership predicate agrees with the published allow-list.
    for (const role of PUBLICLY_DISPLAYED_ROLES) {
      expect(isPubliclyDisplayed(role)).toBe(true);
    }
  });

  it("fails open for null / undefined / unknown roles (display, don't hide)", () => {
    expect(isPubliclyDisplayed(null)).toBe(true);
    expect(isPubliclyDisplayed(undefined)).toBe(true);
    // Forward-compat: a role string not yet in the union is shown, not hidden.
    expect(isPubliclyDisplayed("some_future_role")).toBe(true);
  });
});

describe("TOP_SCHOLARS_ELIGIBLE_ROLES (CONTEXT.md D-14 narrowed override)", () => {
  it("narrows to full-time faculty only — Phase 2 surface-specific carve", () => {
    expect(TOP_SCHOLARS_ELIGIBLE_ROLES).toEqual(["full_time_faculty"]);
  });
});

describe("RoleCategory type (compile-time check)", () => {
  it("includes all 11 spec-mandated categories", () => {
    // Each literal asserted against the type via a typed array.
    // If any member is misspelled or missing from the union, this fails to compile.
    const allRoles: RoleCategory[] = [
      "full_time_faculty",
      "affiliated_faculty",
      "affiliate_alumni",
      "postdoc",
      "fellow",
      "non_faculty_academic",
      "non_academic",
      "doctoral_student",
      "instructor",
      "lecturer",
      "emeritus",
    ];
    expect(allRoles).toHaveLength(11);
  });

  it("ELIGIBLE_ROLES is a subset of RoleCategory", () => {
    // If ELIGIBLE_ROLES contains a string that isn't a RoleCategory, this fails to compile.
    const carve: ReadonlyArray<RoleCategory> = ELIGIBLE_ROLES;
    expect(carve.length).toBe(3);
  });
});
