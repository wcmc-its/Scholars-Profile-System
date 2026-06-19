import { describe, it, expect } from "vitest";
import { isActiveTrialStatus, isWithdrawnTrialStatus } from "@/lib/api/profile";

describe("clinical-trials status classification", () => {
  it("treats the institutional OPEN TO ACCRUAL as active", () => {
    expect(isActiveTrialStatus("OPEN TO ACCRUAL")).toBe(true);
  });

  it("treats the other institutional statuses as not active (completed bucket)", () => {
    expect(isActiveTrialStatus("CLOSED TO ACCRUAL")).toBe(false);
    expect(isActiveTrialStatus("IRB STUDY CLOSURE")).toBe(false);
    expect(isActiveTrialStatus("SUSPENDED")).toBe(false);
  });

  it("also classifies ClinicalTrials.gov statuses (enriched / future)", () => {
    expect(isActiveTrialStatus("Recruiting")).toBe(true);
    expect(isActiveTrialStatus("Active, not recruiting")).toBe(true);
    expect(isActiveTrialStatus("Completed")).toBe(false);
    expect(isActiveTrialStatus("Terminated")).toBe(false);
  });

  it("hides withdrawn (CTgov); no institutional status is withdrawn", () => {
    expect(isWithdrawnTrialStatus("Withdrawn")).toBe(true);
    expect(isWithdrawnTrialStatus("No longer available")).toBe(true);
    expect(isWithdrawnTrialStatus("OPEN TO ACCRUAL")).toBe(false);
    expect(isWithdrawnTrialStatus("SUSPENDED")).toBe(false);
  });

  it("handles null/empty", () => {
    expect(isActiveTrialStatus(null)).toBe(false);
    expect(isActiveTrialStatus("")).toBe(false);
    expect(isWithdrawnTrialStatus(null)).toBe(false);
  });
});
