/**
 * `SegmentedField` — a labelled segmented-pill row (one selectable value out of
 * a small fixed set, e.g. voice / tone / length, or a biosketch mode).
 *
 * Each pill wraps a real `RadioGroupItem` (visually hidden) so it keeps the
 * radio a11y semantics, the `disabled` attribute, `aria-checked`, and the
 * testid; the wrapping `<label>` carries the pill styling and the selected fill.
 *
 * Extracted verbatim from `overview-generate-controls.tsx` (#742) so the
 * biosketch generator (#917 v5) can reuse the same control without re-skinning
 * it — the markup, classes, and `data-testid` convention are unchanged.
 */
"use client";

import * as React from "react";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function SegmentedField({
  legend,
  name,
  options,
  value,
  disabled,
  onValueChange,
  compact = false,
}: {
  legend: string;
  name: string;
  /** Each option may carry an optional `title` — its full description, shown as a
   *  styled Radix tooltip on hover (e.g. the audience tiers in the compact overview
   *  layout). Options without one render as a plain segment. */
  options: { value: string; label: string; title?: string }[];
  value: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
  /**
   * Compact variant (opt-in): a full-width, CONNECTED segmented bar (equal-width
   * buttons, shared dividers) under a small uppercase legend — fits a 2-column grid
   * cell. Default (false) keeps the original content-width separate pills. Only the
   * overview generate controls pass this; the biosketch controls keep the pills.
   */
  compact?: boolean;
}) {
  // Any option with a description gets a styled Radix tooltip on hover, which needs a
  // TooltipProvider ancestor. Controls with no descriptions (voice / tone / length, the
  // biosketch modes) skip the provider entirely and render bare segments.
  const hasTooltips = options.some((o) => o.title);

  const radioGroup = (
    <RadioGroup
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      className={cn(
        compact
          ? "border-apollo-border-strong flex w-full overflow-hidden rounded-md border"
          : "inline-flex w-fit flex-wrap gap-1 rounded-lg p-0",
      )}
      aria-label={legend}
    >
      {options.map((opt) => {
        const id = `${name}-${opt.value}`;
        const selected = value === opt.value;
        const segment = (
          <label
            key={opt.value}
            htmlFor={id}
            className={cn(
              "cursor-pointer items-center transition-colors select-none",
              compact
                ? "border-apollo-border-strong flex min-w-0 flex-1 justify-center truncate border-l px-2 py-1 text-center text-[12.5px] first:border-l-0"
                : "inline-flex rounded-md border px-3 py-1 text-sm",
              selected
                ? compact
                  ? "bg-apollo-maroon text-apollo-maroon-foreground font-medium"
                  : "border-apollo-maroon bg-apollo-maroon text-apollo-maroon-foreground"
                : compact
                  ? "bg-apollo-surface text-foreground hover:bg-apollo-surface-2"
                  : "border-apollo-border-strong bg-apollo-surface text-foreground hover:bg-apollo-surface-2",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <RadioGroupItem
              id={id}
              value={opt.value}
              className="sr-only"
              data-testid={`${name}-${opt.value}`}
            />
            {opt.label}
          </label>
        );
        // A description ⇒ wrap the segment as a tooltip trigger; otherwise render it bare.
        // The key rides the outermost array element either way.
        return opt.title ? (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>{segment}</TooltipTrigger>
            <TooltipContent className="max-w-xs">{opt.title}</TooltipContent>
          </Tooltip>
        ) : (
          segment
        );
      })}
    </RadioGroup>
  );

  return (
    <fieldset className={cn("flex min-w-0 flex-col", compact ? "gap-1.5" : "gap-2")}>
      <legend
        className={cn(
          "mb-1",
          compact
            ? "text-muted-foreground text-[11px] font-semibold tracking-wide uppercase"
            : "text-foreground text-sm font-medium",
        )}
      >
        {legend}
      </legend>
      {hasTooltips ? (
        // A short, deliberate hover delay — the provider default (0) feels jumpy, but this
        // is still far snappier than the ~1s native `title` tooltip it replaces.
        <TooltipProvider delayDuration={200}>{radioGroup}</TooltipProvider>
      ) : (
        radioGroup
      )}
    </fieldset>
  );
}
