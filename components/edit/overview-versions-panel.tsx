/**
 * OverviewVersionsPanel — the "Previous drafts" history list for the
 * overview-statement generator (#742 Phase B, `docs/overview-statement-generator-spec.md`
 * § Versions panel). Each Generate writes an `OverviewGeneration` row; this
 * panel lists the session user's own recent drafts (newest first) so they can
 * re-load a draft into the editor or re-apply the settings that produced it.
 *
 * Like {@link OverviewGenerateControls}, this is a pure presentation surface: it
 * owns no fetch and no state. The parent (`overview-card.tsx`) fetches the
 * generations, holds the editor seed/params, and wires `onLoad` / `onUseSettings`
 * — keeping the seed + network logic in one place. An empty list renders nothing
 * (the panel is hidden until the scholar has generated at least one draft).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { OVERVIEW_ELEMENTS, type OverviewParams } from "@/lib/edit/overview-params";

/** One history row, shaped to match the GET /api/edit/overview/generations
 *  contract (`createdAt` is the ISO string the route serializes). */
export type OverviewGenerationItem = {
  id: string;
  model: string;
  params: OverviewParams;
  createdAt: string;
  text: string;
};

type OverviewVersionsPanelProps = {
  generations: OverviewGenerationItem[];
  /** Re-seed the editor with this draft's text (parent bumps the editor key). */
  onLoad: (gen: OverviewGenerationItem) => void;
  /** Re-apply the settings that produced this draft to the Generate controls. */
  onUseSettings: (params: OverviewParams) => void;
  disabled?: boolean;
};

export function OverviewVersionsPanel({
  generations,
  onLoad,
  onUseSettings,
  disabled = false,
}: OverviewVersionsPanelProps) {
  // Empty history → render nothing; the panel only appears once a draft exists.
  if (generations.length === 0) return null;

  return (
    <details className="group" data-testid="overview-versions-panel">
      <summary className="text-apollo-maroon w-fit cursor-pointer text-sm font-medium select-none">
        Previous drafts ({generations.length})
      </summary>
      <ul className="border-apollo-border bg-apollo-surface-2 mt-3 flex flex-col gap-3 rounded-md border p-4">
        {generations.map((gen) => (
          <li
            key={gen.id}
            className="flex flex-wrap items-start justify-between gap-3"
            data-testid={`overview-version-${gen.id}`}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-foreground text-sm">
                {formatTimestamp(gen.createdAt)} · {gen.model}
              </span>
              <span className="text-muted-foreground text-xs">{summarizeParams(gen.params)}</span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onLoad(gen)}
                disabled={disabled}
                data-testid={`overview-version-load-${gen.id}`}
              >
                Load draft
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onUseSettings(gen.params)}
                disabled={disabled}
                data-testid={`overview-version-use-settings-${gen.id}`}
              >
                Use these settings
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A short human date for a history row — `slug-request-row.tsx`'s `formatDate`
 *  pattern (falls back to the raw ISO string on an unparseable value). */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Capitalize the first letter of a lower-case enum value for display. */
function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One-line summary of the settings a draft was generated with —
 * voice / tone / length capitalized, then the chosen element labels (verbatim
 * from {@link OVERVIEW_ELEMENTS}). E.g. "Third · Formal · Standard · Research
 * focus, Key findings & significance". The element segment is omitted when no
 * themes were emphasized.
 */
export function summarizeParams(params: OverviewParams): string {
  const head = [params.voice, params.tone, params.length].map(capitalize).join(" · ");
  const labels = params.elements
    .map((key) => OVERVIEW_ELEMENTS.find((e) => e.key === key)?.label)
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? `${head} · ${labels.join(", ")}` : head;
}
