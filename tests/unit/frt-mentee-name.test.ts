import { describe, expect, it } from "vitest";
import { frtNameKey } from "@/lib/frt/mentee-name";

describe("frtNameKey", () => {
  it("keys on first + last token, ignoring middles, case and accents", () => {
    expect(frtNameKey("Jane Q. Doe")).toBe("jane|doe");
    expect(frtNameKey("  JOSÉ  García ")).toBe("jose|garcia");
  });
  it("flips 'Last, First' and drops honorifics and degrees", () => {
    expect(frtNameKey("Doe, Jane")).toBe("jane|doe");
    expect(frtNameKey("Dr. Jane Doe, MD, PhD")).toBe("jane|doe");
  });
  it("returns null when there is no first + last pair", () => {
    expect(frtNameKey("Jane")).toBeNull();
    expect(frtNameKey("")).toBeNull();
    expect(frtNameKey(null)).toBeNull();
  });
});
