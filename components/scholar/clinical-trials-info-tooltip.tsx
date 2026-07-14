"use client";

import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const COPY =
  "Trial details are drawn from institutional records and, where an NCT registration exists, ClinicalTrials.gov. Status reflects the most recent available update.";

/**
 * "About Clinical trials" — the provenance note, moved off a footer paragraph and
 * behind the section heading.
 *
 * A hover `Tooltip`, matching MentoringInfoTooltip and DisclosureInfoTooltip. It
 * is NOT the click-Popover that TechnologiesInfoButton uses: that one holds a
 * clickable `mailto:`, and a hover tooltip cannot host interactive content. This
 * copy is plain prose with nothing to click, so the lighter sibling pattern is the
 * right one. Add a link here and it must become a Popover.
 */
export function ClinicalTrialsInfoTooltip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="About Clinical trials"
            // NO nudge here — unlike its three siblings. See the descender rule in
            // technologies-info-button.tsx: "Clinical trials" has no descender
            // (no g/j/p/q/y), so its ink sits almost entirely above the baseline and
            // its optical centre is 9.1px up, not 6.6px. `self-center` already lands
            // the icon at 8.5px — 0.6px off, which is right. Applying the siblings'
            // 2px drags it 2.6px BELOW the word (shipped that way in #1730 and
            // measured in prod; this is the fix).
            className="inline-flex h-5 w-5 items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground"
          >
            <HelpCircle className="size-4" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-sm leading-relaxed">
          {COPY}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
