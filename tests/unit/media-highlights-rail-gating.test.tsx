/**
 * The "Media highlights" `/edit` rail item in `visibleAttrKeys`: dropped unless
 * the scholar has ≥1 approved clip (the loader gates `ctx.mediaHighlights` on
 * MEDIA_HIGHLIGHTS_SECTION), and otherwise offered on exactly the surfaces that
 * get "News mentions" — the same card, the same hide / "Not me" writes.
 *
 * `hasMediaHighlights` is the LAST positional arg (15th), after
 * profileLinksEnabled, so every shorter call defaults it off.
 */
import { describe, expect, it } from "vitest";

import { visibleAttrKeys } from "@/components/edit/edit-page";

type Mode = Parameters<typeof visibleAttrKeys>[0];
const MODES: Mode[] = ["self", "superuser", "comms_steward", "proxy", "unit-admin"];

// hasNews (10th) and hasMediaHighlights (15th) set together; everything else off.
const keys = (mode: Mode, has: boolean) =>
  visibleAttrKeys(mode, false, false, false, false, false, false, false, false, has, false, false, false, false, has);

describe("visibleAttrKeys — Media highlights rail gating", () => {
  it("drops media-highlights when there is no approved clip", () => {
    for (const mode of MODES) expect(keys(mode, false)).not.toContain("media-highlights");
    expect(visibleAttrKeys("self", false)).not.toContain("media-highlights");
  });

  it("is offered on exactly the surfaces that get News mentions", () => {
    for (const mode of MODES) {
      const k = keys(mode, true);
      expect(k.includes("media-highlights")).toBe(k.includes("news"));
    }
    expect(keys("self", true)).toContain("media-highlights");
  });

  it("sits right after News mentions in the rail", () => {
    const k = keys("self", true);
    expect(k.indexOf("media-highlights")).toBe(k.indexOf("news") + 1);
  });
});
