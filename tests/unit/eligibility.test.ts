import { describe, expect, it } from "vitest";
import {
  ELIGIBLE_ROLES,
  HIDDEN_ROLE_CATEGORIES,
  publicRoleWhere,
  PUBLICLY_DISPLAYED_ROLES,
  TOP_SCHOLARS_ELIGIBLE_ROLES,
  isPubliclyDisplayed,
  isEnrolledDoctoralStudent,
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

  it("still displays null / undefined — absence of data, not an unknown token", () => {
    // 21 of the 22 call sites read the raw nullable column. Hiding NULL would drop
    // un-backfilled scholars from the profile route, /browse, the people index and
    // the CSV export — a much larger blast radius than the leak being fixed.
    expect(isPubliclyDisplayed(null)).toBe(true);
    expect(isPubliclyDisplayed(undefined)).toBe(true);
  });

  it("fails CLOSED on an unrecognized role (#2202)", () => {
    expect(isPubliclyDisplayed("some_future_role")).toBe(false);
  });

  it("hides humanized display labels — the #2202 leak", () => {
    // formatRoleCategory output fed to the predicate published 684 students by name.
    for (const label of [
      "Doctoral student",
      "MD student",
      "PhD student",
      "MD-PhD student",
    ]) {
      expect(isPubliclyDisplayed(label)).toBe(false);
    }
    // Faculty labels are equally unrecognized — they de-link rather than leak,
    // which is why the four unit-roster loaders must pass `roleCategoryRaw`.
    expect(isPubliclyDisplayed("Full-time faculty")).toBe(false);
  });

  it("accepts UPPER_SNAKE_CASE rows (ROLE_DISPLAY carries an uppercase half)", () => {
    expect(isPubliclyDisplayed("FULL_TIME_FACULTY")).toBe(true);
    expect(isPubliclyDisplayed("DOCTORAL_STUDENT_MD")).toBe(false);
  });

  it("keeps legacy ETL role values visible — the fail-closed flip must not hide them", () => {
    // deriveRoleCategory folds these into affiliated_faculty today, but pre-rewrite
    // rows may still carry them. See LEGACY_VISIBLE_ROLES in lib/eligibility.ts.
    for (const role of [
      "voluntary_faculty",
      "adjunct_faculty",
      "courtesy_faculty",
      "faculty_emeritus",
      "research_staff",
    ]) {
      expect(isPubliclyDisplayed(role)).toBe(true);
    }
  });

  it("HIDDEN_ROLE_CATEGORIES and the predicate cannot drift apart", () => {
    // The where-clause half (PEOPLE_INDEX_WHERE) enumerates values because Prisma
    // can't express the doctoral_student* prefix. This locks the two in sync.
    for (const role of HIDDEN_ROLE_CATEGORIES) {
      expect(isPubliclyDisplayed(role)).toBe(false);
    }
    for (const role of PUBLICLY_DISPLAYED_ROLES) {
      expect(HIDDEN_ROLE_CATEGORIES).not.toContain(role);
    }
  });
});

