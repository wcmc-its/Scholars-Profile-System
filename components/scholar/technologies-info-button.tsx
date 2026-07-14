"use client";

import { HelpCircle } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** Enterprise Innovation's shared licensing inbox and its About Us page. Named
 *  officers live on each technology's own page — we link there rather than
 *  mirroring a person's contact details, which would go stale the moment the
 *  docket is reassigned. */
const EI_INQUIRIES = "enterpriseinnovation@med.cornell.edu";
const EI_ABOUT = "https://innovation.weill.cornell.edu/about-us";

/**
 * "About Available technologies" — the licensing attribution + contact, tucked
 * behind the section heading instead of spending a paragraph and a divider rule
 * at the foot of the section.
 *
 * Matches the two sibling section tooltips on this page (MentoringInfoTooltip,
 * DisclosureInfoTooltip): same HelpCircle glyph, same trigger styling, same
 * inline-in-the-heading placement.
 *
 * ponytail: a Popover, NOT the `Tooltip` those two siblings use. A hover tooltip
 * can't host interactive content — the licensing inbox has to stay a clickable
 * mailto, and a mailto inside a hover tooltip is unreachable with a pointer (and
 * invisible to the keyboard). Radix's Popover is click-toggled and already gives
 * us outside-click, Escape, and focus return for free, so there is no popover
 * logic to own here.
 */
export function TechnologiesInfoButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="About Available technologies"
          // Optically centre the icon on the HEADING WORD, not on the line box and
          // not on the small count chip beside it (#1723 — anchoring to the 13px
          // count is what made #1717 overshoot 3px too low).
          //
          // Measured from the font, not guessed: "Available technologies" in bold
          // 24px Inter inks 18.4px above the baseline and 5.2px below it (the g/y
          // descenders), so the word's optical centre is (18.4-5.2)/2 = 6.6px above
          // the baseline. `self-center` in this `items-baseline` row leaves the icon
          // at 8.4px — 1.8px high. Hence 2px. Every heading using this pattern has a
          // descender (technoloGies / MentorinG / relationshiPs), so one value fits.
          //
          // ponytail: a fixed nudge, not a measured one. Tied to the 24px headingLg
          // row; this trigger renders in no other context. Re-derive if the heading
          // size or typeface changes.
          className="inline-flex h-5 w-5 translate-y-[2px] items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
        >
          <HelpCircle className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 text-left text-[13px] leading-[1.55] font-normal tracking-normal normal-case"
      >
        <p className="m-0">
          Technologies available for licensing from{" "}
          <a
            href={EI_ABOUT}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent-slate)] underline underline-offset-4"
          >
            Enterprise Innovation
          </a>
          . Please contact{" "}
          <a
            href={`mailto:${EI_INQUIRIES}`}
            className="text-[var(--color-accent-slate)] underline underline-offset-4"
          >
            {EI_INQUIRIES}
          </a>{" "}
          to learn more.
        </p>
      </PopoverContent>
    </Popover>
  );
}
