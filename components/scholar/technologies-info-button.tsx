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
          // ponytail: `self-center` in the heading's `items-baseline` flex row
          // centres the icon on the 24px heading's cap-height, which puts it ~5px
          // ABOVE the optical centre of the small count text sitting right beside
          // it ("12 technologies") — the two read as misaligned (#1717). Nudge the
          // icon down onto the count's optical centre. Tied to the headingLg
          // (24px) row: this trigger renders in no other context.
          className="inline-flex h-5 w-5 translate-y-[5px] items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-slate)]"
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
