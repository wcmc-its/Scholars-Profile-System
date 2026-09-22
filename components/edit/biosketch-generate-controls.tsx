/**
 * `BiosketchGenerateControls` — the steering panel for the NIH-biosketch prose
 * generator (#917 v5, `docs/overview-generator-prompt-v5.md`). A pure CONTROLLED
 * input surface that mirrors the visual language of `OverviewGenerateControls`:
 * segmented pills, the privileged cost line, and a free-text steering note. It
 * owns no params state and triggers no fetch — the parent (`BiosketchTool`)
 * holds the value + the Generate button.
 *
 * The mode (Contributions / Personal Statement) is chosen by the parent's mode
 * cards; this renders the inputs for the chosen mode:
 *   - Contributions — a `maxContributions` 1..5 segmented stepper (default 5).
 *   - Personal Statement — an "About this application" group of REQUIRED inputs:
 *     `projectTitle` + `aims` (the route 400s without them), and under a v8 prompt
 *     (#2653) a REQUIRED role select plus an optional 200-char contribution line.
 *
 * Then the parent's Generate row (`action`), then a "Steer the draft" disclosure
 * (label, emphasis, instructions, and for Contributions the optional proposed
 * project), then a collapsed "Staff controls" block. Untrusted free text is
 * clamped client-side at the same ceilings the server re-normalizes against
 * (`biosketch-params.ts`).
 *
 * The prompt version, the per-draft cost (gated by `canSeeCost`, superuser /
 * comms-steward only), and the parent's debug action live in "Staff controls";
 * a faculty owner never sees that block.
 */
