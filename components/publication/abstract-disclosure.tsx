"use client";

import { useState } from "react";

const ABSTRACT_TRUNCATE_LINES = 3;

/**
 * Inline abstract disclosure for publication rows (#288 PR-A). Mirrors the
 * funding-abstract pattern (#86 / #92): collapsed by default to a single
 * chevron-prefixed "Abstract" button. Click expands to the abstract
 * clamped at 3 lines, with a Show more / Show less toggle for long text.
 *
 * The collapsed entry point keeps row chrome quiet on feeds where most
 * users skim by title/journal — only those who want the abstract pay the
 * visual cost.
 *
 * Pass `clampLines={false}` for modal / detail surfaces (#288 PR-B): the
 * component renders the full abstract directly with no chevron, no clamp,
 * no toggles. The detail surface has room and the chevron affordance is
 * redundant when the abstract is already the focus of the view.
 *
 * Returns null when `abstract` is null or empty so callers can drop it
 * unconditionally into a row without guarding against orphan chevrons.
 */
export function AbstractDisclosure({
  abstract,
  clampLines = ABSTRACT_TRUNCATE_LINES,
}: {
  abstract: string | null;
  clampLines?: number | false;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (!abstract) return null;

  if (clampLines === false) {
    return (
      <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">
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
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-[var(--color-accent-slate)] hover:underline"
      >
        <span aria-hidden="true">{open ? "▲" : "▼"}</span>
        Abstract
      </button>
      {open ? (
        <div className="mt-1">
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
      ) : null}
    </div>
  );
}
