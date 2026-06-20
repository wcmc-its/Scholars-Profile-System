/**
 * #917 v5 — the "NIH biosketch" `/edit` Services rail item gating.
 *
 * Covers the rail-gating rule in `visibleAttrKeys` (self/superuser only,
 * flag-gated — mirrors the grant-recs / coi-gap / highlights gating), and that
 * biosketch + grant-recs coexist as the two "Services" items. The panel render +
 * the generator are tested in `biosketch-generator.test.ts` /
 * `biosketch-generate-route.test.ts`.
 *
 * `visibleAttrKeys(mode, slugRequestEnabled, hasCoiGap, hasHighlights,
 *  grantRecsEnabled, biosketchEnabled)` — biosketchEnabled is the new 6th arg.
 */
import { describe, expect, it } from "vitest";

import { visibleAttrKeys } from "@/components/edit/edit-page";

describe("visibleAttrKeys — biosketch (Services) rail gating", () => {
  it("hides biosketch when the flag is off", () => {
    expect(visibleAttrKeys("self", false, false, false, false, false)).not.toContain("biosketch");
  });

  it("shows biosketch on self + superuser when the flag is on", () => {
    expect(visibleAttrKeys("self", false, false, false, false, true)).toContain("biosketch");
    expect(visibleAttrKeys("superuser", false, false, false, false, true)).toContain("biosketch");
  });

  it("never shows biosketch to a proxy / unit-admin even with the flag on", () => {
    expect(visibleAttrKeys("proxy", false, false, false, false, true)).not.toContain("biosketch");
    expect(visibleAttrKeys("unit-admin", false, false, false, false, true)).not.toContain(
      "biosketch",
    );
  });

  it("does not leak biosketch into the default-arg (omitted flag) call", () => {
    // The grant-recs tests call visibleAttrKeys with 5 args; the 6th must default
    // to false so biosketch never appears for them.
    expect(visibleAttrKeys("self", false, false, false, true)).not.toContain("biosketch");
  });

  it("surfaces BOTH Services items when both flags are on", () => {
    const keys = visibleAttrKeys("self", false, false, false, true, true);
    expect(keys).toContain("grant-recs");
    expect(keys).toContain("biosketch");
  });
});
