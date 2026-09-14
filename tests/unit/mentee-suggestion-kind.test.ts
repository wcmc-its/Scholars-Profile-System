import { describe, expect, it } from "vitest";
import { classifyMenteeKind, tierOf } from "@/lib/mentee-suggestions/kind";

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
});
