import { describe, it, expect } from "vitest";
import { isActiveTrialStatus, isHiddenTrialStatus } from "@/lib/api/profile";

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

  it("hides withdrawn (CTgov) and institutionally SUSPENDED trials", () => {
    expect(isHiddenTrialStatus("Withdrawn")).toBe(true);
    expect(isHiddenTrialStatus("No longer available")).toBe(true);
    expect(isHiddenTrialStatus("SUSPENDED")).toBe(true);
    expect(isHiddenTrialStatus("OPEN TO ACCRUAL")).toBe(false);
    expect(isHiddenTrialStatus("CLOSED TO ACCRUAL")).toBe(false);
    expect(isHiddenTrialStatus("IRB STUDY CLOSURE")).toBe(false);
  });

  it("handles null/empty", () => {
    expect(isActiveTrialStatus(null)).toBe(false);
    expect(isActiveTrialStatus("")).toBe(false);
    expect(isHiddenTrialStatus(null)).toBe(false);
  });
});
