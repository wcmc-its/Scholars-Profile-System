import { describe, expect, it } from "vitest";
import { authorshipRoleFromFlags } from "@/components/scholar/person-card-role-pill";

describe("authorshipRoleFromFlags (#242 role pill)", () => {
  it("first + last → first-and-senior (single-author paper)", () => {
    expect(authorshipRoleFromFlags(true, true, 1, 1)).toBe("first-and-senior");
  });

  it("first alone, single first author → first", () => {
    expect(authorshipRoleFromFlags(true, false, 1, 1)).toBe("first");
  });

  it("first alone, multiple first authors → co-first", () => {
    expect(authorshipRoleFromFlags(true, false, 2, 1)).toBe("co-first");
  });

  it("last alone, single senior author → senior", () => {
    expect(authorshipRoleFromFlags(false, true, 1, 1)).toBe("senior");
  });

  it("last alone, multiple senior authors → co-senior", () => {
    expect(authorshipRoleFromFlags(false, true, 1, 2)).toBe("co-senior");
  });

  it("neither flag → co-author", () => {
    expect(authorshipRoleFromFlags(false, false, 1, 1)).toBe("co-author");
  });
});
