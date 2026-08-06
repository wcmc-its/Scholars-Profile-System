/**
 * #2211 — `emeritus` is a declared `RoleCategory` that the ED ETL never emitted,
 * so nothing downstream had ever seen it. When the derivation started emitting
 * it, `ROLE_DISPLAY` had no key and `formatRoleCategory` passed the raw code
 * `"emeritus"` straight to the search facet chip, the autocomplete role chip and
 * the department person row.
 *
 * This test is the general guard for that failure mode: every publicly
 * displayable role code must have a human label, and the maps that used to see
 * emeritus spelled `affiliated_faculty` must keep treating it the same way, so
 * splitting the ED bucket is a segmentation change and not a ranking change.
 */
import { describe, expect, it } from "vitest";

import { PUBLICLY_DISPLAYED_ROLES, SEARCH_BOOST_ELIGIBLE_ROLES } from "@/lib/eligibility";
import { formatRoleCategory } from "@/lib/role-display";
import { inferRoleFromCategory } from "@/lib/feedback/q6-inference";

describe("every publicly displayed role has a display label", () => {
  it.each([...PUBLICLY_DISPLAYED_ROLES])("%s is labelled, not passed through raw", (role) => {
    const label = formatRoleCategory(role);
    expect(label).not.toBeNull();
    // A raw code leaking to the UI shows up as snake_case in the chip.
    expect(label).not.toBe(role);
    expect(label).not.toMatch(/_/);
  });

  it("labels emeritus the same as the legacy faculty_emeritus spelling", () => {
    expect(formatRoleCategory("emeritus")).toBe("Faculty emeritus");
    expect(formatRoleCategory("EMERITUS")).toBe("Faculty emeritus");
    expect(formatRoleCategory("faculty_emeritus")).toBe("Faculty emeritus");
  });
});

describe("emeritus keeps the treatment it had as affiliated_faculty", () => {
  it("stays eligible for the #1363 people-search concentration boost", () => {
    expect(SEARCH_BOOST_ELIGIBLE_ROLES).toContain("emeritus");
    expect(SEARCH_BOOST_ELIGIBLE_ROLES).toContain("affiliated_faculty");
  });

  it("still infers the faculty Q6 respondent context", () => {
    expect(inferRoleFromCategory("emeritus")).toBe(inferRoleFromCategory("affiliated_faculty"));
    expect(inferRoleFromCategory("emeritus")).not.toBeNull();
  });
});
