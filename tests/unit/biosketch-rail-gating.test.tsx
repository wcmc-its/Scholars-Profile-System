/**
 * #917 v5 — the "NIH biosketch" `/edit` Services rail item gating.
 *
 * Covers the rail-gating rule in `visibleAttrKeys` (flag-gated, then visible to
 * every actor the generate route authorizes — self, superuser, comms-steward,
 * proxy, unit-admin), and that biosketch + grant-recs coexist as the two
 * "Services" items. The panel render +
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

  it("shows biosketch to every authorized editor when the flag is on", () => {
    // The generate route authorizes self, superuser, comms-steward, a granted
    // proxy, and an org-unit owner/curator (unit-admin) — the rail mirrors that.
    expect(visibleAttrKeys("self", false, false, false, false, true)).toContain("biosketch");
    expect(visibleAttrKeys("superuser", false, false, false, false, true)).toContain("biosketch");
    expect(visibleAttrKeys("comms_steward", false, false, false, false, true)).toContain(
      "biosketch",
    );
    expect(visibleAttrKeys("proxy", false, false, false, false, true)).toContain("biosketch");
    expect(visibleAttrKeys("unit-admin", false, false, false, false, true)).toContain("biosketch");
  });

  it("hides biosketch from a proxy / unit-admin when the flag is off", () => {
    expect(visibleAttrKeys("proxy", false, false, false, false, false)).not.toContain("biosketch");
    expect(visibleAttrKeys("unit-admin", false, false, false, false, false)).not.toContain(
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
