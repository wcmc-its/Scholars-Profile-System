/**
 * The "Available technologies" `/edit` rail-item gating in `visibleAttrKeys`.
 *
 * The item is dropped unless the scholar has ≥1 CTL invention (the loader gates
 * the array on AVAILABLE_TECHNOLOGIES_SECTION, so an empty array here means "no
 * inventions or flag off"). It is public info — like publications/coi — so when
 * present it is visible to every edit surface (self / superuser / comms_steward /
 * proxy / unit-admin), NOT self-only like the coi-gap advisory.
 *
 * Signature: visibleAttrKeys(mode, slugRequestEnabled, hasCoiGap, hasHighlights,
 *   grantRecsEnabled, biosketchEnabled, cvEnabled, hasReporterProfile,
 *   hasTechnologies) — hasTechnologies is the 9th (trailing) arg.
 */
import { describe, expect, it } from "vitest";

import { visibleAttrKeys } from "@/components/edit/edit-page";

const withTech = (mode: Parameters<typeof visibleAttrKeys>[0]) =>
  visibleAttrKeys(mode, false, false, false, false, false, false, false, true);

describe("visibleAttrKeys — Available technologies rail gating", () => {
  it("drops technologies when hasTechnologies is false", () => {
    expect(visibleAttrKeys("self", false, false, false, false, false, false, false, false)).not.toContain(
      "technologies",
    );
    expect(visibleAttrKeys("superuser", false)).not.toContain("technologies");
  });

  it("does not leak technologies into a shorter (defaulted-arg) call", () => {
    // The biosketch / grant-recs tests call with ≤6 args; the 9th must default to
    // false so technologies never appears for them.
    expect(visibleAttrKeys("self", false, false, false, true, true)).not.toContain("technologies");
  });

  it("keeps technologies for every edit surface when hasTechnologies is true (public info)", () => {
    for (const mode of ["self", "superuser", "comms_steward", "proxy", "unit-admin"] as const) {
      expect(withTech(mode)).toContain("technologies");
    }
  });
});
