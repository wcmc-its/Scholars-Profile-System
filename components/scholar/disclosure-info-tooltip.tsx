"use client";

import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const COPY =
  "Relationships and collaborations with for-profit and not-for-profit organizations are of vital importance to our faculty because these exchanges of scientific information foster innovation. As experts in their fields, WCM physicians and scientists are sought after by many organizations to consult and educate. WCM and its faculty make this information available to the public, thus creating a transparent environment.";

export function DisclosureInfoTooltip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="About external relationships"
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
