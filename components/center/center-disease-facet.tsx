"use client";

import { Info } from "lucide-react";
import { RosterFacet, type FacetOption } from "@/components/center/center-roster-facets";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type DiseaseFocusMode = "any" | "primary";

const INFO_COPY =
  "Disease areas curated by the center for each member. Any involvement counts every published disease; Primary focus counts only a member's primary disease areas.";

/**
 * The public center roster's "Disease focus" facet (D1 — curated diseases sit
 * BESIDE topics). The shared `RosterFacet` (unit variant: checkbox rows with
 * counts, search, top-8 then "Show all N" / "Show fewer") plus an info tooltip
 * beside the title and an "Any involvement" / "Primary focus" segmented toggle
 * above the options. Selection and mode are owned by the roster.
 */
export function DiseaseFocusFacet({
  options,
  selected,
  onToggle,
  mode,
  onModeChange,
}: {
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  mode: DiseaseFocusMode;
  onModeChange: (mode: DiseaseFocusMode) => void;
}) {
  const segment = (value: DiseaseFocusMode, label: string) => {
    const active = mode === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => onModeChange(value)}
        className={`flex-1 cursor-pointer whitespace-nowrap rounded-[3px] border px-2 py-[3px] text-[12px] leading-[16px] transition-colors ${
          active
            ? "border-apollo-border-strong bg-white text-foreground"
            : "border-transparent text-muted-foreground hover:text-foreground"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <RosterFacet
      variant="unit"
      title="Disease focus"
      options={options}
      selected={selected}
      onToggle={onToggle}
      collapseAfter={8}
      searchable
      searchPlaceholder="Search diseases…"
      noMatchLabel="No diseases match"
      titleAddon={
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="About Disease focus"
                className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <Info aria-hidden className="size-3" strokeWidth={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-[12px] leading-relaxed">
              {INFO_COPY}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      }
      headerExtra={
        <div
          role="radiogroup"
          aria-label="Disease focus scope"
          className="flex gap-[2px] rounded-[4px] bg-apollo-surface-2 p-[2px]"
        >
          {segment("any", "Any involvement")}
          {segment("primary", "Primary focus")}
        </div>
      }
    />
  );
}
