import { describe, expect, it } from "vitest";
import {
  classifyMenteeKind,
  formerFacultyRole,
  programTypeForKind,
  tierOf,
} from "@/lib/mentee-suggestions/kind";

describe("classifyMenteeKind", () => {
  it("picks the most specific trainee type over the paid-student employee type", () => {
    expect(
      classifyMenteeKind(["employee", "employee-student-paid", "student", "student-phd-weill"]),
    ).toBe("doctoral");
    expect(classifyMenteeKind(["student", "student-md-phd-tri-i"])).toBe("md_phd");
    expect(classifyMenteeKind(["academic-nonfaculty", "academic-nonfaculty-postdoc-fellow"])).toBe(
      "fellow",
    );
    expect(classifyMenteeKind(["academic", "academic-nonfaculty", "employee"])).toBe(
      "research_staff",
    );
  });

  it("tiers: trainees presumptive, staff ambiguous, collaborators unknown", () => {
    expect(tierOf(classifyMenteeKind(["affiliate-volunteer"]))).toBe("presumptive");
    expect(tierOf(classifyMenteeKind(["academic-nonfaculty"]))).toBe("ambiguous");
    expect(tierOf(classifyMenteeKind(["affiliate-collaborator"]))).toBe("unknown");
    expect(tierOf(classifyMenteeKind(["affiliate", "cornell-ithaca"]))).toBe("unknown");
    expect(classifyMenteeKind(["affiliate-nyp", "affiliate-nyp-resident"])).toBe("resident");
    expect(
      classifyMenteeKind([
        "affiliate-alumni",
        "affiliate-alumni-md",
        "affiliate-alumni-md-phd",
        "affiliate-alumni-phd",
      ]),
    ).toBe("alumni_phd");
    expect(tierOf(classifyMenteeKind(["affiliate-alumni", "affiliate-alumni-md"]))).toBe(
      "ambiguous",
    );
    expect(tierOf(classifyMenteeKind(["academic-inactive"]))).toBe("unknown");
  });

  it("maps trainee kinds to the public degree buckets; the rest stay 'other'", () => {
    expect(programTypeForKind("postdoc")).toBe("POSTDOC");
    expect(programTypeForKind("alumni_phd")).toBe("PhD");
    expect(programTypeForKind("md_phd")).toBe("MD-PhD");
    expect(programTypeForKind("md_student")).toBe("AOC");
    for (const k of ["volunteer", "resident", "research_staff", "alumni_md", "masters"] as const) {
      expect(programTypeForKind(k), k).toBeUndefined();
    }
  });
});

describe("formerFacultyRole — expired ED faculty-SOR titles for the departed", () => {
  it("professor-ranked titles exclude; Fellow / Postdoctoral Associate classify; the rest say nothing", () => {
    expect(formerFacultyRole("Professor of Medicine")).toBe("professor");
    expect(
      formerFacultyRole("Assistant Professor of Health Services Research in Radiology (Interim)"),
    ).toBe("professor");
    expect(formerFacultyRole("Visiting Assistant Professor of Pediatrics")).toBe("professor");
    expect(formerFacultyRole("Fellow in Medicine")).toBe("fellow");
    expect(formerFacultyRole("Visiting Fellow in Neuroscience")).toBe("fellow");
    expect(formerFacultyRole("Postdoctoral Associate in Physiology and Biophysics")).toBe("postdoc");
    for (const t of [
      "Instructor in Medicine",
      "Clinical Associate in Surgery",
      "Research Associate in Medicine",
      "Lecturer in Public Health",
      "Fellowship Director",
    ])
      expect(formerFacultyRole(t)).toBeNull();
  });
});
