/**
 * OverviewDraftReviewCard — the safety net between generation and the editor
 * (#875 §4.3). Generation NEVER writes the editor directly; every draft lands
 * here first, in a coral-tinted card that reads as "AI output, not yet yours",
 * so a hand-written bio can never be clobbered by a single click.
 *
 * A pure presentational surface: it owns no state. The parent (`overview-card.tsx`)
 * holds the draft + the draft history and wires the three actions —
 *
 *   - **Replace current bio** — overwrites the editor with this draft.
 *   - **Insert below** — appends this draft to the editor's current contents.
 *   - **Discard** — dismisses the card; the editor and saved bio are untouched.
 *
 * The "Draft N of M · view previous" affordance steps back through prior drafts
 * (the parent fetches `OverviewGeneration` rows on mount, so history persists
 * across visits). Until the user picks Replace or Insert, nothing is published
 * and the editor stays exactly as it was.
 */
"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";

export type OverviewReviewDraft = {
  /** The generated HTML to review. */
  text: string;
  /** The OverviewGeneration row id, or null for a history write that hiccuped. */
  generationId: string | null;
  /** ISO timestamp the draft was generated. */
  createdAt: string;
};

type OverviewDraftReviewCardProps = {
  /** The draft currently under review. */
  draft: OverviewReviewDraft;
  /** 1-based position of this draft in the history, for "Draft N of M". */
  index: number;
  /** Total drafts available to page through. */
  total: number;
  /** Step to an adjacent draft (parent re-points `draft`); null hides the arrow. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Overwrite the editor with this draft's text. */
  onReplace: () => void;
  /** Append this draft's text to the editor's current contents. */
  onInsert: () => void;
  /** Dismiss the card without touching the editor. */
  onDiscard: () => void;
  disabled?: boolean;
};

/** A short relative time for the draft header (e.g. "just now", "3 min ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

export function OverviewDraftReviewCard({
  draft,
  index,
  total,
  onPrev,
  onNext,
  onReplace,
  onInsert,
  onDiscard,
  disabled = false,
}: OverviewDraftReviewCardProps) {
  const canPrev = onPrev != null && index > 1;
  const canNext = onNext != null && index < total;

  return (
    <div
      className="border-apollo-coral-tint-border bg-apollo-coral-tint text-apollo-coral-foreground flex flex-col gap-3 rounded-lg border p-4"
      data-testid="overview-draft-review-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="size-4" aria-hidden="true" />
          Draft · {relativeTime(draft.createdAt)}
        </span>
        {total > 1 && (
          <span className="flex items-center gap-1.5 text-xs" data-testid="overview-draft-pager">
            <button
              type="button"
              onClick={onPrev}
              disabled={disabled || !canPrev}
              aria-label="View previous draft"
              className="inline-flex items-center disabled:opacity-40"
              data-testid="overview-draft-prev"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="tabular-nums">
              Draft {index} of {total} · view previous
            </span>
            <button
              type="button"
              onClick={onNext}
              disabled={disabled || !canNext}
              aria-label="View next draft"
              className="inline-flex items-center disabled:opacity-40"
              data-testid="overview-draft-next"
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        )}
      </div>

      <div
        className="prose prose-sm border-apollo-coral-tint-border/60 max-w-none rounded-md border bg-white/60 px-3 py-2"
        dangerouslySetInnerHTML={{ __html: draft.text }}
        data-testid="overview-draft-body"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="apollo"
          size="sm"
          onClick={onReplace}
          disabled={disabled}
          data-testid="overview-draft-replace"
        >
          Replace current overview
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onInsert}
          disabled={disabled}
          data-testid="overview-draft-insert"
        >
          Insert below
        </Button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={disabled}
          className="text-apollo-coral-foreground/80 hover:text-apollo-coral-foreground text-sm underline-offset-2 hover:underline disabled:opacity-50"
          data-testid="overview-draft-discard"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