describe("publicRoleWhere() — the shared #536 carve as a where-fragment (#2222)", () => {
  it("admits NULL role_category EXPLICITLY — a bare notIn drops NULL rows", () => {
    // SQL three-valued logic: `NULL NOT IN (...)` is NULL, not TRUE. Without the
    // explicit `{ roleCategory: null }` arm every un-backfilled scholar would
    // silently vanish from the people index, the home hero count and the sitemap.
    expect(publicRoleWhere().OR).toContainEqual({ roleCategory: null });
  });

  it("enumerates exactly HIDDEN_ROLE_CATEGORIES in the notIn arm", () => {
    expect(publicRoleWhere().OR).toContainEqual({
      roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] },
    });
    // Two arms, no third: anything else here would widen or narrow the carve.
    expect(publicRoleWhere().OR).toHaveLength(2);
  });

  it("every enumerated value is one the predicate also hides", () => {
    const arm = publicRoleWhere().OR.find(
      (o): o is { roleCategory: { notIn: string[] } } =>
        typeof o.roleCategory === "object" && o.roleCategory !== null,
    )!;
    for (const role of arm.roleCategory.notIn) {
      expect(isPubliclyDisplayed(role)).toBe(false);
    }
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

describe("isEnrolledDoctoralStudent (#2599)", () => {
  it("matches every suffixed student variant the DB carries (#1026)", () => {
    for (const role of [
      "doctoral_student",
      "doctoral_student_md",
      "doctoral_student_phd",
      "doctoral_student_mdphd",
    ]) {
      expect(isEnrolledDoctoralStudent(role)).toBe(true);
    }
  });

  it("case-folds and trims, matching isPubliclyDisplayed's own normalization", () => {
    expect(isEnrolledDoctoralStudent("DOCTORAL_STUDENT")).toBe(true);
    expect(isEnrolledDoctoralStudent("  Doctoral_Student_PhD  ")).toBe(true);
  });

  it("returns FALSE for null/undefined — the OPPOSITE default from isPubliclyDisplayed", () => {
    // Absence of a role is not evidence of enrolment. isPubliclyDisplayed(null)
    // is true (don't hide un-backfilled scholars); this one is false (don't strip
    // an un-backfilled scholar's earned degree).
    expect(isEnrolledDoctoralStudent(null)).toBe(false);
    expect(isEnrolledDoctoralStudent(undefined)).toBe(false);
    expect(isPubliclyDisplayed(null)).toBe(true);
  });

  it("returns FALSE for every RECOGNIZED non-student role — an alumnus HAS the degree", () => {
    // `affiliate_alumni` is the load-bearing case: hidden from directed-traffic
    // surfaces like a student, but they finished. Suppressing their postnominal
    // would strip an earned doctorate.
    const NON_STUDENT_ROLES: RoleCategory[] = [
      "full_time_faculty",
      "affiliated_faculty",
      "affiliate_alumni",
      "postdoc",
      "fellow",
      "non_faculty_academic",
      "non_academic",
      "instructor",
      "lecturer",
      "emeritus",
    ];
    for (const role of NON_STUDENT_ROLES) {
      expect(isEnrolledDoctoralStudent(role)).toBe(false);
    }
    // The legacy values `LEGACY_VISIBLE_ROLES` keeps alive for pre-rewrite rows
    // are recognized too, so they keep their credential.
    for (const role of [
      "voluntary_faculty",
      "adjunct_faculty",
      "courtesy_faculty",
      "faculty_emeritus",
      "research_staff",
    ]) {
      expect(isEnrolledDoctoralStudent(role)).toBe(false);
    }
  });

  it("fails CLOSED on an unrecognized token — suppress rather than assert a credential", () => {
    // Changed by #2599's second pass. `former_doctoral_student` is NOT a real enum
    // value (no `deriveRoleCategory` branch emits it and it is in neither
    // PUBLICLY_DISPLAYED_ROLES nor LEGACY_VISIBLE_ROLES nor HIDDEN_ROLE_CATEGORIES),
    // so it is now unrecognized ⇒ treated as enrolled ⇒ postnominal suppressed. The
    // asymmetry: suppressing on an unknown role costs a degree suffix, admitting one
    // asserts a credential the person may not hold. Prefix-vs-substring is still
    // pinned by the recognized-roles case above, which is where it can be tested
    // without an unknown token confounding it.
    expect(isEnrolledDoctoralStudent("former_doctoral_student")).toBe(true);
    expect(isEnrolledDoctoralStudent("some_future_role")).toBe(true);
  });

  it("catches the humanized display labels formatRoleCategory emits — the #2202 shape", () => {
    // Both queue loaders call `formatRoleCategory` on the line AFTER
    // `formatPublishedName`. A label passed to the wrong one is two lines away and
    // raises no type error, which is exactly how #2202 published 684 students.
    for (const label of ["Doctoral student", "MD student", "PhD student", "MD-PhD student"]) {
      expect(isEnrolledDoctoralStudent(label)).toBe(true);
    }
  });

  it("is the single prefix source isPubliclyDisplayed hides on", () => {
    // The two halves cannot drift: every hidden student role fails the public gate.
    for (const role of HIDDEN_ROLE_CATEGORIES.filter((r) =>
      isEnrolledDoctoralStudent(r),
    )) {
      expect(isPubliclyDisplayed(role)).toBe(false);
    }
  });

  it("widening it to fail closed did NOT change isPubliclyDisplayed", () => {
    // The equivalence argued in isPubliclyDisplayed's docblock, executed: for every
    // token, the widened predicate's answer composed with the visible-set lookup
    // equals the ORIGINAL implementation (prefix-only student check, then the set).
    const VISIBLE_KEYS = new Set<string>([
      ...PUBLICLY_DISPLAYED_ROLES,
      "voluntary_faculty",
      "adjunct_faculty",
      "courtesy_faculty",
      "faculty_emeritus",
      "research_staff",
    ]);
    const prefixOnly = (r: string) => r.trim().toLowerCase().startsWith("doctoral_student");
    const original = (r: string | null | undefined): boolean => {
      if (r == null) return true;
      if (prefixOnly(r)) return false;
      return VISIBLE_KEYS.has(r.trim().toLowerCase());
    };
    const PROBES: Array<string | null | undefined> = [
      null,
      undefined,
      ...PUBLICLY_DISPLAYED_ROLES,
      ...HIDDEN_ROLE_CATEGORIES,
      "voluntary_faculty",
      "research_staff",
      "FULL_TIME_FACULTY",
      "  Doctoral_Student_PhD  ",
      "former_doctoral_student",
      "some_future_role",
      "Doctoral student",
      "MD student",
      "",
    ];
    for (const p of PROBES) {
      expect({ probe: p, out: isPubliclyDisplayed(p) }).toEqual({
        probe: p,
        out: original(p),
      });
    }
  });
});
