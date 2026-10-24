import { describe, expect, it } from "vitest";
import { isNihEligibleNamesake } from "@/etl/ed/namesakes";

describe("isNihEligibleNamesake", () => {
  it("counts current faculty, academic staff, postdocs and students", () => {
    for (const t of [
      "employee-faculty-new-york-fulltime",
      "employee-academic-new-york",
      "employee-postdoc-new-york",
      "student-md-new-york",
      "academic",
    ]) {
      expect(isNihEligibleNamesake({ primaryType: t, statuses: [] })).toBe(true);
    }
  });

  it("never counts affiliates, alumni or staff", () => {
    for (const t of [
      "affiliate-nyp-general",
      "affiliate-columbia",
      "affiliate-alumni",
      "faculty-affiliated-non-employee",
      "employee-staff-new-york",
    ]) {
      expect(isNihEligibleNamesake({ primaryType: t, statuses: [] })).toBe(false);
    }
  });

  it("reads former people by status, since they lose their type", () => {
    expect(isNihEligibleNamesake({ primaryType: null, statuses: ["faculty:expired"] })).toBe(true);
    expect(isNihEligibleNamesake({ primaryType: null, statuses: ["employee:expired"] })).toBe(true);
    expect(isNihEligibleNamesake({ primaryType: null, statuses: ["student:expired"] })).toBe(true);
    expect(isNihEligibleNamesake({ primaryType: null, statuses: ["affiliate:expired"] })).toBe(
      false,
    );
    expect(isNihEligibleNamesake({ primaryType: null, statuses: [] })).toBe(false);
  });

  it("never counts a retired CWID, which may be the scholar under an old ID", () => {
    expect(
      isNihEligibleNamesake({ primaryType: null, statuses: ["faculty:expired", "retired-cwid"] }),
    ).toBe(false);
  });
});
