import { describe, expect, it } from "vitest";
import { headshotUrl, identityImageEndpoint } from "@/lib/headshot";

describe("headshotUrl", () => {
  it("emits an empty string for a scholar known to have no photo", () => {
    expect(headshotUrl("abc1234", false)).toBe("");
  });

  it("keeps the live directory URL when a photo exists", () => {
    expect(headshotUrl("abc1234", true)).toBe(identityImageEndpoint("abc1234"));
  });

  it("keeps the live URL when presence is unknown (null or absent)", () => {
    expect(headshotUrl("abc1234", null)).toBe(identityImageEndpoint("abc1234"));
    expect(headshotUrl("abc1234", undefined)).toBe(identityImageEndpoint("abc1234"));
  });
});
