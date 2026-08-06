import { describe, expect, it } from "vitest";
import {
  ELIGIBLE_ROLES,
  HIDDEN_ROLE_CATEGORIES,
  publicRoleWhere,
  PUBLICLY_DISPLAYED_ROLES,
  TOP_SCHOLARS_ELIGIBLE_ROLES,
  isPubliclyDisplayed,
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
