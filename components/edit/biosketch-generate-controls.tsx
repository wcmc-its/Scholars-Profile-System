/**
 * `BiosketchGenerateControls` — the steering panel for the NIH-biosketch prose
 * generator (#917 v5, `docs/overview-generator-prompt-v5.md`). A pure CONTROLLED
 * input surface that mirrors the visual language of `OverviewGenerateControls`:
 * segmented pills, the privileged cost line, and a free-text steering note. It
 * owns no params state and triggers no fetch — the parent (`BiosketchTool`)
 * holds the value + the Generate button.
 *
 * Two modes via a {@link SegmentedField} toggle:
 *   - Contributions — a `maxContributions` 1..5 segmented stepper (default 5).
 *   - Personal Statement — a REQUIRED `projectTitle` input + a REQUIRED `aims`
 *     textarea (the model needs them to write the "directly relevant experience"
 *     framing; the route 400s without them).
 *
 * Both modes share an optional `emphasis` input and an optional `instructions`
 * note. Untrusted free text is clamped client-side at the same ceilings the
 * server re-normalizes against (`biosketch-params.ts`).
 *
 * The per-draft cost line is gated by `canSeeCost` (superuser / comms-steward
 * only), exactly as the overview controls gate `overview-prompt-version-cost`;
 * a faculty owner never sees it.
 */
"use client";

import * as React from "react";

import { SegmentedField } from "@/components/edit/segmented-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BIOSKETCH_AIMS_MAX,
  BIOSKETCH_EMPHASIS_MAX,
  BIOSKETCH_INSTRUCTIONS_MAX,
  BIOSKETCH_MAX_CONTRIBUTIONS,
  BIOSKETCH_PROJECT_TITLE_MAX,
  type BiosketchMode,
  type BiosketchParams,
} from "@/lib/edit/biosketch-params";
import {
  type BiosketchPromptVersionId,
  type BiosketchPromptVersionMeta,
} from "@/lib/edit/biosketch-prompt-versions";
import { estimateBiosketchCostUsd } from "@/lib/edit/overview-prompt-versions";
import { cn } from "@/lib/utils";

const MODE_OPTIONS: { value: BiosketchMode; label: string }[] = [
  { value: "contributions", label: "Contributions to Science" },
  { value: "personal_statement", label: "Personal Statement" },
];

const MAX_CONTRIBUTIONS_OPTIONS: { value: string; label: string }[] = Array.from(
  { length: BIOSKETCH_MAX_CONTRIBUTIONS },
  (_, i) => ({ value: String(i + 1), label: String(i + 1) }),
);

export type BiosketchGenerateControlsProps = {
  value: BiosketchParams;
  onChange: (next: BiosketchParams) => void;
  disabled?: boolean;
  /**
   * Whether to render the per-draft cost estimate. True only on the
   * superuser / comms-steward arms (mirrors the overview cost-gating); a faculty
   * owner editing their own biosketch never sees it.
   */
  canSeeCost?: boolean;
  /** The resolved effective model id — drives the cost estimate. */
  model: string;
  /** #917 v6 — the selectable prompt versions (superuser / curator only). */
  versions?: BiosketchPromptVersionMeta[];
  /** #917 v6 — whether to render the prompt-version selector (privileged actors only). */
  canSelectVersion?: boolean;
};

