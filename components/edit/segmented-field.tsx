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
  /** Each option may carry an optional `title` — a native hover/focus tooltip
   *  (e.g. the audience tiers' full descriptions in the compact overview layout). */
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
          return (
            <label
              key={opt.value}
              htmlFor={id}
              title={opt.title}
              className={cn(
                "cursor-pointer items-center transition-colors select-none",
                compact
                  ? "border-apollo-border-strong flex flex-1 min-w-0 justify-center truncate border-l px-2 py-1 text-center text-[12.5px] first:border-l-0"
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
        })}
      </RadioGroup>
    </fieldset>
  );
}
