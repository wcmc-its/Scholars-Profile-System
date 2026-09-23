/**
 * The overview source picker (#742 §2 / Phase 2), laid out per the 2026-09-23
 * "Overview editor, two-column" canvas:
 *
 *   - {@link OverviewSourcesRow} — the rail's "Sources" row: a one-line summary
 *     of what grounds the draft ("9 publications · 1 award · 6 methods") and an
 *     Edit / Close toggle.
 *   - {@link OverviewSourcePanel} — the panel that takes the editor's place in
 *     the left column while open, holding {@link OverviewIncludePicker}.
 *
 * The panel is **buffered**: it edits a LOCAL copy of the deltas, seeded when it
 * mounts, and commits them (`onClose(draft)`) when it closes — "‹ Overview" and
 * Done both close. The status line counts divergences from the recommended
 * auto-set ("1 pinned · 2 hidden"), never "9 of 25" (§2.5).
 */
"use client";

import * as React from "react";
import { ChevronLeft } from "lucide-react";

import { OverviewIncludePicker } from "@/components/edit/overview-include-picker";
import { Button } from "@/components/ui/button";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  DEFAULT_OVERVIEW_SELECTION_DELTAS,
  summarizeOverviewDeltas,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";
import { resolveOverviewSelection } from "@/lib/edit/overview-resolve";

function plural(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

/** One-line summary of what the deltas resolve to. */
export function summarizeSources(
  options: OverviewSourceOptions,
  deltas: OverviewSelectionDeltas,
): string {
  const sel = resolveOverviewSelection(options, deltas);
  const parts = [plural(sel.pmids.length, "publication"), plural(sel.grantIds.length, "award")];
  if (options.tools.length > 0) parts.push(plural(sel.toolNames.length, "method"));
  return parts.join(" · ");
}

/** The §2.5 status line — divergences from the auto-set, never a budget count. */
function statusLine(deltas: OverviewSelectionDeltas): string {
  const { pinned, hidden } = summarizeOverviewDeltas(deltas);
  const bits: string[] = [];
  if (pinned) bits.push(`${pinned} pinned`);
  if (hidden) bits.push(`${hidden} hidden`);
  return `Using your recommended set${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

export function OverviewSourcesRow({
  options,
  deltas,
  open,
  onToggle,
  disabled = false,
}: {
  /** The candidate lists; `null` until the source-options fetch resolves. */
  options: OverviewSourceOptions | null;
  deltas: OverviewSelectionDeltas;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="border-apollo-rail-border flex items-center gap-2.5 border-b px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-muted-foreground text-xs font-semibold">Sources</span>
        <span className="text-[13px]" data-testid="overview-sources-summary">
          {options ? summarizeSources(options, deltas) : "Loading sources…"}
        </span>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled || !options}
        aria-expanded={open}
        className="text-foreground text-[13px] underline underline-offset-2 disabled:opacity-60 aria-expanded:font-semibold"
        data-testid="overview-sources-trigger"
      >
        {open ? "Close" : "Edit"}
      </button>
    </div>
  );
}

export function OverviewSourcePanel({
  options,
  deltas,
  onClose,
  staleDraft = false,
  disabled = false,
}: {
  options: OverviewSourceOptions;
  /** The committed deltas; seeds the local buffer on mount. */
  deltas: OverviewSelectionDeltas;
  /** Close the panel, committing the edited deltas. */
  onClose: (next: OverviewSelectionDeltas) => void;
  /** A draft is under review — changing sources means it needs regenerating. */
  staleDraft?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = React.useState<OverviewSelectionDeltas>(deltas);
  const touched = draft !== deltas;

  return (
    <div
      className="border-apollo-border-strong overflow-hidden rounded-lg border"
      data-testid="overview-source-drawer"
    >
      <div className="border-apollo-border flex flex-wrap items-center gap-3 border-b px-3.5 py-3">
        <button
          type="button"
          onClick={() => onClose(draft)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px]"
          data-testid="overview-sources-back"
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          Overview
        </button>
        <h3 className="text-[15px] font-semibold">Sources for the AI draft</h3>
        <span
          className="text-muted-foreground ml-auto text-[13px]"
          data-testid="overview-sources-statusline"
        >
          {statusLine(draft)}
        </span>
      </div>

      <div className="max-h-[460px] overflow-y-auto p-3.5">
        <OverviewIncludePicker
          options={options}
          deltas={draft}
          onChange={setDraft}
          disabled={disabled}
        />
      </div>

      <div className="border-apollo-border bg-apollo-surface flex flex-wrap items-center gap-3 border-t px-3.5 py-3">
        <button
          type="button"
          onClick={() => setDraft(DEFAULT_OVERVIEW_SELECTION_DELTAS)}
          disabled={disabled}
          className="text-muted-foreground text-[13px] underline underline-offset-2"
          data-testid="overview-sources-reset"
        >
          Reset to recommended
        </button>
        {staleDraft && touched && (
          <span className="text-apollo-amber text-xs">
            Sources changed. Regenerate to update the draft.
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="apollo"
          className="ml-auto"
          onClick={() => onClose(draft)}
          data-testid="overview-sources-done"
        >
          Done
        </Button>
      </div>
    </div>
  );
}
