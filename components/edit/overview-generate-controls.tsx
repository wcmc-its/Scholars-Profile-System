/**
 * OverviewGenerateControls — the steering panel for the overview-statement
 * generator (#742 Phase A, `docs/overview-statement-generator-spec.md` §
 * Generation options). Renders voice / tone / length as compact segmented
 * pills, an "include & emphasize" wrapped row of coral checkbox chips, and a
 * free-text instructions note; the chosen {@link OverviewParams} ride along on
 * the next Generate request.
 *
 * #875 re-skin — radios become segmented pills and the checkbox grid becomes a
 * single wrapped chip row (coral fill when selected). The a11y semantics are
 * UNCHANGED: pills still wrap a real `RadioGroupItem` (so it carries the
 * `disabled` attribute + `aria-checked` + the testid), and chips still wrap a
 * real `Checkbox`. Only the visual treatment changed.
 *
 * This is a pure controlled input surface: it owns no params state and triggers
 * no fetch. The parent (`overview-card.tsx`) holds the params and the Generate
 * button — keeping the network/seed logic in one place and this component a
 * dumb, fully-testable editor of the value. Untrusted instructions are clamped
 * client-side at {@link OVERVIEW_INSTRUCTIONS_MAX} (the server re-normalizes).
 */
"use client";

import * as React from "react";

import { SegmentedField } from "@/components/edit/segmented-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  OVERVIEW_AUDIENCES,
  OVERVIEW_ELEMENTS,
  OVERVIEW_INSTRUCTIONS_MAX,
  type OverviewAudience,
  type OverviewElement,
  type OverviewLength,
  type OverviewParams,
  type OverviewTone,
  type OverviewVoice,
} from "@/lib/edit/overview-params";
import {
  estimateDraftCostUsd,
  humanizeModelId,
  promptVersionElementLabel,
  type OverviewPromptVersionId,
  type OverviewPromptVersionMeta,
} from "@/lib/edit/overview-prompt-versions";
import { cn } from "@/lib/utils";

type OverviewGenerateControlsProps = {
  value: OverviewParams;
  onChange: (next: OverviewParams) => void;
  disabled?: boolean;
  /**
   * The selectable prompt versions (#742), each carrying its RESOLVED effective
   * model (the server fills `model`). Only superuser / curator surfaces pass these
   * with {@link canSelectPromptVersion} true; a faculty owner never sees the
   * selector and always generates on the live default.
   */
  promptVersions?: OverviewPromptVersionMeta[];
  /** Whether to render the version selector (superuser / curator only). */
  canSelectPromptVersion?: boolean;
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
// Audience tiers (least → most technical), derived from the canonical list so the
// control and the prompt directive can never drift. The short `label` rides the button;
// the full `hint` becomes a hover/focus tooltip (`title`) on each segment.
const AUDIENCE_OPTIONS: { value: OverviewAudience; label: string; title: string }[] =
  OVERVIEW_AUDIENCES.map((a) => ({ value: a.key, label: a.label, title: a.hint }));

// The compact uppercase section-label style shared by the panel's non-segmented labels
// (version selector, emphasize, instructions) so they match the SegmentedField legends.
const COMPACT_LABEL =
  "text-muted-foreground mb-1 block text-[11px] font-semibold tracking-wide uppercase";

export function OverviewGenerateControls({
  value,
  onChange,
  disabled = false,
  promptVersions = [],
  canSelectPromptVersion = false,
}: OverviewGenerateControlsProps) {
  const showVersionSelector = canSelectPromptVersion && promptVersions.length > 0;
  const selectedVersion = promptVersions.find((v) => v.id === value.promptVersion);

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
      {showVersionSelector && (
        <fieldset className="flex flex-col gap-2" data-testid="overview-prompt-version-field">
          <legend className={COMPACT_LABEL}>Prompt version</legend>
          <span className="text-muted-foreground text-xs">
            Visible to superusers and curators only.
          </span>
          <select
            value={value.promptVersion}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...value, promptVersion: e.target.value as OverviewPromptVersionId })
            }
            aria-label="Prompt version"
            aria-describedby="overview-prompt-version-desc"
            className={cn(
              "border-apollo-border-strong bg-apollo-surface text-foreground w-fit rounded-md border px-3 py-1 text-sm",
              disabled && "cursor-not-allowed opacity-60",
            )}
            data-testid="overview-prompt-version"
          >
            {promptVersions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          {selectedVersion?.description && (
            <span id="overview-prompt-version-desc" className="text-muted-foreground text-xs">
              {selectedVersion.description}
            </span>
          )}
          {selectedVersion?.model && (
            <span
              className="text-muted-foreground text-xs"
              data-testid="overview-prompt-version-model"
            >
              Model: {humanizeModelId(selectedVersion.model)}
            </span>
          )}
          {selectedVersion?.model && estimateDraftCostUsd(selectedVersion.model) != null && (
            <span
              className="text-muted-foreground text-xs"
              data-testid="overview-prompt-version-cost"
            >
              ~${estimateDraftCostUsd(selectedVersion.model)!.toFixed(2)} per draft (estimate)
            </span>
          )}
        </fieldset>
      )}
      {/* Compact 2x2 grid: Voice | Tone, then Length | Audience. Collapses to one
          column on a narrow panel. Each control is the full-width connected `compact`
          segmented bar; the audience tiers carry their full description as a tooltip. */}
      <div
        className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2"
        data-testid="overview-generate-grid"
      >
        <SegmentedField
          legend="Voice"
          name="overview-voice"
          options={VOICE_OPTIONS}
          value={value.voice}
          disabled={disabled}
          compact
          onValueChange={(v) => onChange({ ...value, voice: v as OverviewVoice })}
        />
        <SegmentedField
          legend="Tone"
          name="overview-tone"
          options={TONE_OPTIONS}
          value={value.tone}
          disabled={disabled}
          compact
          onValueChange={(v) => onChange({ ...value, tone: v as OverviewTone })}
        />
        <SegmentedField
          legend="Length"
          name="overview-length"
          options={LENGTH_OPTIONS}
          value={value.length}
          disabled={disabled}
          compact
          onValueChange={(v) => onChange({ ...value, length: v as OverviewLength })}
        />
        <SegmentedField
          legend="Audience"
          name="overview-audience"
          options={AUDIENCE_OPTIONS}
          value={value.audience}
          disabled={disabled}
          compact
          onValueChange={(v) => onChange({ ...value, audience: v as OverviewAudience })}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={COMPACT_LABEL}>Include &amp; emphasize</legend>
        <div className="flex flex-wrap gap-2">
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
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors select-none",
                  checked
                    ? "border-apollo-coral-tint-border bg-apollo-coral-tint text-apollo-coral-foreground"
                    : "border-apollo-border-strong bg-apollo-surface text-foreground hover:bg-apollo-surface-2",
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
                {displayLabel}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="overview-instructions" className={COMPACT_LABEL}>
          Additional instructions
        </label>
        <Textarea
          id="overview-instructions"
          value={value.instructions}
          maxLength={OVERVIEW_INSTRUCTIONS_MAX}
          disabled={disabled}
          rows={2}
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