export function BiosketchGenerateControls({
  value,
  onChange,
  disabled = false,
  canSeeCost = false,
  model,
  versions = [],
  canSelectVersion = false,
}: BiosketchGenerateControlsProps) {
  const isStatement = value.mode === "personal_statement";
  const cost = canSeeCost ? estimateBiosketchCostUsd(model, value.mode) : null;
  const showVersionSelector = canSelectVersion && versions.length > 0;
  const selectedVersion = versions.find((v) => v.id === value.promptVersion);

  return (
    <div
      className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-4 rounded-md border p-4"
      data-slot="biosketch-generate-controls"
    >
      {showVersionSelector && (
        <fieldset className="flex flex-col gap-2" data-testid="biosketch-prompt-version-field">
          <legend className="text-foreground mb-1 text-sm font-medium">Prompt version</legend>
          <span className="text-muted-foreground text-xs">
            Visible to superusers and curators only.
          </span>
          <select
            value={value.promptVersion}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...value, promptVersion: e.target.value as BiosketchPromptVersionId })
            }
            aria-label="Biosketch prompt version"
            aria-describedby="biosketch-prompt-version-desc"
            className={cn(
              "border-apollo-border-strong bg-apollo-surface text-foreground w-fit rounded-md border px-3 py-1 text-sm",
              disabled && "cursor-not-allowed opacity-60",
            )}
            data-testid="biosketch-prompt-version"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          {selectedVersion?.description && (
            <span id="biosketch-prompt-version-desc" className="text-muted-foreground text-xs">
              {selectedVersion.description}
            </span>
          )}
        </fieldset>
      )}

      <SegmentedField
        legend="Artifact"
        name="biosketch-mode"
        options={MODE_OPTIONS}
        value={value.mode}
        disabled={disabled}
        onValueChange={(v) => onChange({ ...value, mode: v as BiosketchMode })}
      />

      {!isStatement && (
        <SegmentedField
          legend="Maximum contributions"
          name="biosketch-max-contributions"
          options={MAX_CONTRIBUTIONS_OPTIONS}
          value={String(value.maxContributions)}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...value, maxContributions: Number(v) })}
        />
      )}

      {!isStatement && (
        <details className="flex flex-col gap-1.5" data-testid="biosketch-project-optional">
          <summary className="text-foreground w-fit cursor-pointer text-sm font-medium select-none">
            Proposed project{" "}
            <span className="text-muted-foreground text-xs font-normal">
              (optional — tailors the &ldquo;most related&rdquo; products)
            </span>
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            <Input
              id="biosketch-related-title"
              value={value.projectTitle}
              maxLength={BIOSKETCH_PROJECT_TITLE_MAX}
              disabled={disabled}
              placeholder="Proposed project title (optional)"
              onChange={(e) => onChange({ ...value, projectTitle: e.target.value })}
              data-testid="biosketch-related-title"
            />
            <Textarea
              id="biosketch-related-aims"
              value={value.aims}
              maxLength={BIOSKETCH_AIMS_MAX}
              disabled={disabled}
              placeholder="Specific aims (optional) — the Products list will surface the work most related to these."
              onChange={(e) => onChange({ ...value, aims: e.target.value })}
              data-testid="biosketch-related-aims"
            />
          </div>
        </details>
      )}

      {isStatement && (
        <>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="biosketch-project-title"
              className="text-foreground text-sm font-medium"
            >
              Proposed project title{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <Input
              id="biosketch-project-title"
              value={value.projectTitle}
              maxLength={BIOSKETCH_PROJECT_TITLE_MAX}
              disabled={disabled}
              required
              aria-required="true"
              placeholder="e.g. Targeting tumor metabolism in pancreatic cancer"
              onChange={(e) => onChange({ ...value, projectTitle: e.target.value })}
              data-testid="biosketch-project-title"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="biosketch-aims" className="text-foreground text-sm font-medium">
              Specific aims{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <Textarea
              id="biosketch-aims"
              value={value.aims}
              maxLength={BIOSKETCH_AIMS_MAX}
              disabled={disabled}
              required
              aria-required="true"
              placeholder="Outline the specific aims of the proposed project."
              onChange={(e) => onChange({ ...value, aims: e.target.value })}
              data-testid="biosketch-aims"
            />
          </div>

          <p className="text-muted-foreground -mt-1 text-xs" data-testid="biosketch-statement-hint">
            A title and aims are required — the statement is tailored to fitness for this specific
            project.
          </p>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="biosketch-emphasis" className="text-foreground text-sm font-medium">
          Emphasis{" "}
          <span className="text-muted-foreground text-xs font-normal">(optional)</span>
        </label>
        <Input
          id="biosketch-emphasis"
          value={value.emphasis}
          maxLength={BIOSKETCH_EMPHASIS_MAX}
          disabled={disabled}
          placeholder="e.g. weight toward clinical work; AAV gene therapy"
          onChange={(e) => onChange({ ...value, emphasis: e.target.value })}
          data-testid="biosketch-emphasis"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="biosketch-instructions" className="text-foreground text-sm font-medium">
          Additional instructions{" "}
          <span className="text-muted-foreground text-xs font-normal">(optional)</span>
        </label>
        <Textarea
          id="biosketch-instructions"
          value={value.instructions}
          maxLength={BIOSKETCH_INSTRUCTIONS_MAX}
          disabled={disabled}
          placeholder="A steering note — e.g. keep the tone plain; foreground the translational arc."
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          data-testid="biosketch-instructions"
        />
        <span
          aria-live="polite"
          className="text-muted-foreground self-end text-xs tabular-nums"
          data-testid="biosketch-instructions-count"
        >
          {value.instructions.length}/{BIOSKETCH_INSTRUCTIONS_MAX}
        </span>
      </div>

      {canSeeCost && cost != null && (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-xs" data-testid="biosketch-cost">
            ~${cost.toFixed(2)} per draft (estimate)
          </span>
          <span className="text-muted-foreground text-xs">
            A faithfulness pass, when enabled, costs roughly 3× this.
          </span>
        </div>
      )}
    </div>
  );
}
