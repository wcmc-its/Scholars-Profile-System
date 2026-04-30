import { describe, expect, it } from "vitest";
import { initials } from "@/lib/utils";

describe("initials", () => {
  it("returns two-letter initials for a two-word name", () => {
    expect(initials("Jane Doe")).toBe("JD");
  });

  it("uppercases the result", () => {
    expect(initials("jane doe")).toBe("JD");
  });

  it("caps at two letters for three+ word names", () => {
    expect(initials("Augustine M.K. Choi")).toBe("AM");
  });

  it("returns a single letter for a single-word name", () => {
    expect(initials("Madonna")).toBe("M");
  });

  it("handles empty string without throwing", () => {
    expect(initials("")).toBe("");
  });

  it("collapses repeated whitespace", () => {
    expect(initials("Jane   Doe")).toBe("JD");
  });
});
