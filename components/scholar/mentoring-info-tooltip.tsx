"use client";

import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const COPY =
  "Mentees known from institutional source systems. This list reflects recorded mentorships and may be incomplete.";

export function MentoringInfoTooltip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="About Mentoring"
            className="inline-flex h-5 w-5 items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground"
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
