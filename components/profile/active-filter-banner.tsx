"use client";

import type { ScholarKeyword } from "@/lib/api/profile";
import type { PositionFilter } from "@/components/profile/author-position-badge";

const POSITION_BANNER_LABEL: Record<Exclude<PositionFilter, "all">, string> = {
  first: "First author",
  senior: "Senior author",
  co_author: "Co-author",
};

/**
 * Active-filter banner for the profile publications surface (#73, extended by
 * #72). Composes the topic segment (`using <kw1> or <kw2>` / `using any of:
 * …`) with the position segment (` · Senior author`). Renders nothing when no
 * filter is active.
 */
export function ActiveFilterBanner({
  count,
  selected,
  position = "all",
  onClearAll,
}: {
  count: number;
  selected: ScholarKeyword[];
  position?: PositionFilter;
  onClearAll: () => void;
}) {
  const positionActive = position !== "all";
  if (selected.length === 0 && !positionActive) return null;

  const labels = selected.map((s) => s.displayLabel);
  const filterCount = selected.length + (positionActive ? 1 : 0);
  const buttonLabel = filterCount === 1 ? "Clear filter" : "Clear all";

  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-2.5"
      style={{
        backgroundColor: "color-mix(in oklab, var(--color-accent-slate) 8%, transparent)",
        borderColor: "color-mix(in oklab, var(--color-accent-slate) 25%, transparent)",
        color: "var(--color-accent-slate)",
      }}
    >
      <span className="text-sm">
        Filtered to{" "}
        <strong className="font-semibold">
          {count} {count === 1 ? "publication" : "publications"}
        </strong>
        {labels.length === 1 ? (
          <>
            {" "}using <strong className="font-semibold">{labels[0]}</strong>
          </>
        ) : labels.length === 2 ? (
          <>
            {" "}using{" "}
            <strong className="font-semibold">{labels[0]}</strong>
            {" "}or{" "}
            <strong className="font-semibold">{labels[1]}</strong>
          </>
        ) : labels.length >= 3 ? (
          <>
            {" "}using any of:{" "}
            {labels.map((l, i) => (
              <span key={l}>
                <strong className="font-semibold">{l}</strong>
                {i < labels.length - 1 ? ", " : ""}
              </span>
            ))}
          </>
        ) : null}
        {positionActive ? (
          <>
            {" "}
            <span aria-hidden="true">·</span>{" "}
            <strong className="font-semibold">
              {POSITION_BANNER_LABEL[position as Exclude<PositionFilter, "all">]}
            </strong>
          </>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onClearAll}
        className="text-sm font-medium underline-offset-4 hover:underline"
        style={{ color: "var(--color-accent-slate)" }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
