/**
 * OverviewGenerateControls — the steering sections of the overview "Draft with
 * AI" rail (#742 Phase A, `docs/overview-statement-generator-spec.md` §
 * Generation options; two-column layout per the 2026-09-23 "Overview editor,
 * two-column" canvas). Renders, as rail sections separated by hairlines:
 *
 *   1. Voice + Length as soft segmented bars, and a single "Tone & audience"
 *      select that sets BOTH `tone` and `audience` (see {@link TONE_AUDIENCE});
 *   2. "Emphasize" — a wrapped row of ✓ chips, with `emphasisNote` (the
 *      awards-won't-be-mentioned / sparse-sources hints) under it;
 *   3. `sources` — the parent's Sources summary row;
 *   4. Additional instructions.
 *
 * The a11y semantics are unchanged from the #875 skin: segments wrap a real
 * `RadioGroupItem`, chips wrap a real `Checkbox`. A pure controlled surface —
 * the parent (`overview-card.tsx`) owns params, the Generate button and the
 * superuser-only Advanced block (prompt version / model / payload).
 */
"use client";

import * as React from "react";

import { SegmentedField } from "@/components/edit/segmented-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  OVERVIEW_ELEMENTS,
  OVERVIEW_INSTRUCTIONS_MAX,
  type OverviewAudience,
  type OverviewElement,
  type OverviewLength,
  type OverviewParams,
  type OverviewTone,
  type OverviewVoice,
} from "@/lib/edit/overview-params";
import { promptVersionElementLabel } from "@/lib/edit/overview-prompt-versions";
import { cn } from "@/lib/utils";

type OverviewGenerateControlsProps = {
  value: OverviewParams;
  onChange: (next: OverviewParams) => void;
  disabled?: boolean;
  /** Rendered under the Emphasize chips (the §6 pre-generation hints). */
  emphasisNote?: React.ReactNode;
  /** The Sources row, rendered between Emphasize and Additional instructions. */
  sources?: React.ReactNode;
};

const VOICE_OPTIONS: { value: OverviewVoice; label: string }[] = [
  { value: "third", label: "Third person" },
  { value: "first", label: "First person" },
];
const LENGTH_OPTIONS: { value: OverviewLength; label: string }[] = [
  { value: "short", label: "Short" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
];

/**
 * The combined "Tone & audience" select. Keyed by audience tier; picking one
 * sets both params. `neutral`/`conversational` tone are no longer offered
 * separately (the normalizer still accepts them, so old history rows load).
 */
export const TONE_AUDIENCE: {
  audience: OverviewAudience;
  tone: OverviewTone;
  label: string;
}[] = [
  { audience: "accessible", tone: "neutral", label: "Plain · general public" },
  { audience: "informed", tone: "formal", label: "Formal · informed readers" },
  { audience: "technical", tone: "formal", label: "Technical · specialists" },
];

const RAIL_LABEL = "text-muted-foreground text-xs font-semibold";
const RAIL_SECTION = "border-apollo-rail-border flex flex-col border-b px-4 py-3.5";

export function OverviewGenerateControls({
  value,
  onChange,
  disabled = false,
  emphasisNote,
  sources,
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

  return (
    <>
      <div className={cn(RAIL_SECTION, "gap-3.5")} data-testid="overview-generate-grid">
        <SegmentedField
          legend="Voice"
          name="overview-voice"
          options={VOICE_OPTIONS}
          value={value.voice}
          disabled={disabled}
          compact
          soft
          onValueChange={(v) => onChange({ ...value, voice: v as OverviewVoice })}
        />
        <SegmentedField
          legend="Length"
          name="overview-length"
          options={LENGTH_OPTIONS}
          value={value.length}
          disabled={disabled}
          compact
          soft
          onValueChange={(v) => onChange({ ...value, length: v as OverviewLength })}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="overview-tone-audience" className={RAIL_LABEL}>
            Tone &amp; audience
          </label>
          <select
            id="overview-tone-audience"
            value={value.audience}
            disabled={disabled}
            onChange={(e) => {
              const pick = TONE_AUDIENCE.find((t) => t.audience === e.target.value);
              if (pick) onChange({ ...value, audience: pick.audience, tone: pick.tone });
            }}
            className="border-apollo-border-strong bg-apollo-surface text-foreground h-[34px] rounded-md border px-2.5 text-[13px] disabled:opacity-60"
            data-testid="overview-tone-audience"
          >
            {TONE_AUDIENCE.map((t) => (
              <option key={t.audience} value={t.audience}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div role="group" aria-labelledby="overview-emphasize-label" className={cn(RAIL_SECTION, "gap-2")}>
        <span id="overview-emphasize-label" className={RAIL_LABEL}>
          Emphasize
        </span>
        <div className="flex flex-wrap gap-1.5">
          {OVERVIEW_ELEMENTS.map(({ key, label }) => {
            const id = `overview-element-${key}`;
            const checked = value.elements.includes(key);
            // The theme LABEL is version-scoped (v3 renames `key_findings`); the
            // stored key is unchanged, so toggling is unaffected.
            const displayLabel = promptVersionElementLabel(value.promptVersion, key, label);
            return (
              <label
                key={key}
                htmlFor={id}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center rounded-full border px-2.5 text-[13px] transition-colors select-none",
                  checked
                    ? "bg-apollo-surface text-foreground border-[#8a847c] font-medium"
                    : "border-apollo-border-strong text-muted-foreground hover:text-foreground bg-transparent",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <Checkbox
                  id={id}
                  className="sr-only"
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(c) => toggleElement(key, c === true)}
                  data-testid={`overview-element-${key}`}
                />
                {checked && <span aria-hidden="true">✓&nbsp;</span>}
                {displayLabel}
              </label>
            );
          })}
        </div>
        {emphasisNote}
      </div>

      {sources}

      <div className={cn(RAIL_SECTION, "gap-1.5")}>
        <label htmlFor="overview-instructions" className={RAIL_LABEL}>
          Additional instructions
        </label>
        <Textarea
          id="overview-instructions"
          value={value.instructions}
          maxLength={OVERVIEW_INSTRUCTIONS_MAX}
          disabled={disabled}
          rows={2}
          placeholder="e.g. mention the RECOVER long COVID work"
          className="bg-apollo-surface text-[13px]"
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          data-testid="overview-instructions"
        />
        {value.instructions.length > 0 && (
          <span
            aria-live="polite"
            className="text-muted-foreground self-end text-xs tabular-nums"
            data-testid="overview-instructions-count"
          >
            {value.instructions.length}/{OVERVIEW_INSTRUCTIONS_MAX}
          </span>
        )}
      </div>
    </>
  );
}
