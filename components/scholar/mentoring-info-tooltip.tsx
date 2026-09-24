"use client";

import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const COPY =
  "Mentees from institutional records, plus any the scholar has added. This list may be incomplete.";

export function MentoringInfoTooltip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="About Mentoring"
            // #1723 — see technologies-info-button.tsx: `self-center` in this
            // `items-baseline` row leaves the icon 1.8px above the optical centre
            // of the heading WORD. Same 2px nudge, same 24px headingLg row.
            className="inline-flex h-5 w-5 translate-y-[2px] items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground"
          >
            <HelpCircle className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-sm leading-relaxed">
          {COPY}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
