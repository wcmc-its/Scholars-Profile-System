import { describe, expect, it } from "vitest";
import { isMedicalDegree, isPhysicianFrom } from "@/lib/medical-degree";
import { isMedicalDegree as matchaIsMedicalDegree } from "@/lib/api/matcha-contract";

describe("isMedicalDegree", () => {
  it("matches medical degree families in any punctuation", () => {
    for (const d of ["MD", "M.D.", "MD-PhD", "MD, MPH", "PhD, MD", "DO", "MBBS", "MBChB"]) {
      expect(isMedicalDegree(d)).toBe(true);
    }
  });
  it("excludes dental, psychology, nursing and research degrees", () => {
    for (const d of ["DDS", "DMD", "PsyD", "PhD", "DNP", "PharmD", "MPH", "", null, undefined]) {
      expect(isMedicalDegree(d)).toBe(false);
    }
  });
  it("Matcha re-exports the shared function", () => {
    expect(matchaIsMedicalDegree).toBe(isMedicalDegree);
  });
});

describe("isPhysicianFrom", () => {
  it("education rows decide when present", () => {
    expect(isPhysicianFrom({ hasClinicalProfile: false, educations: [{ degree: "MD" }] })).toBe(
      true,
    );
    expect(isPhysicianFrom({ hasClinicalProfile: true, educations: [{ degree: "PhD" }] })).toBe(
      false,
    );
  });
  it("falls back to hasClinicalProfile with no education rows", () => {
    expect(isPhysicianFrom({ hasClinicalProfile: true, educations: [] })).toBe(true);
    expect(isPhysicianFrom({ hasClinicalProfile: true })).toBe(true);
    expect(isPhysicianFrom({ hasClinicalProfile: false, educations: null })).toBe(false);
  });
});
