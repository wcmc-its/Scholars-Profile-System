"use client";

import { useState } from "react";

/**
 * The "Overview" disclosure on a CTL technology row, mirroring the publication
 * Abstract trigger (`publication-meta.tsx`): a dotted-underline peer link in the
 * badge row that reveals the "Technology Overview" text below, with a Show more /
 * Show less toggle. Two toggles total, exactly like the abstract.
 *
 * Renders nothing when `overview` is null, matching the disappear-when-missing
 * pattern of the other row affordances. This is the only client island in an
 * otherwise server-rendered section — the trigger and the collapse own local UI
 * state, so `technologies-section.tsx` stays a server component.
 *
 * `overview` is CTL's plain text. The bullet-form pages store one bullet per
 * `\n`-delimited line (e.g. "The Technology: …", "PoC Data: …"), so those render
 * as a real `<ul>` — markers and inter-item spacing, not a `whitespace-pre-line`
 * run-on. Collapsed shows the first `PREVIEW_BULLETS`; the toggle reveals the
 * rest. The prose-form pages are a single line (no `\n`) and render as a
 * paragraph clamped to three lines, exactly like the abstract. Either way the
 * text is escaped as content (never `dangerouslySetInnerHTML`), so any `<`/`>`
 * from CTL's prose is inert.
 *
 * The reveal is `basis-full` so, inside the flex badge row, it wraps onto its
 * own full-width line beneath the chips rather than sitting inline.
 */
const PREVIEW_BULLETS = 3;

export function TechnologyOverview({ overview }: { overview: string | null }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!overview) return null;

  // Bullet-form → one item per line; prose-form → a single item (no `\n`).
  const bullets = overview
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const isList = bullets.length > 1;
  const canToggle = isList ? bullets.length > PREVIEW_BULLETS : true;

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
          {isList ? (
            <ul className="text-foreground/90 list-disc space-y-1 pl-5 text-sm leading-relaxed">
              {(expanded ? bullets : bullets.slice(0, PREVIEW_BULLETS)).map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : (
            <p
              className={`text-foreground/90 text-sm leading-relaxed whitespace-pre-line ${
                expanded ? "" : "line-clamp-3"
              }`}
            >
              {overview}
            </p>
          )}
          {canToggle ? (
            <button
              type="button"
              onClick={() => setExpanded((s) => !s)}
              aria-expanded={expanded}
              className="mt-1 text-xs text-[var(--color-accent-slate)] hover:underline"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
