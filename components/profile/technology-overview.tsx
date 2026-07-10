"use client";

import { useState } from "react";

/**
 * The "Overview" disclosure on a CTL technology row, mirroring the publication
 * Abstract trigger (`publication-meta.tsx`): a dotted-underline peer link in the
 * badge row that reveals the "Technology Overview" text below, clamped at three
 * lines with a Show more / Show less toggle. Two toggles total, exactly like the
 * abstract.
 *
 * Renders nothing when `overview` is null, matching the disappear-when-missing
 * pattern of the other row affordances. This is the only client island in an
 * otherwise server-rendered section — the trigger and the clamp own local UI
 * state, so `technologies-section.tsx` stays a server component.
 *
 * `overview` is CTL's plain text with bullets joined one per line, so it renders
 * with `whitespace-pre-line` to keep those line breaks. It is escaped as text
 * content (never `dangerouslySetInnerHTML`), so any `<`/`>` from CTL's prose is
 * inert.
 *
 * The reveal is `basis-full` so, inside the flex badge row, it wraps onto its
 * own full-width line beneath the chips rather than sitting inline.
 */
export function TechnologyOverview({ overview }: { overview: string | null }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!overview) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent-slate)]"
      >
        Overview
      </button>
      {open ? (
        <div className="mt-2 basis-full">
          <p
            className={`text-foreground/90 text-sm leading-relaxed whitespace-pre-line ${
              expanded ? "" : "line-clamp-3"
            }`}
          >
            {overview}
          </p>
          <button
            type="button"
            onClick={() => setExpanded((s) => !s)}
            aria-expanded={expanded}
            className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      ) : null}
    </>
  );
}
