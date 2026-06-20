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
}: {
  legend: string;
  name: string;
  options: { value: string; label: string }[];
  value: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-foreground mb-1 text-sm font-medium">{legend}</legend>
      <RadioGroup
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        className="inline-flex w-fit flex-wrap gap-1 rounded-lg p-0"
        aria-label={legend}
      >
        {options.map((opt) => {
          const id = `${name}-${opt.value}`;
          const selected = value === opt.value;
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className={cn(
                "inline-flex cursor-pointer items-center rounded-md border px-3 py-1 text-sm transition-colors select-none",
                selected
                  ? "border-apollo-maroon bg-apollo-maroon text-apollo-maroon-foreground"
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
