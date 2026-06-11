import { describe, expect, it } from "vitest";

import {
  gateEmailForViewer,
  isEmailVisibleToViewer,
} from "@/lib/profile/email-display-gate";

/**
 * Table A of docs/email-visibility-spec.md (profile email display). The pure gate
 * is independent of the feature flag and the request layer; the caller supplies
 * the resolved `internalViewer` boolean (#866) and the gate-enabled boolean.
 *
 * SPEC edge-case table coverage (profile rows):
 *   #1  {public, institution} → 'public', anon off-campus  → shown
 *   #2  {institution}         → 'institution', anon off    → hidden
 *   #3  {institution}         → 'institution', internal     → shown
 *   #4  {institution}         → 'institution', internal     → shown (on-net = internal)
 *   #5  {} absent             → null, internal              → hidden
 *   #6  {public}              → 'public', anon off-campus   → shown
 *   #7  unrecognized only     → 'none', internal            → hidden (fail-closed)
 *   #13 gate OFF              → email shown regardless (legacy)
 */
describe("isEmailVisibleToViewer — table A", () => {
  it("row 1/6: public → shown to an external viewer", () => {
    expect(isEmailVisibleToViewer("public", false)).toBe(true);
  });

  it("public → shown to an internal viewer", () => {
    expect(isEmailVisibleToViewer("public", true)).toBe(true);
  });

  it("row 2: institution → hidden from an external viewer", () => {
    expect(isEmailVisibleToViewer("institution", false)).toBe(false);
  });

  it("row 3/4: institution → shown to an internal viewer (session OR on-network)", () => {
    expect(isEmailVisibleToViewer("institution", true)).toBe(true);
  });

  it("row 5: absent (null) → hidden even from an internal viewer (fail-closed)", () => {
    expect(isEmailVisibleToViewer(null, true)).toBe(false);
    expect(isEmailVisibleToViewer(null, false)).toBe(false);
    expect(isEmailVisibleToViewer(undefined, true)).toBe(false);
  });

  it("explicit 'none' → hidden from any viewer", () => {
    expect(isEmailVisibleToViewer("none", true)).toBe(false);
    expect(isEmailVisibleToViewer("none", false)).toBe(false);
  });

  it("row 7: unrecognized value → hidden even from an internal viewer (fail-closed)", () => {
    expect(isEmailVisibleToViewer("private", true)).toBe(false);
    expect(isEmailVisibleToViewer("PUBLIC", true)).toBe(false); // case-sensitive: parser lowercases
    expect(isEmailVisibleToViewer("", true)).toBe(false);
  });
});

describe("gateEmailForViewer — flag-aware wrapper", () => {
  const EMAIL = "person@med.cornell.edu";

  it("row 13: gate OFF → email returned to everyone regardless of visibility", () => {
    // institution + external would normally be hidden — but the gate is off.
    expect(gateEmailForViewer(EMAIL, "institution", false, false)).toBe(EMAIL);
    expect(gateEmailForViewer(EMAIL, null, false, false)).toBe(EMAIL);
    expect(gateEmailForViewer(EMAIL, "none", false, false)).toBe(EMAIL);
  });

  it("gate OFF preserves a null email as null", () => {
    expect(gateEmailForViewer(null, "public", true, false)).toBeNull();
  });

  it("row 1/6: gate ON, public → email returned to an external viewer", () => {
    expect(gateEmailForViewer(EMAIL, "public", false, true)).toBe(EMAIL);
  });

  it("row 2: gate ON, institution + external → null (withheld)", () => {
    expect(gateEmailForViewer(EMAIL, "institution", false, true)).toBeNull();
  });

  it("row 3/4: gate ON, institution + internal → email returned", () => {
    expect(gateEmailForViewer(EMAIL, "institution", true, true)).toBe(EMAIL);
  });

  it("row 5/7: gate ON, null or unrecognized → null even for an internal viewer", () => {
    expect(gateEmailForViewer(EMAIL, null, true, true)).toBeNull();
    expect(gateEmailForViewer(EMAIL, "private", true, true)).toBeNull();
  });

  it("gate ON, a null email stays null no matter the verdict", () => {
    expect(gateEmailForViewer(null, "public", true, true)).toBeNull();
  });
});
