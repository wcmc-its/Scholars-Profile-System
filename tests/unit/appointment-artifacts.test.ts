/**
 * lib/appointment-artifacts.ts (#1323 follow-up) — filtering WOOFA data-entry
 * artifacts out of a scholar's public Past Appointments.
 */
import { describe, expect, it } from "vitest";

import {
  looksLikeArtifactAppointment,
  PRE_START_ACADEMIC_TITLE,
  shouldSuppressPreStart,
} from "@/lib/appointment-artifacts";

describe("looksLikeArtifactAppointment", () => {
  it("flags a same-day-to-next-day span (the '(Interim)' title-swap shape)", () => {
    expect(looksLikeArtifactAppointment(new Date("2019-09-01"), new Date("2019-09-02"))).toBe(true);
  });

  it("flags an exactly-7-day span (the boundary)", () => {
    expect(looksLikeArtifactAppointment(new Date("2025-01-08"), new Date("2025-01-15"))).toBe(true);
  });

  it("does not flag an 8-day span (one past the boundary)", () => {
    expect(looksLikeArtifactAppointment(new Date("2025-01-08"), new Date("2025-01-16"))).toBe(false);
  });

  it("does not flag a genuine multi-year appointment", () => {
    expect(looksLikeArtifactAppointment(new Date("1991-05-01"), new Date("2017-06-30"))).toBe(false);
  });

  it("does not flag an open-ended appointment (null end date)", () => {
    expect(looksLikeArtifactAppointment(new Date("1991-05-01"), null)).toBe(false);
  });

  it("flags an end-before-start row (the rare negative-duration data bug)", () => {
    expect(looksLikeArtifactAppointment(new Date("2026-08-10"), new Date("2026-06-25"))).toBe(true);
  });
});

describe("shouldSuppressPreStart", () => {
  it("does not suppress a Pre-Start row that is the scholar's only appointment", () => {
    expect(shouldSuppressPreStart(PRE_START_ACADEMIC_TITLE, 1)).toBe(false);
  });

  it("suppresses a Pre-Start row once any other appointment exists", () => {
    expect(shouldSuppressPreStart(PRE_START_ACADEMIC_TITLE, 2)).toBe(true);
  });

  it("suppresses a Pre-Start row even with many other appointments", () => {
    expect(shouldSuppressPreStart(PRE_START_ACADEMIC_TITLE, 12)).toBe(true);
  });

  it("never suppresses a non-Pre-Start title, regardless of count", () => {
    expect(shouldSuppressPreStart("Professor of Medicine", 1)).toBe(false);
    expect(shouldSuppressPreStart("Professor of Medicine", 5)).toBe(false);
  });
});
