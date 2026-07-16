/**
 * Unit tests for `validateHonorInput` (#1760) — the pure shape check behind the
 * create/update legs of `POST /api/edit/honor`. No DB / request harness: every
 * branch is exercised on a plain object.
 */
import { describe, expect, it } from "vitest";

import {
  CONFERRING_BODIES,
  HONOR_CATEGORIES,
  HONOR_CATEGORY_LABELS,
  HONOR_SOURCE_REF_MAX,
  HONOR_TEXT_MAX,
  HONOR_YEAR_MIN,
  honorYearMax,
  isHonorCategory,
  validateHonorInput,
} from "@/lib/edit/honor";

/** A minimal, valid create body. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "ACADEMY_MEMBERSHIP",
    name: "Member",
    organization: "National Academy of Sciences",
    ...overrides,
  };
}

describe("the shared /edit contract", () => {
  it("lists the categories in SCHEMA ENUM order (ACADEMY_MEMBERSHIP first)", () => {
    expect(HONOR_CATEGORIES).toEqual([
      "ACADEMY_MEMBERSHIP",
      "INVESTIGATORSHIP",
      "PRIZE",
      "OTHER",
    ]);
  });

  it("labels every category exactly once", () => {
    for (const c of HONOR_CATEGORIES) {
      expect(HONOR_CATEGORY_LABELS[c]).toBeTruthy();
    }
    expect(Object.keys(HONOR_CATEGORY_LABELS).sort()).toEqual([...HONOR_CATEGORIES].sort());
  });

  it("offers conferring bodies that are unique, trimmed and alphabetical", () => {
    expect(CONFERRING_BODIES.length).toBeGreaterThan(0);
    expect(new Set(CONFERRING_BODIES).size).toBe(CONFERRING_BODIES.length);
    for (const b of CONFERRING_BODIES) expect(b).toBe(b.trim());
    expect([...CONFERRING_BODIES]).toEqual([...CONFERRING_BODIES].sort());
  });

  it("includes the origin-request body (HHMI) among the options", () => {
    expect(CONFERRING_BODIES).toContain("Howard Hughes Medical Institute");
  });
});

describe("isHonorCategory", () => {
  it("accepts every controlled value", () => {
    for (const c of HONOR_CATEGORIES) expect(isHonorCategory(c)).toBe(true);
  });

  it("rejects anything else (incl. lowercase, non-string)", () => {
    expect(isHonorCategory("academy_membership")).toBe(false);
    expect(isHonorCategory("HONORARY_DEGREE")).toBe(false);
    expect(isHonorCategory(undefined)).toBe(false);
    expect(isHonorCategory(42)).toBe(false);
  });
});

describe("validateHonorInput — happy path", () => {
  it("accepts a minimal body and applies column defaults", () => {
    const r = validateHonorInput(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      category: "ACADEMY_MEMBERSHIP",
      name: "Member",
      organization: "National Academy of Sciences",
      year: null,
      sourceRef: null,
      showOnProfile: true,
    });
  });

  it("trims the free-text fields", () => {
    const r = validateHonorInput(
      base({ name: "  Fellow  ", organization: "  Royal Society  ", sourceRef: "  u  " }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("Fellow");
    expect(r.value.organization).toBe("Royal Society");
    expect(r.value.sourceRef).toBe("u");
  });

  it("blank / null sourceRef collapses to null", () => {
    for (const v of ["   ", "", null]) {
      const r = validateHonorInput(base({ sourceRef: v }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.sourceRef).toBeNull();
    }
  });

  it("accepts an organization that is NOT in CONFERRING_BODIES (free text, not an allowlist)", () => {
    const r = validateHonorInput(base({ organization: "Obscure Regional Society of Cartography" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.organization).toBe("Obscure Regional Society of Cartography");
  });

  it("accepts a year at each end of the allowed range", () => {
    for (const y of [HONOR_YEAR_MIN, honorYearMax()]) {
      const r = validateHonorInput(base({ year: y }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.year).toBe(y);
    }
  });

  it("honors an explicit showOnProfile", () => {
    const r = validateHonorInput(base({ showOnProfile: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.showOnProfile).toBe(false);
  });

  it("accepts name / organization exactly at the 255 cap", () => {
    expect(validateHonorInput(base({ name: "x".repeat(HONOR_TEXT_MAX) })).ok).toBe(true);
    expect(validateHonorInput(base({ organization: "x".repeat(HONOR_TEXT_MAX) })).ok).toBe(true);
  });

  it("ignores a status in the body — Phase 1 has no approval affordance", () => {
    const r = validateHonorInput(base({ status: "pending" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toHaveProperty("status");
  });
});

describe("validateHonorInput — rejections", () => {
  it("rejects a missing / invalid category", () => {
    expect(validateHonorInput(base({ category: undefined }))).toEqual({
      ok: false,
      error: "invalid_category",
      field: "category",
    });
    expect(validateHonorInput(base({ category: "HONORARY_DEGREE" }))).toEqual({
      ok: false,
      error: "invalid_category",
      field: "category",
    });
  });

  it("requires a non-blank name", () => {
    expect(validateHonorInput(base({ name: "   " }))).toEqual({
      ok: false,
      error: "required",
      field: "name",
    });
  });

  it("requires a non-blank organization", () => {
    expect(validateHonorInput(base({ organization: "" }))).toEqual({
      ok: false,
      error: "required",
      field: "organization",
    });
  });

  it("rejects a non-string required field", () => {
    expect(validateHonorInput(base({ name: 5 }))).toEqual({
      ok: false,
      error: "invalid_value",
      field: "name",
    });
  });

  it("rejects an over-length name / organization / sourceRef", () => {
    expect(validateHonorInput(base({ name: "x".repeat(HONOR_TEXT_MAX + 1) }))).toEqual({
      ok: false,
      error: "too_long",
      field: "name",
    });
    expect(validateHonorInput(base({ organization: "x".repeat(HONOR_TEXT_MAX + 1) }))).toEqual({
      ok: false,
      error: "too_long",
      field: "organization",
    });
    expect(validateHonorInput(base({ sourceRef: "x".repeat(HONOR_SOURCE_REF_MAX + 1) }))).toEqual({
      ok: false,
      error: "too_long",
      field: "sourceRef",
    });
  });

  it("rejects a bad year (out of range / non-integer / non-number)", () => {
    for (const bad of [HONOR_YEAR_MIN - 1, honorYearMax() + 1, 1990.5, "1990", 20260]) {
      expect(validateHonorInput(base({ year: bad }))).toEqual({
        ok: false,
        error: "invalid_year",
        field: "year",
      });
    }
  });

  it("rejects a non-boolean showOnProfile", () => {
    expect(validateHonorInput(base({ showOnProfile: "true" }))).toEqual({
      ok: false,
      error: "invalid_value",
      field: "showOnProfile",
    });
  });
});

describe("honorYearMax", () => {
  it("is next calendar year — prizes are announced ahead of conferral", () => {
    expect(honorYearMax(new Date("2026-07-16T00:00:00.000Z"))).toBe(2027);
  });

  it("does not go stale on Jan 1 (computed per call, not frozen at import)", () => {
    expect(honorYearMax(new Date("2030-01-01T00:00:00.000Z"))).toBe(2031);
  });
});
