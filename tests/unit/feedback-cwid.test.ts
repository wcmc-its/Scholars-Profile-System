/**
 * `normalizeUserCwid` (#538 PR-1) — validate + normalize the optional
 * user-typed CWID on the feedback form.
 */
import { describe, expect, it } from "vitest";

import { normalizeUserCwid } from "@/lib/feedback/cwid";

describe("normalizeUserCwid", () => {
  it("accepts a typical WCM CWID lowercase", () => {
    expect(normalizeUserCwid("abc1234")).toBe("abc1234");
  });

  it("lowercases an uppercase CWID", () => {
    expect(normalizeUserCwid("ABC1234")).toBe("abc1234");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUserCwid("  abc1234  ")).toBe("abc1234");
  });

  it("returns null for empty / null / undefined / whitespace", () => {
    expect(normalizeUserCwid("")).toBeNull();
    expect(normalizeUserCwid(null)).toBeNull();
    expect(normalizeUserCwid(undefined)).toBeNull();
    expect(normalizeUserCwid("    ")).toBeNull();
  });

  it("rejects too-short CWID (<2 chars)", () => {
    expect(normalizeUserCwid("a")).toBeNull();
  });

  it("rejects too-long CWID (>16 chars)", () => {
    expect(normalizeUserCwid("a".repeat(17))).toBeNull();
  });

  it("rejects CWIDs with hyphens / dots / underscores / spaces", () => {
    expect(normalizeUserCwid("abc-1234")).toBeNull();
    expect(normalizeUserCwid("abc.1234")).toBeNull();
    expect(normalizeUserCwid("abc_1234")).toBeNull();
    expect(normalizeUserCwid("abc 1234")).toBeNull();
  });

  it("rejects emails / URLs / sentences (common bad inputs)", () => {
    expect(normalizeUserCwid("jane@cornell.edu")).toBeNull();
    expect(normalizeUserCwid("https://example.com")).toBeNull();
    expect(normalizeUserCwid("Jane Smith")).toBeNull();
  });

  it("rejects non-string types defensively", () => {
    // @ts-expect-error -- number is not assignable to the string|null|undefined signature; the guard is the point under test
    expect(normalizeUserCwid(12345)).toBeNull();
    // @ts-expect-error -- object is not assignable to the string|null|undefined signature; the guard is the point under test
    expect(normalizeUserCwid({ cwid: "abc1234" })).toBeNull();
  });

  it("accepts pure-numeric CWID (some WCM accounts have them)", () => {
    expect(normalizeUserCwid("12345")).toBe("12345");
  });

  it("accepts minimum-length 2-char CWID", () => {
    expect(normalizeUserCwid("ab")).toBe("ab");
  });

  it("accepts maximum-length 16-char CWID", () => {
    expect(normalizeUserCwid("a".repeat(16))).toBe("a".repeat(16));
  });
});
