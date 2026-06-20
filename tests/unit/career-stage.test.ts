/**
 * GrantRecs Phase 2, Task 4 — map a scholar's roleCategory (+ appointment /
 * education dates) to one of the 5 career-stage buckets the opportunity's
 * `appeal_by_stage` is keyed on (spec §7.5). Pure, clock-injected.
 */
import { describe, expect, it } from "vitest";

import { careerStageBucket } from "@/lib/career-stage";

const NOW = new Date("2026-06-20T00:00:00Z");

describe("careerStageBucket — role-driven buckets", () => {
  it("maps doctoral students (incl. ED-suffixed variants) to grad", () => {
    expect(careerStageBucket({ roleCategory: "doctoral_student" }, NOW)).toBe("grad");
    expect(careerStageBucket({ roleCategory: "doctoral_student_phd" }, NOW)).toBe("grad");
    expect(careerStageBucket({ roleCategory: "doctoral_student_mdphd" }, NOW)).toBe("grad");
  });

  it("maps postdoc and fellow to postdoc", () => {
    expect(careerStageBucket({ roleCategory: "postdoc" }, NOW)).toBe("postdoc");
    expect(careerStageBucket({ roleCategory: "fellow" }, NOW)).toBe("postdoc");
  });

  it("maps instructor / non_faculty_academic to early", () => {
    expect(careerStageBucket({ roleCategory: "instructor" }, NOW)).toBe("early");
    expect(careerStageBucket({ roleCategory: "non_faculty_academic" }, NOW)).toBe("early");
  });

  it("maps affiliated_faculty / lecturer to mid", () => {
    expect(careerStageBucket({ roleCategory: "affiliated_faculty" }, NOW)).toBe("mid");
    expect(careerStageBucket({ roleCategory: "lecturer" }, NOW)).toBe("mid");
  });

  it("maps emeritus to senior", () => {
    expect(careerStageBucket({ roleCategory: "emeritus" }, NOW)).toBe("senior");
  });

  it("defaults unknown / null / hidden-alumni roles to mid", () => {
    expect(careerStageBucket({ roleCategory: null }, NOW)).toBe("mid");
    expect(careerStageBucket({ roleCategory: "affiliate_alumni" }, NOW)).toBe("mid");
    expect(careerStageBucket({ roleCategory: "something_new" }, NOW)).toBe("mid");
  });
});

describe("careerStageBucket — full_time_faculty split by tenure", () => {
  it("uses appointment tenure: <7yr → early", () => {
    const stage = careerStageBucket(
      { roleCategory: "full_time_faculty", appointments: [{ startDate: new Date("2022-07-01") }] },
      NOW,
    );
    expect(stage).toBe("early");
  });

  it("uses appointment tenure: 7–20yr → mid", () => {
    const stage = careerStageBucket(
      { roleCategory: "full_time_faculty", appointments: [{ startDate: new Date("2014-07-01") }] },
      NOW,
    );
    expect(stage).toBe("mid");
  });

  it("uses appointment tenure: >20yr → senior", () => {
    const stage = careerStageBucket(
      { roleCategory: "full_time_faculty", appointments: [{ startDate: new Date("2000-07-01") }] },
      NOW,
    );
    expect(stage).toBe("senior");
  });

  it("uses the earliest (most senior) appointment when several exist", () => {
    const stage = careerStageBucket(
      {
        roleCategory: "full_time_faculty",
        appointments: [{ startDate: new Date("2023-01-01") }, { startDate: new Date("2001-01-01") }],
      },
      NOW,
    );
    expect(stage).toBe("senior");
  });

  it("falls back to years-since-terminal-degree when no appointment date", () => {
    // terminal (most recent) degree 2023 → ~3yr → early
    expect(
      careerStageBucket(
        { roleCategory: "full_time_faculty", educations: [{ year: 2010 }, { year: 2023 }] },
        NOW,
      ),
    ).toBe("early");
    // terminal degree 1995 → ~31yr → senior
    expect(
      careerStageBucket({ roleCategory: "full_time_faculty", educations: [{ year: 1995 }] }, NOW),
    ).toBe("senior");
  });

  it("defaults faculty with no dates to mid", () => {
    expect(careerStageBucket({ roleCategory: "full_time_faculty" }, NOW)).toBe("mid");
    expect(
      careerStageBucket(
        { roleCategory: "full_time_faculty", appointments: [{ startDate: null }], educations: [{ year: null }] },
        NOW,
      ),
    ).toBe("mid");
  });
});
