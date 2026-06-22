"use client";

import { InfoIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The small "ⓘ" affordance beside a restructured-rail group header
 * (account-dropdown-nav-and-rail-descriptions handoff, Workstream C). The
 * group's one-line description is tucked behind it and revealed on click / tap
 * via a `Popover` — touch-friendly and needing no `TooltipProvider` ancestor, so
 * `AttributeRail` stays a server component (only this leaf is a client island).
 * Its accessible name is "About this group"; the content is lazy-mounted, so the
 * description is out of the DOM until opened.
 */
export function GroupInfoButton({ label, description }: { label: string; description: string }) {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="About this group"
        data-testid={`group-info-${label}`}
        className="text-muted-foreground hover:text-foreground inline-flex size-4 shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <InfoIcon className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="text-muted-foreground w-64 text-xs leading-snug">
        {description}
      </PopoverContent>
    </Popover>
  );
}
