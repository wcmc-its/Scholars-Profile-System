/**
 * Opportunity screening signals — `docs/2026-07-24-grant-opportunity-screening-spec.md` §3.1/§4.
 *
 * The interesting behaviour is what the gate does NOT exclude: it is a claim that no WCM faculty
 * PI can hold the award, so every false positive removes real money from an officer's view. The
 * edge-case table below is the spec's, verbatim.
 */
import { describe, expect, it } from "vitest";

import { facultyPiMayHold, isTopicAgnostic } from "@/lib/funding/screening";

const NO_FLAGS = ["us_eligible"];

describe("facultyPiMayHold", () => {
  it("excludes predoctoral-only awards (F99/K00) and grad+undergrad programs", () => {
    expect(facultyPiMayHold(["us_eligible", "student_only"], { career_stages: ["graduate_student"] })).toBe(false);
    expect(
      facultyPiMayHold(NO_FLAGS, { career_stages: ["graduate_student", "undergraduate"] }),
    ).toBe(false);
  });

  it("KEEPS postdoc, late-stage-postdoc and clinical-fellow awards — the discriminator is not 'trainee'", () => {
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: ["postdoc"] })).toBe(true);
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: ["clinical_fellow", "postdoc"] })).toBe(true);
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: ["late_stage_postdoc"] })).toBe(true);
  });

  it("keeps resident-only awards — residents are neither students nor faculty, so fail open", () => {
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: ["resident"] })).toBe(true);
  });

  it("🔴 treats any_faculty as a faculty value — omitting it produced 14 false exclusions", () => {
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: ["any_faculty"] })).toBe(true);
  });

  it("fails open on empty, absent or malformed eligibility", () => {
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: [] })).toBe(true);
    expect(facultyPiMayHold(NO_FLAGS, null)).toBe(true);
    expect(facultyPiMayHold(null, undefined)).toBe(true);
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: "graduate_student" })).toBe(true);
    expect(facultyPiMayHold(NO_FLAGS, { career_stages: [{ x: 1 }] })).toBe(true);
  });

  it("lets the FLAGS win for inclusion when the map would exclude (spec §3.2 precedence)", () => {
    expect(
      facultyPiMayHold(["faculty_eligible", "student_only"], {
        career_stages: ["graduate_student"],
      }),
    ).toBe(true);
  });
});

describe("isTopicAgnostic", () => {
  it("flags the NIGMS RM1 shape: an infrastructure/workforce topic with no MeSH anchor", () => {
    expect(
      isTopicAgnostic({
        primaryTopicId: "research_infrastructure_workforce",
        meshDescriptorUi: null,
      }),
    ).toBe(true);
    expect(
      isTopicAgnostic({ primaryTopicId: "research_infrastructure_workforce", meshDescriptorUi: [] }),
    ).toBe(true);
  });

  it("does not flag an award that carries a MeSH anchor, or any other topic", () => {
    expect(
      isTopicAgnostic({
        primaryTopicId: "research_infrastructure_workforce",
        meshDescriptorUi: ["D009369"],
      }),
    ).toBe(false);
    expect(isTopicAgnostic({ primaryTopicId: "cancer_biology", meshDescriptorUi: null })).toBe(false);
    expect(isTopicAgnostic({ primaryTopicId: null, meshDescriptorUi: null })).toBe(false);
  });
});
