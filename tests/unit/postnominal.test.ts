import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { formatPublishedName, normalizePostnominal } from "@/lib/postnominal";

describe("normalizePostnominal", () => {
  it("collapses 'Doctor of Philosophy' to 'PhD'", () => {
    expect(normalizePostnominal("Doctor of Philosophy")).toBe("PhD");
  });

  it("collapses 'Doctor of Medicine' to 'MD'", () => {
    expect(normalizePostnominal("Doctor of Medicine")).toBe("MD");
  });

  it("leaves already-abbreviated values unchanged", () => {
    expect(normalizePostnominal("PhD")).toBe("PhD");
    expect(normalizePostnominal("MD, PhD")).toBe("MD, PhD");
    expect(normalizePostnominal("DPhil")).toBe("DPhil");
  });

  it("handles compound forms that mix abbreviations and full titles", () => {
    // ETL hasn't been observed producing these in production, but be
    // defensive — split on commas and normalize each segment.
    expect(normalizePostnominal("Doctor of Medicine, PhD")).toBe("MD, PhD");
    expect(normalizePostnominal("MD, Doctor of Philosophy")).toBe("MD, PhD");
  });

  it("is case-insensitive on the full-title match", () => {
    expect(normalizePostnominal("doctor of philosophy")).toBe("PhD");
    expect(normalizePostnominal("DOCTOR OF MEDICINE")).toBe("MD");
  });

  it("trims whitespace around segments", () => {
    expect(normalizePostnominal("  Doctor of Philosophy  ")).toBe("PhD");
    expect(normalizePostnominal("MD ,  PhD")).toBe("MD, PhD");
  });

  it("returns null for null/empty/whitespace-only input", () => {
    expect(normalizePostnominal(null)).toBeNull();
    expect(normalizePostnominal(undefined)).toBeNull();
    expect(normalizePostnominal("")).toBeNull();
    expect(normalizePostnominal("   ")).toBeNull();
    expect(normalizePostnominal(", ,")).toBeNull();
  });

  it("leaves unrecognized 'Doctor of …' forms unchanged but warns in dev", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "development");
    try {
      expect(normalizePostnominal("Doctor of Veterinary Medicine")).toBe(
        "Doctor of Veterinary Medicine",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Doctor of Veterinary Medicine"),
      );
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
    }
  });
});

