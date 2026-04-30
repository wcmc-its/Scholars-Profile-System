import { describe, expect, it } from "vitest";
import { initials } from "@/lib/utils";

describe("initials", () => {
  it("returns first letters of two-word name uppercased", () => {
    expect(initials("Jane Doe")).toBe("JD");
  });

  it("uppercases lowercase input", () => {
    expect(initials("jane doe")).toBe("JD");
  });

  it("returns at most two letters for multi-part names", () => {
    expect(initials("Augustine M.K. Choi")).toBe("AM");
  });

  it("returns single letter for one-word name", () => {
    expect(initials("Madonna")).toBe("M");
  });

  it("returns empty string for empty input", () => {
    expect(initials("")).toBe("");
  });

  it("collapses runs of whitespace", () => {
    expect(initials("Jane   Doe")).toBe("JD");
  });
});
