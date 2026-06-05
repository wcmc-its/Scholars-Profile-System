/**
 * OverviewGenerateControls — the steering panel for the overview-statement
 * generator (#742 Phase A, `docs/overview-statement-generator-spec.md` §
 * Generation options). Renders voice / tone / length radios, an "include or
 * emphasize" checkbox per theme, and a free-text instructions note; the chosen
 * {@link OverviewParams} ride along on the next Generate/Regenerate request.
 *
 * This is a pure controlled input surface: it owns no params state and triggers
 * no fetch. The parent (`overview-card.tsx`) holds the params and the Generate
 * button — keeping the network/seed logic in one place and this component a
 * dumb, fully-testable editor of the value. Untrusted instructions are clamped
 * client-side at {@link OVERVIEW_INSTRUCTIONS_MAX} (the server re-normalizes).
 */
"use client";

import * as React from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  OVERVIEW_ELEMENTS,
  OVERVIEW_INSTRUCTIONS_MAX,
  type OverviewElement,
  type OverviewLength,
  type OverviewParams,
  type OverviewTone,
  type OverviewVoice,
} from "@/lib/edit/overview-params";

type OverviewGenerateControlsProps = {
  value: OverviewParams;
  onChange: (next: OverviewParams) => void;
  disabled?: boolean;
};

const VOICE_OPTIONS: { value: OverviewVoice; label: string }[] = [
  { value: "third", label: "Third person" },
  { value: "first", label: "First person" },
];
const TONE_OPTIONS: { value: OverviewTone; label: string }[] = [
  { value: "formal", label: "Formal" },
  { value: "neutral", label: "Neutral" },
  { value: "conversational", label: "Conversational" },
];
const LENGTH_OPTIONS: { value: OverviewLength; label: string }[] = [
  { value: "short", label: "Short" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
];

export function OverviewGenerateControls({
  value,
  onChange,
  disabled = false,
}: OverviewGenerateControlsProps) {
  function toggleElement(key: OverviewElement, checked: boolean) {
    const present = value.elements.includes(key);
    if (checked === present) return;
    const elements = checked
      ? // Append in canonical (display) order so the directive list stays stable.
        OVERVIEW_ELEMENTS.map((e) => e.key).filter((k) => value.elements.includes(k) || k === key)
      : value.elements.filter((k) => k !== key);
    onChange({ ...value, elements });
  }

  const instructionsLen = value.instructions.length;

  return (
    <div className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-4 rounded-md border p-4">
      <RadioFieldset
        legend="Voice"
        name="overview-voice"
        options={VOICE_OPTIONS}
        value={value.voice}
        disabled={disabled}
        onValueChange={(v) => onChange({ ...value, voice: v as OverviewVoice })}
      />
      <RadioFieldset
        legend="Tone"
        name="overview-tone"
        options={TONE_OPTIONS}
        value={value.tone}
        disabled={disabled}
        onValueChange={(v) => onChange({ ...value, tone: v as OverviewTone })}
      />
      <RadioFieldset
        legend="Length"
        name="overview-length"
        options={LENGTH_OPTIONS}
        value={value.length}
        disabled={disabled}
        onValueChange={(v) => onChange({ ...value, length: v as OverviewLength })}
      />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-foreground mb-1 text-sm font-medium">Include / emphasize</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {OVERVIEW_ELEMENTS.map(({ key, label }) => {
            const id = `overview-element-${key}`;
            return (
              <label key={key} htmlFor={id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={id}
                  checked={value.elements.includes(key)}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggleElement(key, checked === true)}
                  data-testid={`overview-element-${key}`}
                />
                {label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="overview-instructions" className="text-foreground text-sm font-medium">
          Additional instructions
        </label>
        <Textarea
          id="overview-instructions"
          value={value.instructions}
          maxLength={OVERVIEW_INSTRUCTIONS_MAX}
          disabled={disabled}
          placeholder="e.g. mention my work on pediatric trials; keep it accessible to a general audience."
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          data-testid="overview-instructions"
        />
        <span
          aria-live="polite"
          className="text-muted-foreground self-end text-xs tabular-nums"
          data-testid="overview-instructions-count"
        >
          {instructionsLen}/{OVERVIEW_INSTRUCTIONS_MAX}
        </span>
      </div>
    </div>
  );
}

/** A labelled radio row — one of voice / tone / length. The `<fieldset>` +
 *  `<legend>` give the group an accessible name; each item's `<label>` wraps its
 *  `RadioGroupItem` (the pattern the unit-curation cards use). */
function RadioFieldset({
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
        className="flex flex-wrap gap-4"
        aria-label={legend}
      >
        {options.map((opt) => {
          const id = `${name}-${opt.value}`;
          return (
            <label key={opt.value} htmlFor={id} className="flex items-center gap-2 text-sm">
              <RadioGroupItem id={id} value={opt.value} data-testid={`${name}-${opt.value}`} />
              {opt.label}
            </label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}
