/**
 * #1034 — Grad-School (Jenzabar) faculty title normalization.
 *
 * Pure-logic tests for lib/faculty-rank.ts: deriving the ASMS professorial rank
 * from the ED person-type leaf (Rule B source), stripping chair/program-head
 * designations (Rule A), and the combined normalization that the Jenzabar GS
 * import applies to `Appointment.title`.
 */
import { describe, expect, it } from "vitest";

import {
  deriveProfessorialRank,
  stripGradSchoolChairDesignation,
  normalizeGradSchoolFacultyTitle,
} from "@/lib/faculty-rank";

describe("deriveProfessorialRank — ASMS rank from person-type leaf (probe #1036)", () => {
  it("maps the three confirmed rank leaves", () => {
    expect(deriveProfessorialRank(["academic-faculty-assistant"])).toBe("Assistant Professor");
    expect(deriveProfessorialRank(["academic-faculty-associate"])).toBe("Associate Professor");
    expect(deriveProfessorialRank(["academic-faculty-fullprofessor"])).toBe("Professor");
  });

  it("resolves fslee's real person-type array to Professor", () => {
    expect(
      deriveProfessorialRank([
        "academic",
        "academic-faculty",
        "academic-faculty-fullprofessor",
        "academic-faculty-weillfulltime",
        "employee-academic",
        "employee-exempt",
        "employee",
        "affiliate",
        "affiliate-nyp",
        "affiliate-nyp-clinical",
      ]),
    ).toBe("Professor");
  });

  it("returns null when no professorial-rank leaf is present", () => {
    expect(deriveProfessorialRank(["academic", "academic-faculty"])).toBeNull();
    expect(deriveProfessorialRank(["academic-faculty-instructor"])).toBeNull();
    expect(deriveProfessorialRank(["academic-faculty-lecturer"])).toBeNull();
    expect(deriveProfessorialRank([])).toBeNull();
  });

  it("ignores modifier leaves — adjunct/voluntary are not a rank", () => {
    // An adjunct full professor carries BOTH leaves; rank reads only the rank leaf.
    expect(deriveProfessorialRank(["academic-faculty-adjunct", "academic-faculty-assistant"])).toBe(
      "Assistant Professor",
    );
    // Adjunct with no rank leaf at all → no rank.
    expect(deriveProfessorialRank(["academic-faculty-adjunct"])).toBeNull();
  });

  it("highest-rank-wins if a record ever carries two rank leaves", () => {
    expect(
      deriveProfessorialRank(["academic-faculty-assistant", "academic-faculty-fullprofessor"]),
    ).toBe("Professor");
    expect(
      deriveProfessorialRank(["academic-faculty-assistant", "academic-faculty-associate"]),
    ).toBe("Associate Professor");
  });
});

describe("stripGradSchoolChairDesignation — Rule A (GS has no chairs/program heads)", () => {
  it("strips a trailing /Chair segment", () => {
    expect(stripGradSchoolChairDesignation("Professor/Chair")).toBe("Professor");
    expect(stripGradSchoolChairDesignation("Associate Professor/Chair")).toBe(
      "Associate Professor",
    );
  });

  it("is whitespace- and order-tolerant", () => {
    expect(stripGradSchoolChairDesignation("Professor / Chair")).toBe("Professor");
    expect(stripGradSchoolChairDesignation("Chair/Professor")).toBe("Professor");
  });

  it("strips program-head / head designations", () => {
    expect(stripGradSchoolChairDesignation("Professor/Program Head")).toBe("Professor");
    expect(stripGradSchoolChairDesignation("Professor/Program Director")).toBe("Professor");
    expect(stripGradSchoolChairDesignation("Professor/Head")).toBe("Professor");
  });

  it("leaves slash-free titles untouched (incl. standalone admin titles)", () => {
    expect(stripGradSchoolChairDesignation("Professor")).toBe("Professor");
    expect(stripGradSchoolChairDesignation("Course Director")).toBe("Course Director");
    expect(stripGradSchoolChairDesignation("Associate Dean")).toBe("Associate Dean");
  });

  it("never blanks a title when every segment is a leadership designation", () => {
    expect(stripGradSchoolChairDesignation("Chair")).toBe("Chair");
    expect(stripGradSchoolChairDesignation("Chair/Program Head")).toBe("Chair/Program Head");
  });
});

describe("normalizeGradSchoolFacultyTitle — combined Rule A + Rule B (the #1034 mapping table)", () => {
  const cases: Array<{
    jenzabarTitle: string;
    professorialRank: string | null;
    expected: string;
    note: string;
  }> = [
    {
      jenzabarTitle: "Professor/Chair",
      professorialRank: "Professor",
      expected: "Professor",
      note: "fslee — chair dropped (A), rank confirmed (B)",
    },
    {
      jenzabarTitle: "Professor/Chair",
      professorialRank: "Associate Professor",
      expected: "Associate Professor",
      note: "chair dropped AND rank corrected to ASMS",
    },
    {
      jenzabarTitle: "Associate Professor",
      professorialRank: "Professor",
      expected: "Professor",
      note: "GS stale → ASMS wins",
    },
    {
      jenzabarTitle: "Adjunct Professor",
      professorialRank: "Assistant Professor",
      expected: "Assistant Professor",
      note: "adjunct modifier dropped; rank from ASMS",
    },
    {
      jenzabarTitle: "Adjunct Associate Professor",
      professorialRank: "Associate Professor",
      expected: "Associate Professor",
      note: "adjunct dropped",
    },
    {
      jenzabarTitle: "Adjunct Assistant",
      professorialRank: "Assistant Professor",
      expected: "Assistant Professor",
      note: "truncated adjunct form → clean rank",
    },
    {
      jenzabarTitle: "Professor",
      professorialRank: null,
      expected: "Professor",
      note: "no resolvable ASMS rank → verbatim (open Q1)",
    },
    {
      jenzabarTitle: "Professor/Chair",
      professorialRank: null,
      expected: "Professor",
      note: "Rule A still strips chair without a rank",
    },
    {
      jenzabarTitle: "Instructor",
      professorialRank: null,
      expected: "Instructor",
      note: "non-professorial → verbatim",
    },
    {
      jenzabarTitle: "Instructor",
      professorialRank: "Professor",
      expected: "Instructor",
      note: "non-professorial GS title left as-is even with an ASMS rank",
    },
    { jenzabarTitle: "Lecturer", professorialRank: null, expected: "Lecturer", note: "verbatim" },
    {
      jenzabarTitle: "Course Director",
      professorialRank: "Professor",
      expected: "Course Director",
      note: "admin title, non-professorial → verbatim",
    },
    {
      jenzabarTitle: "Associate Dean",
      professorialRank: "Professor",
      expected: "Associate Dean",
      note: "admin title → verbatim",
    },
    {
      jenzabarTitle: "Retired",
      professorialRank: null,
      expected: "Retired",
      note: "status → verbatim",
    },
  ];

  for (const c of cases) {
    it(`${JSON.stringify(c.jenzabarTitle)} + rank ${JSON.stringify(c.professorialRank)} → ${JSON.stringify(c.expected)} (${c.note})`, () => {
      expect(
        normalizeGradSchoolFacultyTitle({
          jenzabarTitle: c.jenzabarTitle,
          professorialRank: c.professorialRank,
        }),
      ).toBe(c.expected);
    });
  }
});
