/**
 * The "Honors & Distinctions" `/edit` rail item (#1760 follow-up).
 *
 * Honors shipped as a sub-card INSIDE the Appointments tab, which made it
 * undiscoverable — an honor is not an appointment, and it has its own profile
 * section. It is now its own attribute, a sibling of Appointments. These tests
 * pin that so it cannot silently regress back into another tab.
 *
 * Ungated: unlike technologies / coi-gap / biosketch there is no flag and no
 * "has rows" precondition — a scholar with no honors still needs the tab in
 * order to ADD one. So it appears on every edit surface that may write.
 */
import { describe, expect, it } from "vitest";

import { visibleAttrKeys } from "@/components/edit/edit-page";

describe("visibleAttrKeys — Honors & Distinctions rail item", () => {
  it("is its OWN rail key, not nested under appointments", () => {
    expect(visibleAttrKeys("self", false)).toContain("honors");
  });

  it("sits immediately after Appointments in the rail, as a sibling", () => {
    const keys = visibleAttrKeys("self", false);
    expect(keys.indexOf("honors")).toBe(keys.indexOf("appointments") + 1);
  });

  it("appears for every edit surface the write route authorizes", () => {
    // self / superuser / comms_steward / proxy / unit-admin — the same set
    // app/api/edit/honor/route.ts admits via authorizeOverviewWrite.
    for (const mode of ["self", "superuser", "comms_steward", "proxy", "unit-admin"] as const) {
      expect(visibleAttrKeys(mode, false)).toContain("honors");
    }
  });

  it("is not gated behind a flag or a has-rows precondition", () => {
    // A scholar with nothing yet must still reach the tab to add their first honor.
    // Every optional arg false = the emptiest possible profile.
    expect(
      visibleAttrKeys("self", false, false, false, false, false, false, false, false),
    ).toContain("honors");
  });
});
