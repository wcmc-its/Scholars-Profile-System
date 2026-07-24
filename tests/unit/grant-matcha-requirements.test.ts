/**
 * Grant Matcha — which eligibility axes the rail should render for a given opportunity.
 *
 * The rail is RELEVANCE-DRIVEN, so the interesting behaviour is when an axis does NOT render:
 * an unrestricted opportunity must produce no career-stage gate at all, because a gate that
 * restricts nothing still teaches the officer to distrust the ones that do.
 */
import { describe, expect, it } from "vitest";

import { requirementsFrom } from "@/components/edit/grant-matcha-panel";

describe("requirementsFrom", () => {
  it("renders NO career-stage axis when the opportunity states no person-level restriction", () => {
    // `career_stages: []` is the mapper's explicit "no restriction" — and it is exactly the case
    // that still carries faculty_eligible + postdoc_eligible, so keying off the flags alone would
    // wrongly render the axis on ~88% of the corpus.
    const r = requirementsFrom(["us_eligible", "faculty_eligible", "postdoc_eligible"], {
      career_stages: [],
    });
    expect(r.careerStages).toBeNull();
  });

  it("renders the axis with the allowed stages when career_stages restricts", () => {
    const r = requirementsFrom(["faculty_eligible"], { career_stages: ["early_career_faculty"] });
    expect(r.careerStages).toEqual(["early", "mid", "senior"]);
  });

  it("maps a student-only opportunity to the grad stage", () => {
    const r = requirementsFrom(["student_only"], { career_stages: ["graduate_student"] });
    expect(r.careerStages).toEqual(["grad"]);
  });

  it("includes postdoc when the opportunity admits postdocs alongside faculty", () => {
    const r = requirementsFrom(["faculty_eligible", "postdoc_eligible"], {
      career_stages: ["postdoc", "early_career_faculty"],
    });
    expect(r.careerStages).toEqual(["early", "mid", "senior", "postdoc"]);
  });

  it("degrades to NO axis when the flags yield an empty allowed set — never hides everyone", () => {
    // Malformed/unmapped data: career_stages restricts but no derived flag survived. Filtering on
    // an empty allowed set would blank the results page; the axis must simply not render.
    const r = requirementsFrom([], { career_stages: ["some_unmapped_stage"] });
    expect(r.careerStages).toBeNull();
  });

  it("reads esi_targeted and the person-level US requirement; both default false", () => {
    expect(requirementsFrom([], {})).toMatchObject({ esiTargeted: false, usRequired: false });
    const r = requirementsFrom([], {
      esi_targeted: true,
      us_citizen_or_permanent_resident_required: true,
    });
    expect(r).toMatchObject({ esiTargeted: true, usRequired: true });
  });

  it("survives absent/malformed json without throwing", () => {
    expect(requirementsFrom(null, null)).toEqual({
      careerStages: null,
      esiTargeted: false,
      usRequired: false,
    });
    // An ARRAY is not a map — `career_stages` can't be read off it, so nothing restricts.
    expect(requirementsFrom("nonsense", ["not", "a", "map"]).careerStages).toBeNull();
  });
});
