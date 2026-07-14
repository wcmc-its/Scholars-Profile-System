/**
 * The info-button nudge is NOT a constant — it depends on the heading's descender.
 *
 * A heading with a descender (technoloGies, MentorinG, relationshiPs) inks below the
 * baseline, pulling its optical centre down to ~6.6px, and needs `translate-y-[2px]`.
 * A heading WITHOUT one (Clinical trials) inks almost entirely above the baseline —
 * centre ~9.1px — and needs no nudge; the 2px would drag its icon ~2.6px below the
 * word.
 *
 * That is exactly what happened: the 2px was derived for the three descender headings
 * and documented as "one value fits", then Clinical trials got a button in #1730,
 * inherited the class, and shipped visibly low to prod.
 *
 * jsdom has no font metrics, so no test can check optical alignment directly. What it
 * CAN do is enforce the rule that produced the number — each component's nudge must
 * agree with its own heading's descender. A copy-paste of the 2px onto a
 * no-descender heading fails here.
 */
import { describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TechnologiesInfoButton } from "@/components/scholar/technologies-info-button";
import { MentoringInfoTooltip } from "@/components/scholar/mentoring-info-tooltip";
import { DisclosureInfoTooltip } from "@/components/scholar/disclosure-info-tooltip";
import { ClinicalTrialsInfoTooltip } from "@/components/scholar/clinical-trials-info-tooltip";

const NUDGE = "translate-y-[2px]";
const DESCENDERS = /[gjpqy]/;

/** Every info trigger that sits in a 24px `headingLg` row, with the heading it labels. */
const TRIGGERS = [
  { Component: TechnologiesInfoButton, heading: "Available technologies" },
  { Component: MentoringInfoTooltip, heading: "Mentoring" },
  { Component: DisclosureInfoTooltip, heading: "External relationships" },
  { Component: ClinicalTrialsInfoTooltip, heading: "Clinical trials" },
] as const;

describe("info-button nudge follows the heading's descender", () => {
  for (const { Component, heading } of TRIGGERS) {
    const wantsNudge = DESCENDERS.test(heading);

    it(`${heading} (${wantsNudge ? "has" : "no"} descender) → ${wantsNudge ? NUDGE : "no nudge"}`, () => {
      cleanup();
      render(<Component />);
      const btn = screen.getByRole("button");
      const nudged = btn.className.includes(NUDGE);
      expect(nudged).toBe(wantsNudge);
    });
  }

  it("pins the descender split — if a heading is renamed, this is the thing to re-derive", () => {
    // Guards the premise itself: three of the four headings have a descender and one
    // does not. Rename "Clinical trials" to something with a 'g' and the nudge must
    // change with it.
    const withDescender = TRIGGERS.filter((t) => DESCENDERS.test(t.heading)).map((t) => t.heading);
    const without = TRIGGERS.filter((t) => !DESCENDERS.test(t.heading)).map((t) => t.heading);
    expect(withDescender).toEqual([
      "Available technologies",
      "Mentoring",
      "External relationships",
    ]);
    expect(without).toEqual(["Clinical trials"]);
  });
});
