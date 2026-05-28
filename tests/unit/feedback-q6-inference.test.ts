/**
 * `inferRoleFromCategory` (#538 PR-1) — pre-select Q6 from
 * `Scholar.roleCategory` when a session is present.
 */
import { describe, expect, it } from "vitest";

import { FeedbackRole } from "@/lib/generated/prisma/client";
import { inferRoleFromCategory } from "@/lib/feedback/q6-inference";

describe("inferRoleFromCategory — faculty bucket", () => {
  it.each([
    "FULL_TIME_FACULTY",
    "AFFILIATED_FACULTY",
    "VOLUNTARY_FACULTY",
    "ADJUNCT_FACULTY",
    "COURTESY_FACULTY",
    "FACULTY_EMERITUS",
    "INSTRUCTOR",
    "LECTURER",
  ])("maps %s → wcm_faculty", (category) => {
    expect(inferRoleFromCategory(category)).toBe(FeedbackRole.wcm_faculty);
  });

  it("matches lowercase too (test fixtures / facet keys)", () => {
    expect(inferRoleFromCategory("full_time_faculty")).toBe(FeedbackRole.wcm_faculty);
  });
});

describe("inferRoleFromCategory — trainee bucket", () => {
  it.each([
    "POSTDOC",
    "FELLOW",
    "DOCTORAL_STUDENT",
    "DOCTORAL_STUDENT_MD",
    "DOCTORAL_STUDENT_PHD",
    "DOCTORAL_STUDENT_MDPHD",
  ])("maps %s → wcm_trainee", (category) => {
    expect(inferRoleFromCategory(category)).toBe(FeedbackRole.wcm_trainee);
  });
});

describe("inferRoleFromCategory — staff bucket", () => {
  it.each(["RESEARCH_STAFF", "NON_FACULTY_ACADEMIC", "NON_ACADEMIC"])(
    "maps %s → wcm_staff",
    (category) => {
      expect(inferRoleFromCategory(category)).toBe(FeedbackRole.wcm_staff);
    },
  );
});

describe("inferRoleFromCategory — unmapped + edge cases", () => {
  it("returns null for null / undefined / empty (no session)", () => {
    expect(inferRoleFromCategory(null)).toBeNull();
    expect(inferRoleFromCategory(undefined)).toBeNull();
    expect(inferRoleFromCategory("")).toBeNull();
  });

  it("returns null for an unknown roleCategory (safe default — Q8 unselected)", () => {
    expect(inferRoleFromCategory("NEW_EXPERIMENTAL_CATEGORY")).toBeNull();
    expect(inferRoleFromCategory("FACULTY")).toBeNull(); // missing _ETC suffix; not in the mapped list
  });

  it("never returns external_researcher / journalist / patient_or_public / other / prefer_not_say from inference", () => {
    // These four are *user-selectable* but never inferred from roleCategory.
    // They're the answer for non-WCM-authenticated traffic; an authenticated
    // user can always switch to them by hand.
    const allInferred = [
      "FULL_TIME_FACULTY",
      "POSTDOC",
      "RESEARCH_STAFF",
      "UNKNOWN",
    ].map(inferRoleFromCategory);
    expect(allInferred).not.toContain(FeedbackRole.external_researcher);
    expect(allInferred).not.toContain(FeedbackRole.journalist);
    expect(allInferred).not.toContain(FeedbackRole.patient_or_public);
    expect(allInferred).not.toContain(FeedbackRole.other);
    expect(allInferred).not.toContain(FeedbackRole.prefer_not_say);
  });
});
