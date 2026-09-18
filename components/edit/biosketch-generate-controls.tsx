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
 *     framing; the route 400s without them). Under a v8 prompt (#2653) a REQUIRED
 *     "Your role on this application" select sits above the title, plus an optional
 *     200-char "What you will do on this project" line; v5–v7 hide both.
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
  BIOSKETCH_APPLICATION_ROLE_LABELS,
  BIOSKETCH_APPLICATION_ROLES,
  BIOSKETCH_CONTRIBUTION_LINE_MAX,
  BIOSKETCH_EMPHASIS_MAX,
  BIOSKETCH_INSTRUCTIONS_MAX,
  BIOSKETCH_MAX_CONTRIBUTIONS,
  BIOSKETCH_PROJECT_TITLE_MAX,
  isBiosketchApplicationRole,
  type BiosketchMode,
  type BiosketchParams,
} from "@/lib/edit/biosketch-params";
import {
  biosketchVersionUsesApplicationRole,
  type BiosketchPromptVersionId,
  type BiosketchPromptVersionMeta,
} from "@/lib/edit/biosketch-prompt-versions";
import { estimateBiosketchCostUsd } from "@/lib/llm/pricing";
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
  /**
   * The required Personal Statement inputs the user tried to generate WITHOUT
   * (`missingPersonalStatementInputs` keys: `applicationRole`, `projectTitle`,
   * `aims`). Empty until they press Generate — an error on a field nobody has
   * reached yet is a scold, not help. Each named field gets `aria-invalid`, a
   * red message, and `aria-describedby` pointing at it.
   */
  invalidFields?: ReadonlyArray<string>;
  /** #2654 — the application label the next generation is saved under. */
  label: string;
  onLabelChange: (next: string) => void;
  /** `biosketch_generation.label VARCHAR(120)`. */
  labelMax: number;
};

