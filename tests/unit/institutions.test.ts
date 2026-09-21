import { describe, expect, it } from "vitest";
import { visibleInstitutionName } from "@/lib/institutions";

describe("visibleInstitutionName — absence-as-default for public labels", () => {
  it("names a non-home institution", () => {
    expect(visibleInstitutionName("HSS")).toBe("Hospital for Special Surgery");
  });

  it("is null for the home institution (WCM scholars render as before)", () => {
    expect(visibleInstitutionName("WCMC")).toBeNull();
  });

  it("is null for an unset code", () => {
    expect(visibleInstitutionName(null)).toBeNull();
    expect(visibleInstitutionName("")).toBeNull();
  });
});
