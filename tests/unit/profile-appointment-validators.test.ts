/**
 * Unit tests for `validateProfileAppointmentInput` (#1568) — the pure shape
 * check behind the create/update legs of `POST /api/edit/appointment`. No DB /
 * request harness: every branch is exercised on a plain object.
 */
import { describe, expect, it } from "vitest";

import {
  PROFILE_APPOINTMENT_TEXT_MAX,
  isProfileAppointmentCategory,
  validateProfileAppointmentInput,
} from "@/lib/edit/profile-appointment";

/** A minimal, valid create body. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "WCM_LEADERSHIP",
    title: "Program Director",
    organization: "Weill Cornell Medicine",
    ...overrides,
  };
}

describe("isProfileAppointmentCategory", () => {
  it("accepts the two controlled values", () => {
    expect(isProfileAppointmentCategory("WCM_LEADERSHIP")).toBe(true);
    expect(isProfileAppointmentCategory("EXTERNAL")).toBe(true);
  });

  it("rejects anything else (incl. lowercase, non-string)", () => {
    expect(isProfileAppointmentCategory("wcm_leadership")).toBe(false);
    expect(isProfileAppointmentCategory("INTERNAL")).toBe(false);
    expect(isProfileAppointmentCategory(undefined)).toBe(false);
    expect(isProfileAppointmentCategory(42)).toBe(false);
  });
});

describe("validateProfileAppointmentInput — happy path", () => {
  it("accepts a minimal body and applies column defaults", () => {
    const r = validateProfileAppointmentInput(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      category: "WCM_LEADERSHIP",
      title: "Program Director",
      organization: "Weill Cornell Medicine",
      unit: null,
      location: null,
      startDate: null,
      endDate: null,
      sortOrder: 0,
      showOnProfile: true,
    });
  });

  it("trims the free-text fields", () => {
    const r = validateProfileAppointmentInput(
      base({ title: "  Head of Section  ", organization: "  WCM  ", unit: "  Cardiology  " }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe("Head of Section");
    expect(r.value.organization).toBe("WCM");
    expect(r.value.unit).toBe("Cardiology");
  });

  it("blank optional text collapses to null", () => {
    const r = validateProfileAppointmentInput(base({ unit: "   ", location: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unit).toBeNull();
    expect(r.value.location).toBeNull();
  });

  it("parses YYYY-MM-DD dates to UTC-midnight Dates", () => {
    const r = validateProfileAppointmentInput(
      base({ startDate: "2018-07-01", endDate: "2022-06-30" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.startDate?.toISOString()).toBe("2018-07-01T00:00:00.000Z");
    expect(r.value.endDate?.toISOString()).toBe("2022-06-30T00:00:00.000Z");
  });

  it("allows an open-ended range (start only, no end = current)", () => {
    const r = validateProfileAppointmentInput(base({ startDate: "2020-01-01" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.startDate?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(r.value.endDate).toBeNull();
  });

  it("allows equal start/end dates", () => {
    const r = validateProfileAppointmentInput(
      base({ startDate: "2020-01-01", endDate: "2020-01-01" }),
    );
    expect(r.ok).toBe(true);
  });

  it("honors an explicit sortOrder / showOnProfile", () => {
    const r = validateProfileAppointmentInput(base({ sortOrder: 3, showOnProfile: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sortOrder).toBe(3);
    expect(r.value.showOnProfile).toBe(false);
  });
});

describe("validateProfileAppointmentInput — rejections", () => {
  it("rejects a missing / invalid category", () => {
    expect(validateProfileAppointmentInput(base({ category: undefined }))).toEqual({
      ok: false,
      error: "invalid_category",
      field: "category",
    });
    expect(validateProfileAppointmentInput(base({ category: "OTHER" }))).toEqual({
      ok: false,
      error: "invalid_category",
      field: "category",
    });
  });

  it("requires a non-blank title", () => {
    expect(validateProfileAppointmentInput(base({ title: "   " }))).toEqual({
      ok: false,
      error: "required",
      field: "title",
    });
  });

  it("requires a non-blank organization", () => {
    expect(validateProfileAppointmentInput(base({ organization: "" }))).toEqual({
      ok: false,
      error: "required",
      field: "organization",
    });
  });

  it("rejects a non-string required field", () => {
    expect(validateProfileAppointmentInput(base({ title: 5 }))).toEqual({
      ok: false,
      error: "invalid_value",
      field: "title",
    });
  });

  it("rejects an over-length title / organization / unit / location", () => {
    const long = "x".repeat(PROFILE_APPOINTMENT_TEXT_MAX + 1);
    expect(validateProfileAppointmentInput(base({ title: long }))).toEqual({
      ok: false,
      error: "too_long",
      field: "title",
    });
    expect(validateProfileAppointmentInput(base({ unit: long }))).toEqual({
      ok: false,
      error: "too_long",
      field: "unit",
    });
  });

  it("accepts a title exactly at the 255 cap", () => {
    const r = validateProfileAppointmentInput(base({ title: "x".repeat(PROFILE_APPOINTMENT_TEXT_MAX) }));
    expect(r.ok).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(validateProfileAppointmentInput(base({ startDate: "2020/01/01" }))).toEqual({
      ok: false,
      error: "invalid_date",
      field: "startDate",
    });
    expect(validateProfileAppointmentInput(base({ endDate: "not-a-date" }))).toEqual({
      ok: false,
      error: "invalid_date",
      field: "endDate",
    });
  });

  it("rejects a reversed date range (end < start)", () => {
    expect(
      validateProfileAppointmentInput(base({ startDate: "2022-01-01", endDate: "2020-01-01" })),
    ).toEqual({ ok: false, error: "invalid_date_range", field: "endDate" });
  });

  it("rejects a bad sortOrder (negative / non-integer / oversized / non-number)", () => {
    for (const bad of [-1, 1.5, 100_000, "3"]) {
      expect(validateProfileAppointmentInput(base({ sortOrder: bad }))).toEqual({
        ok: false,
        error: "invalid_value",
        field: "sortOrder",
      });
    }
  });

  it("rejects a non-boolean showOnProfile", () => {
    expect(validateProfileAppointmentInput(base({ showOnProfile: "true" }))).toEqual({
      ok: false,
      error: "invalid_value",
      field: "showOnProfile",
    });
  });
});
