import { describe, expect, it } from "vitest";

import { parseEmailReleaseAudience } from "@/lib/sources/ldap";

describe("parseEmailReleaseAudience (email visibility)", () => {
  it("returns 'public' when the set contains public + institution", () => {
    // Live record paa2013 → {institution, public} → public.
    expect(parseEmailReleaseAudience(["institution", "public"])).toBe("public");
  });

  it("returns 'institution' when the set has institution only", () => {
    expect(parseEmailReleaseAudience(["institution"])).toBe("institution");
  });

  it("returns 'public' when the set has public only", () => {
    expect(parseEmailReleaseAudience(["public"])).toBe("public");
  });

  it("fails closed to 'none' for an empty set", () => {
    expect(parseEmailReleaseAudience([])).toBe("none");
  });

  it("fails closed to 'none' for an absent attribute", () => {
    expect(parseEmailReleaseAudience(undefined)).toBe("none");
    expect(parseEmailReleaseAudience(null)).toBe("none");
  });

  it("fails closed to 'none' for an explicit unrecognized 'private'", () => {
    expect(parseEmailReleaseAudience(["private"])).toBe("none");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseEmailReleaseAudience(["  Public  "])).toBe("public");
    expect(parseEmailReleaseAudience([" INSTITUTION "])).toBe("institution");
    expect(parseEmailReleaseAudience(["Private", "Institution"])).toBe(
      "institution",
    );
  });

  it("most-permissive-wins regardless of value order", () => {
    expect(parseEmailReleaseAudience(["public", "institution"])).toBe("public");
    expect(parseEmailReleaseAudience(["institution", "public"])).toBe("public");
  });

  it("accepts a single-valued (string) attribute", () => {
    expect(parseEmailReleaseAudience("public")).toBe("public");
    expect(parseEmailReleaseAudience("institution")).toBe("institution");
  });
});
