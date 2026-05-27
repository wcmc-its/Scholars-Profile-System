/**
 * `validateRequestedSlug` + `containsProfanity` (#497 §6.2/§6.3) — the PR-3
 * request-path slug validation, layered on the shipped `validateSlugFormat`.
 */
import { describe, expect, it } from "vitest";

import { containsProfanity } from "@/lib/edit/profanity";
import { validateRequestedSlug } from "@/lib/edit/validators";

describe("validateRequestedSlug", () => {
  it("accepts a well-formed slug and returns the normalized value", () => {
    expect(validateRequestedSlug("jane-smith")).toEqual({ ok: true, value: "jane-smith" });
  });

  it("lowercases / trims (case-insensitive normalize)", () => {
    expect(validateRequestedSlug("  Jane-Smith  ")).toEqual({ ok: true, value: "jane-smith" });
  });

  it("rejects a reserved route word", () => {
    expect(validateRequestedSlug("search")).toEqual({ ok: false, error: "reserved" });
    expect(validateRequestedSlug("by-cwid")).toEqual({ ok: false, error: "reserved" });
  });

  it("rejects bad format (spaces, illegal chars, double hyphen)", () => {
    expect(validateRequestedSlug("bad slug")).toEqual({ ok: false, error: "format" });
    expect(validateRequestedSlug("a--b")).toEqual({ ok: false, error: "format" });
    expect(validateRequestedSlug("-lead")).toEqual({ ok: false, error: "format" });
  });

  it("rejects an over-length slug (> 64)", () => {
    expect(validateRequestedSlug("a".repeat(65))).toEqual({ ok: false, error: "too_long" });
  });

  it("rejects a single character (too_short)", () => {
    expect(validateRequestedSlug("a")).toEqual({ ok: false, error: "too_short" });
  });

  it("rejects a purely-numeric slug (could shadow /123 / look like a CWID)", () => {
    expect(validateRequestedSlug("12345")).toEqual({ ok: false, error: "numeric" });
  });

  it("rejects an obvious profane token", () => {
    expect(validateRequestedSlug("john-fuck-smith")).toEqual({ ok: false, error: "profanity" });
  });

  it("does NOT reject a real surname that merely contains a flagged substring", () => {
    // Scunthorpe guard: token-exact matching, not substring.
    expect(validateRequestedSlug("cockburn")).toEqual({ ok: true, value: "cockburn" });
    expect(validateRequestedSlug("shitake-tan")).toEqual({ ok: true, value: "shitake-tan" });
  });
});

describe("containsProfanity", () => {
  it("flags an exact profane token", () => {
    expect(containsProfanity("a-fuck-b")).toBe(true);
    expect(containsProfanity("shit")).toBe(true);
  });

  it("is name-safe (no substring matching)", () => {
    expect(containsProfanity("cockburn")).toBe(false);
    expect(containsProfanity("scunthorpe")).toBe(false);
    expect(containsProfanity("jane-smith")).toBe(false);
  });
});
