"use client";

import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Descriptions taken verbatim from VIVO's tooltip copy
// (https://vivo.weill.cornell.edu/display/cwid-...), with the redundant
// "<Label> refers to" prefix stripped so the tooltip reads naturally next
// to the heading that already names the group.
const GROUP_DESCRIPTIONS: Record<string, string> = {
  "Leadership Roles":
    "An individual with decision-making responsibility to an outside company (e.g., board of directors, officer, trustee).",
  Ownership:
    "Any financial stake an individual owns in any company (e.g., stock options, equity interest).",
  "Advisory/Scientific Board Member":
    "A group of individuals who have been selected to advise a business regarding any number of issues (e.g., scientific advisory board member, medical advisory board member).",
  "Professional Services":
    "A service requiring specialized knowledge and skill usually requiring a license, certification, or registration (e.g., expert witness, commissioned writing).",
  "Speaker/Lecturer":
    "An individual who conducts professional lectures, speeches, or presentations (e.g., educational speaking engagement, company sponsored speaker).",
  "Proprietary Interest":
    "Ownership of intellectual property rights (e.g., trademarks, patents, royalty income).",
  "Other Interest":
    "Miscellaneous financial interests not covered in other categories (e.g., stipends, anything of monetary value).",
};

export function DisclosureGroupInfoTooltip({ group }: { group: string }) {
  const description = GROUP_DESCRIPTIONS[group];
  if (!description) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`About ${group}`}
            className="inline-flex h-4 w-4 items-center justify-center self-center rounded-full text-muted-foreground hover:text-foreground"
          >
            <HelpCircle className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-sm leading-relaxed">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