describe("formatPublishedName", () => {
  it("appends normalized postnominal with comma separator", () => {
    expect(
      formatPublishedName("Ashna Singh", "Doctor of Philosophy", "full_time_faculty"),
    ).toBe("Ashna Singh, PhD");
    expect(formatPublishedName("Marcus Devlin", "PhD, MD", "full_time_faculty")).toBe(
      "Marcus Devlin, PhD, MD",
    );
  });

  it("returns the preferred name alone when postnominal is missing", () => {
    expect(formatPublishedName("Lisa Park", null, "full_time_faculty")).toBe("Lisa Park");
    expect(formatPublishedName("Lisa Park", undefined, "full_time_faculty")).toBe(
      "Lisa Park",
    );
    expect(formatPublishedName("Lisa Park", "", "full_time_faculty")).toBe("Lisa Park");
    expect(formatPublishedName("Lisa Park", "   ", "full_time_faculty")).toBe("Lisa Park");
  });

  // #2599 — ED overloads `weillCornellEduDegree`: the enrolled carry their
  // PROGRAMME as a full title, everyone else the EARNED credential as an
  // abbreviation. #201's normalization collapsed the two, publishing enrolled
  // students as though they held the degree. The suppression keys on ROLE.
  describe("enrolled doctoral students (#2599)", () => {
    // Every suffixed variant the DB actually carries (#1026). An exact-match
    // check would pass the bare value and leak the other three.
    it.each([
      "doctoral_student",
      "doctoral_student_md",
      "doctoral_student_mdphd",
      "doctoral_student_phd",
    ])("renders nothing after the name for %s", (role) => {
      expect(formatPublishedName("Priya Raghunathan", "Doctor of Philosophy", role)).toBe(
        "Priya Raghunathan",
      );
    });

    it("suppresses regardless of the postnominal's string form", () => {
      // The measured population carries only the full title, but the rule is
      // "this person is enrolled", not "this string looks like a programme".
      expect(formatPublishedName("Priya Raghunathan", "PhD", "doctoral_student")).toBe(
        "Priya Raghunathan",
      );
      expect(
        formatPublishedName("Priya Raghunathan", "Doctor of Medicine", "doctoral_student_md"),
      ).toBe("Priya Raghunathan");
    });

    it("matches the role case-insensitively and ignores surrounding whitespace", () => {
      expect(
        formatPublishedName("Priya Raghunathan", "Doctor of Philosophy", "DOCTORAL_STUDENT"),
      ).toBe("Priya Raghunathan");
      expect(
        formatPublishedName(
          "Priya Raghunathan",
          "Doctor of Philosophy",
          "  Doctoral_Student_PhD  ",
        ),
      ).toBe("Priya Raghunathan");
    });

    it("SUPPRESSES on the humanized label formatRoleCategory emits (#2202 shape)", () => {
      // The mixup this is defending against is two lines apart in both queue
      // loaders: `formatPublishedName(..., s.roleCategory)` then
      // `formatRoleCategory(s.roleCategory)`. Hand the LABEL to the first and a
      // prefix-only predicate answers false, republishing "<name>, PhD". That is
      // how #2202 published 684 students. Delete the fail-closed branch in
      // `isEnrolledDoctoralStudent` and these four go red.
      for (const label of ["Doctoral student", "MD student", "PhD student", "MD-PhD student"]) {
        expect(formatPublishedName("Priya Raghunathan", "Doctor of Philosophy", label)).toBe(
          "Priya Raghunathan",
        );
      }
    });

    it("suppresses on ANY unrecognized token — cheap miss beats a false credential", () => {
      // Not a prefix/substring rule any more: `former_doctoral_student` is not an
      // enum value this repo emits, so it is unknown, so it is suppressed. Losing a
      // degree suffix on a role nobody recognizes is the cheap direction; printing
      // one the person may not hold is the harm #2599 exists to stop.
      expect(
        formatPublishedName("Priya Raghunathan", "Doctor of Philosophy", "former_doctoral_student"),
      ).toBe("Priya Raghunathan");
      expect(
        formatPublishedName("Priya Raghunathan", "PhD", "some_future_role"),
      ).toBe("Priya Raghunathan");
    });

    it("does NOT suppress on a RECOGNIZED role that is not a student", () => {
      // The discriminating half of the pair above: `non_faculty_academic` and
      // `affiliate_alumni` are both in the enum, so both keep the credential —
      // the alumnus especially, who has finished the degree the student has not.
      expect(
        formatPublishedName("Elena Whitcombe", "Doctor of Philosophy", "non_faculty_academic"),
      ).toBe("Elena Whitcombe, PhD");
      expect(
        formatPublishedName("Elena Whitcombe", "Doctor of Philosophy", "affiliate_alumni"),
      ).toBe("Elena Whitcombe, PhD");
    });
  });

  it("still normalizes a full-title postnominal on a NON-student role", () => {
    // 4 prod faculty legitimately record an EARNED degree in full-title form.
    // Keying the suppression on the string form (99.6% correlated with students)
    // would strip the doctorate from a professor — the worse failure.
    expect(
      formatPublishedName("Elena Whitcombe", "Doctor of Philosophy", "affiliated_faculty"),
    ).toBe("Elena Whitcombe, PhD");
    expect(formatPublishedName("Elena Whitcombe", "Doctor of Medicine", "emeritus")).toBe(
      "Elena Whitcombe, MD",
    );
  });

  it("still renders an abbreviation for a postdoc", () => {
    // 0 postdocs carry a full title on prod — a postdoc's degree is earned, and
    // the #2599 carve must not widen to every non-faculty research role.
    expect(formatPublishedName("Tomas Bergquist", "PhD", "postdoc")).toBe(
      "Tomas Bergquist, PhD",
    );
    expect(formatPublishedName("Tomas Bergquist", "MD, PhD", "fellow")).toBe(
      "Tomas Bergquist, MD, PhD",
    );
  });

  it("renders the postnominal when roleCategory is null/undefined", () => {
    // Absence of a role is not evidence of enrolment. An un-backfilled scholar
    // keeps whatever credential ED recorded, matching `isEnrolledDoctoralStudent`.
    expect(formatPublishedName("Rosalind Achebe", "Doctor of Philosophy", null)).toBe(
      "Rosalind Achebe, PhD",
    );
    expect(formatPublishedName("Rosalind Achebe", "MD", undefined)).toBe(
      "Rosalind Achebe, MD",
    );
  });
});
