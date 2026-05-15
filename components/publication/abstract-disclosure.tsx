"use client";

import { useState } from "react";

const ABSTRACT_TRUNCATE_LINES = 3;

/**
 * Inline abstract disclosure for publication rows (#288 PR-A). Collapsed by
 * default at 3 lines (matches the funding-abstract pattern); the Show more
 * toggle expands to full text and back. Pass `clampLines={false}` to render
 * fully expanded with no toggle — for modal / detail surfaces (#288 PR-B)
 * that have room and no longer want the truncation affordance.
 *
 * Returns null when `abstract` is null or empty so callers can drop it
 * unconditionally into a row without guarding against orphan chevrons on
 * publications that lack abstracts (common: older papers, editorials,
 * letters — many such rows in real feeds).
 */
export function AbstractDisclosure({
  abstract,
  clampLines = ABSTRACT_TRUNCATE_LINES,
}: {
  abstract: string | null;
  clampLines?: number | false;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!abstract) return null;

  if (clampLines === false) {
    return (
      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
        {abstract}
      </p>
    );
  }

  const clampClass =
    clampLines === 1
      ? "line-clamp-1"
      : clampLines === 2
        ? "line-clamp-2"
        : "line-clamp-3";

  return (
    <div className="mt-2">
      <p
        className={`text-sm leading-relaxed text-foreground/90 ${
          expanded ? "" : clampClass
        }`}
      >
        {abstract}
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
  );
}
