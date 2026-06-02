/**
 * lib/profile-url.ts — people profile URL helpers (#671).
 *
 * `profilePath` is pure (always the root `/{slug}` end-state, safe in client
 * components); `isRootCanonical` / `canonicalProfilePath` are server-side and
 * honor `PROFILE_CANONICAL` (default = legacy `/scholars/{slug}`).
 */
import { describe, expect, it, afterEach } from "vitest";
import { profilePath, isRootCanonical, canonicalProfilePath } from "@/lib/profile-url";

const ORIGINAL = process.env.PROFILE_CANONICAL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PROFILE_CANONICAL;
  else process.env.PROFILE_CANONICAL = ORIGINAL;
});

describe("profilePath", () => {
  it("always returns the root form, independent of the flag", () => {
    delete process.env.PROFILE_CANONICAL;
    expect(profilePath("jane-smith")).toBe("/jane-smith");
    process.env.PROFILE_CANONICAL = "root";
    expect(profilePath("jane-smith")).toBe("/jane-smith");
    process.env.PROFILE_CANONICAL = "scholars";
    expect(profilePath("jane-smith")).toBe("/jane-smith");
  });
});

describe("isRootCanonical / canonicalProfilePath", () => {
  it("defaults to the /scholars form when PROFILE_CANONICAL is unset", () => {
    delete process.env.PROFILE_CANONICAL;
    expect(isRootCanonical()).toBe(false);
    expect(canonicalProfilePath("jane-smith")).toBe("/scholars/jane-smith");
  });

  it('uses the /scholars form for any non-"root" value', () => {
    process.env.PROFILE_CANONICAL = "scholars";
    expect(isRootCanonical()).toBe(false);
    expect(canonicalProfilePath("jane-smith")).toBe("/scholars/jane-smith");
  });

  it('uses the root form when PROFILE_CANONICAL = "root"', () => {
    process.env.PROFILE_CANONICAL = "root";
    expect(isRootCanonical()).toBe(true);
    expect(canonicalProfilePath("jane-smith")).toBe("/jane-smith");
  });
});
