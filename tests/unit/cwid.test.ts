import { describe, it, expect } from "vitest";
import { CWID_PATTERN, isCwid } from "@/lib/cwid";
// The /edit validators must re-export the SAME object — one source of truth.
import { CWID_PATTERN as VALIDATORS_CWID_PATTERN } from "@/lib/edit/validators";

describe("isCwid / CWID_PATTERN", () => {
  it("accepts the common aaa1234 shape", () => {
    for (const c of ["baa2012", "abc1001", "jkl4004", "aog2001"]) {
      expect(isCwid(c)).toBe(true);
    }
  });

  it("accepts name-derived 'vanity' CWIDs (the 37 the old regex dropped)", () => {
    for (const c of ["nkaltork", "formenti", "barany", "mtalmor", "schwarh", "sgdavid", "glschatt"]) {
      expect(isCwid(c)).toBe(true);
    }
  });

  it("rejects malformed / non-CWID tokens", () => {
    for (const c of ["not-a-cwid", "bad-line", "", "ab", "Meyer", "1abc", "a".repeat(10)]) {
      expect(isCwid(c)).toBe(false);
    }
  });

  it("is lowercase-only — callers normalize before checking", () => {
    expect(isCwid("NKALTORK")).toBe(false);
    expect(isCwid("nkaltork")).toBe(true);
  });

  it("is the exact same pattern the /edit validators enforce", () => {
    expect(VALIDATORS_CWID_PATTERN).toBe(CWID_PATTERN);
  });
});