export function BiosketchGenerateControls({
  value,
  onChange,
  disabled = false,
  canSeeCost = false,
  model,
  versions = [],
  canSelectVersion = false,
  invalidFields = [],
  label,
  onLabelChange,
  labelMax,
}: BiosketchGenerateControlsProps) {
  const isStatement = value.mode === "personal_statement";
  const invalid = React.useMemo(() => new Set(invalidFields), [invalidFields]);
  // #2653 v8 — the role on the application is a v8 input; v5–v7 ignore it, so the control hides.
  const asksRole = isStatement && biosketchVersionUsesApplicationRole(value.promptVersion);
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

      {/* The label names the draft this form will produce, so it belongs inside the form
          rather than floating between the saved-drafts card and this one, owned by neither. */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="biosketch-label" className="text-foreground text-sm font-medium">
          Label{" "}
          <span className="text-muted-foreground text-xs font-normal">
            (optional — the application this draft is for)
          </span>
        </label>
        <Input
          id="biosketch-label"
          value={label}
          maxLength={labelMax}
          disabled={disabled}
          placeholder="e.g. R01 resubmission, Oct 2026"
          className="max-w-[60ch]"
          onChange={(e) => onLabelChange(e.target.value)}
          data-testid="biosketch-label"
        />
      </div>

      <SegmentedField
        // "Artifact" is what the codebase calls the two outputs, but on screen it collides
        // with the NIH sense of the word and reads as jargon to the faculty member whose
        // biosketch this is. The control answers one question, so it asks it.
        legend="What to draft"
        name="biosketch-mode"
        options={MODE_OPTIONS}
        value={value.mode}
        disabled={disabled}
        onValueChange={(v) => onChange({ ...value, mode: v as BiosketchMode })}
      />

      {!isStatement && (
        <div className="flex flex-col gap-1.5">
          <SegmentedField
            legend="Maximum contributions"
            name="biosketch-max-contributions"
            options={MAX_CONTRIBUTIONS_OPTIONS}
            value={String(value.maxContributions)}
            disabled={disabled}
            onValueChange={(v) => onChange({ ...value, maxContributions: Number(v) })}
          />
          <p className="text-muted-foreground text-xs">
            NIH allows up to five. Fewer are drafted when the record does not support five distinct
            bodies of work — the count is a ceiling, never a target.
          </p>
        </div>
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
              className="max-w-[70ch]"
              data-testid="biosketch-related-aims"
            />
          </div>
        </details>
      )}

      {/* What the next three fields are FOR, above them — it used to sit under the aims
          textarea, i.e. after every field it describes, where it reads as a footnote to
          work already done rather than as the instruction it is. */}
      {isStatement && (
        <p className="text-muted-foreground text-xs" data-testid="biosketch-statement-hint">
          {asksRole ? "Your role, a title, and aims" : "A title and aims"} are required — the
          statement is tailored to fitness for this specific project
          {asksRole ? " in that role" : ""}.
        </p>
      )}

      {asksRole && (
        <>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="biosketch-application-role"
              className="text-foreground text-sm font-medium"
            >
              Your role on this application{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <select
              id="biosketch-application-role"
              value={value.applicationRole ?? ""}
              disabled={disabled}
              required
              aria-required="true"
              aria-invalid={invalid.has("applicationRole") || undefined}
              aria-describedby={
                invalid.has("applicationRole") ? "biosketch-application-role-error" : undefined
              }
              onChange={(e) =>
                onChange({
                  ...value,
                  applicationRole: isBiosketchApplicationRole(e.target.value)
                    ? e.target.value
                    : null,
                })
              }
              className={cn(
                "bg-apollo-surface text-foreground w-fit rounded-md border px-3 py-1 text-sm",
                invalid.has("applicationRole")
                  ? "border-destructive"
                  : "border-apollo-border-strong",
                disabled && "cursor-not-allowed opacity-60",
              )}
              data-testid="biosketch-application-role"
            >
              <option value="">Select a role</option>
              {BIOSKETCH_APPLICATION_ROLES.map((r) => (
                <option key={r} value={r}>
                  {BIOSKETCH_APPLICATION_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <FieldError
              id="biosketch-application-role-error"
              testId="biosketch-application-role-error"
              show={invalid.has("applicationRole")}
            >
              Select your role on this application.
            </FieldError>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="biosketch-contribution-line"
              className="text-foreground text-sm font-medium"
            >
              What you will do on this project{" "}
              <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </label>
            <Input
              id="biosketch-contribution-line"
              value={value.contributionLine}
              maxLength={BIOSKETCH_CONTRIBUTION_LINE_MAX}
              disabled={disabled}
              placeholder="e.g. lead the single-cell analyses for Aims 1 and 2"
              onChange={(e) => onChange({ ...value, contributionLine: e.target.value })}
              data-testid="biosketch-contribution-line"
            />
          </div>
        </>
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
              aria-invalid={invalid.has("projectTitle") || undefined}
              aria-describedby={
                invalid.has("projectTitle") ? "biosketch-project-title-error" : undefined
              }
              placeholder="e.g. Targeting tumor metabolism in pancreatic cancer"
              onChange={(e) => onChange({ ...value, projectTitle: e.target.value })}
              data-testid="biosketch-project-title"
            />
            <FieldError
              id="biosketch-project-title-error"
              testId="biosketch-project-title-error"
              show={invalid.has("projectTitle")}
            >
              Add the title of the project this statement is for.
            </FieldError>
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
              aria-invalid={invalid.has("aims") || undefined}
              aria-describedby={invalid.has("aims") ? "biosketch-aims-error" : undefined}
              placeholder="Outline the specific aims of the proposed project."
              onChange={(e) => onChange({ ...value, aims: e.target.value })}
              className="max-w-[70ch]"
              data-testid="biosketch-aims"
            />
            <FieldError
              id="biosketch-aims-error"
              testId="biosketch-aims-error"
              show={invalid.has("aims")}
            >
              Add the specific aims of the proposed project.
            </FieldError>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="biosketch-emphasis" className="text-foreground text-sm font-medium">
          Emphasis <span className="text-muted-foreground text-xs font-normal">(optional)</span>
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
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="biosketch-instructions" className="text-foreground text-sm font-medium">
            Additional instructions{" "}
            <span className="text-muted-foreground text-xs font-normal">(optional)</span>
          </label>
          {/* The count sits with the label it counts. It used to hang below the textarea,
              right-aligned and unlabelled, where "0/500" named nothing. */}
          <span
            aria-live="polite"
            className="text-muted-foreground text-xs tabular-nums"
            data-testid="biosketch-instructions-count"
          >
            {value.instructions.length}/{BIOSKETCH_INSTRUCTIONS_MAX}
          </span>
        </div>
        <Textarea
          id="biosketch-instructions"
          value={value.instructions}
          maxLength={BIOSKETCH_INSTRUCTIONS_MAX}
          disabled={disabled}
          placeholder="A steering note — e.g. keep the tone plain; foreground the translational arc."
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          className="max-w-[70ch]"
          data-testid="biosketch-instructions"
        />
      </div>

      {canSeeCost && cost != null && (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-xs" data-testid="biosketch-cost">
            ~${cost.toFixed(2)} per draft (estimate)
          </span>
          <span className="text-muted-foreground text-xs">
            Every draft runs a faithfulness pass that fact-checks each line against this
            scholar&rsquo;s records — about 3× the base estimate above.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * One field-level validation message. Rendered only after a Generate attempt
 * (the parent decides), so it never scolds a field the user has not reached.
 * The id is what the field's `aria-describedby` points at.
 */
function FieldError({
  id,
  testId,
  show,
  children,
}: {
  id: string;
  testId: string;
  show: boolean;
  children: React.ReactNode;
}) {
  if (!show) return null;
  return (
    <p id={id} className="text-destructive text-xs" data-testid={testId}>
      {children}
    </p>
  );
}