"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";

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
  type BiosketchParams,
} from "@/lib/edit/biosketch-params";
import {
  biosketchVersionUsesApplicationRole,
  type BiosketchPromptVersionId,
  type BiosketchPromptVersionMeta,
} from "@/lib/edit/biosketch-prompt-versions";
import { estimateBiosketchCostUsd } from "@/lib/llm/pricing";
import { cn } from "@/lib/utils";

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
  /** The Generate row, rendered between the required inputs and the optional disclosures. */
  action?: React.ReactNode;
  /** Superuser-only debug control, rendered inside the Staff controls block. */
  debugAction?: React.ReactNode;
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
  action,
  debugAction,
}: BiosketchGenerateControlsProps) {
  const isStatement = value.mode === "personal_statement";
  const invalid = React.useMemo(() => new Set(invalidFields), [invalidFields]);
  // #2653 v8 — the role on the application is a v8 input; v5–v7 ignore it, so the control hides.
  const asksRole = isStatement && biosketchVersionUsesApplicationRole(value.promptVersion);
  const cost = canSeeCost ? estimateBiosketchCostUsd(model, value.mode) : null;
  const showVersionSelector = canSelectVersion && versions.length > 0;
  const selectedVersion = versions.find((v) => v.id === value.promptVersion);
  const showStaff = showVersionSelector || cost != null || debugAction != null;

  return (
    <div className="flex flex-col gap-5" data-slot="biosketch-generate-controls">
      {!isStatement && (
        <div className="flex flex-col gap-1.5">
          <SegmentedField
            legend="How many contributions"
            name="biosketch-max-contributions"
            options={MAX_CONTRIBUTIONS_OPTIONS}
            value={String(value.maxContributions)}
            disabled={disabled}
            onValueChange={(v) => onChange({ ...value, maxContributions: Number(v) })}
          />
          <p className="text-muted-foreground text-xs">
            NIH allows up to five. Fewer are drafted when the record does not support five distinct
            bodies of work. The count is a ceiling, never a target.
          </p>
        </div>
      )}

      {/* The required application inputs lead the Personal Statement form, grouped and
          labelled as required once, ahead of every optional control. */}
      {isStatement && (
        <div className="border-apollo-border-strong bg-apollo-surface-2 flex flex-col gap-4 rounded-md border p-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-foreground text-sm font-semibold">About this application</span>
            <span className="text-muted-foreground text-xs" data-testid="biosketch-statement-hint">
              {asksRole ? "All three are required" : "Both are required"}. The statement argues your
              fitness for this project{asksRole ? " in this role" : ""}.
            </span>
          </div>

          {asksRole && (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="biosketch-application-role"
                className="text-foreground text-sm font-medium"
              >
                Your role on this application
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
          )}

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="biosketch-project-title"
              className="text-foreground text-sm font-medium"
            >
              Proposed project title
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
              className="max-w-[62ch]"
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
              Specific aims
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

          {asksRole && (
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
                className="max-w-[62ch]"
                data-testid="biosketch-contribution-line"
              />
            </div>
          )}
        </div>
      )}

      {action}

      {/* Everything optional sits behind one disclosure, below the action: the form reads
          required → Generate, and steering is there for whoever wants it. */}
      <details className="group border-apollo-border border-t pt-3.5" data-testid="biosketch-steer">
        <summary className="text-foreground flex cursor-pointer list-none items-center gap-2 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          Steer the draft{" "}
          <span className="text-muted-foreground text-xs font-normal">
            (optional: label, emphasis, instructions{isStatement ? "" : ", proposed project"})
          </span>
        </summary>
        <div className="flex flex-col gap-4 pt-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="biosketch-label" className="text-foreground text-sm font-medium">
              Label{" "}
              <span className="text-muted-foreground text-xs font-normal">
                (the application this draft is for)
              </span>
            </label>
            <Input
              id="biosketch-label"
              value={label}
              maxLength={labelMax}
              disabled={disabled}
              placeholder="e.g. R01 resubmission, Oct 2026"
              className="max-w-[52ch]"
              onChange={(e) => onLabelChange(e.target.value)}
              data-testid="biosketch-label"
            />
          </div>

          {!isStatement && (
            <div
              className="border-apollo-border bg-apollo-surface-2 flex flex-col gap-2.5 rounded-md border p-3.5"
              data-testid="biosketch-project-optional"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground text-sm font-semibold">
                  Tailor to a proposed project
                </span>
                <span className="text-muted-foreground text-xs">
                  Sets which publications are surfaced as &ldquo;most related&rdquo;.
                </span>
              </div>
              <Input
                id="biosketch-related-title"
                value={value.projectTitle}
                maxLength={BIOSKETCH_PROJECT_TITLE_MAX}
                disabled={disabled}
                placeholder="Proposed project title"
                aria-label="Proposed project title"
                onChange={(e) => onChange({ ...value, projectTitle: e.target.value })}
                className="max-w-[62ch]"
                data-testid="biosketch-related-title"
              />
              <Textarea
                id="biosketch-related-aims"
                value={value.aims}
                maxLength={BIOSKETCH_AIMS_MAX}
                disabled={disabled}
                placeholder="Specific aims"
                aria-label="Specific aims"
                onChange={(e) => onChange({ ...value, aims: e.target.value })}
                className="max-w-[70ch]"
                data-testid="biosketch-related-aims"
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="biosketch-emphasis" className="text-foreground text-sm font-medium">
              Emphasis
            </label>
            <Input
              id="biosketch-emphasis"
              value={value.emphasis}
              maxLength={BIOSKETCH_EMPHASIS_MAX}
              disabled={disabled}
              placeholder="e.g. weight toward clinical work; AAV gene therapy"
              onChange={(e) => onChange({ ...value, emphasis: e.target.value })}
              className="max-w-[62ch]"
              data-testid="biosketch-emphasis"
            />
          </div>

          <div className="flex max-w-[70ch] flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <label
                htmlFor="biosketch-instructions"
                className="text-foreground text-sm font-medium"
              >
                Additional instructions
              </label>
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
              placeholder="A steering note, e.g. keep the tone plain; foreground the translational arc."
              onChange={(e) => onChange({ ...value, instructions: e.target.value })}
              data-testid="biosketch-instructions"
            />
          </div>
        </div>
      </details>

      {/* Prompt version, cost, and the payload debug are staff tooling; a faculty member
          drafting their own biosketch never sees this block. */}
      {showStaff && (
        <details
          className="group border-apollo-border border-t pt-3.5"
          data-testid="biosketch-staff"
        >
          <summary className="text-foreground flex cursor-pointer list-none items-center gap-2 text-sm font-semibold select-none [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            Staff controls
            <span className="border-apollo-border-strong bg-apollo-lock-bg text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-semibold">
              Superusers &amp; curators
            </span>
          </summary>
          <div className="flex flex-col gap-4 pt-4">
            {showVersionSelector && (
              <div className="flex flex-col gap-1.5" data-testid="biosketch-prompt-version-field">
                <label
                  htmlFor="biosketch-prompt-version"
                  className="text-foreground text-sm font-medium"
                >
                  Prompt version
                </label>
                <select
                  id="biosketch-prompt-version"
                  value={value.promptVersion}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      promptVersion: e.target.value as BiosketchPromptVersionId,
                    })
                  }
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
                  <span
                    id="biosketch-prompt-version-desc"
                    className="text-muted-foreground max-w-[84ch] text-xs"
                  >
                    {selectedVersion.description}
                  </span>
                )}
              </div>
            )}
            {cost != null && (
              <div className="flex flex-wrap items-center gap-3">
                {/* One total. The faithfulness pass runs on every draft and brings the run to
                    roughly 3x the drafting call (`estimateBiosketchCostUsd`). */}
                <span
                  className="border-apollo-border-strong bg-apollo-lock-bg rounded-md border px-3 py-1.5 text-sm tabular-nums"
                  data-testid="biosketch-cost"
                >
                  Est. <strong>${(cost * 3).toFixed(2)}</strong> per draft
                </span>
                <span className="text-muted-foreground max-w-[62ch] text-xs">
                  Includes the faithfulness pass that fact-checks every line against this
                  scholar&rsquo;s records. Drafting alone is about ${cost.toFixed(2)}.
                </span>
              </div>
            )}
            {debugAction}
          </div>
        </details>
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
