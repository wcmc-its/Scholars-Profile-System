/**
 * lib/profile-url.ts — people profile URL helpers (#671).
 *
 * Both `profilePath` and `canonicalProfilePath` are pure now: the
 * `PROFILE_CANONICAL` rollback flag was removed once the #671 cutover soak
 * closed out (live in both envs since 2026-07-14), so `/{slug}` is the only
 * canonical form.
 */
import { describe, expect, it } from "vitest";
import { profilePath, canonicalProfilePath } from "@/lib/profile-url";

describe("profilePath", () => {
  it("returns the root form", () => {
    expect(profilePath("jane-smith")).toBe("/jane-smith");
  });
});

describe("canonicalProfilePath", () => {
  it("returns the root form", () => {
    expect(canonicalProfilePath("jane-smith")).toBe("/jane-smith");
  });
});
