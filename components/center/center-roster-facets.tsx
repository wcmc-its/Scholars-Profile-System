"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

export type FacetOption = { value: string; label: string; count: number };

/**
 * One facet group in the center-roster sidebar (#552 follow-on). Multi-select
 * checkbox list with live counts; a value whose count is 0 under the current
 * cross-facet selection is disabled (not hidden) so the option list is stable.
 * `collapseAfter` caps the visible rows (the Organizational-unit facet has many
 * departments) behind a "Show all" toggle.
 */
export function RosterFacet({
  title,
  options,
  selected,
  onToggle,
  collapseAfter = Infinity,
}: {
  title: string;
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  collapseAfter?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  if (options.length === 0) return null;

  const visible = showAll ? options : options.slice(0, collapseAfter);
  const hiddenCount = options.length - visible.length;

  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col p-0">
        {visible.map((o) => {
          const isSelected = selected.has(o.value);
          const disabled = o.count === 0 && !isSelected;
          return (
            <li key={o.value} className="py-[3px] leading-[1.4]">
              <button
                type="button"
                onClick={() => onToggle(o.value)}
                disabled={disabled}
                aria-pressed={isSelected}
                className={`flex w-full items-start gap-2 text-left text-[13px] ${
                  disabled
                    ? "cursor-default opacity-40"
                    : "cursor-pointer hover:text-foreground"
                } ${isSelected ? "text-foreground" : "text-muted-foreground"}`}
              >
                <input
                  type="checkbox"
                  readOnly
                  checked={isSelected}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="mt-[3px] accent-[var(--color-primary-cornell-red)]"
                />
                <span className="min-w-0 flex-1 break-words">{o.label}</span>
                <span className="mt-[1px] shrink-0 text-[12px] tabular-nums text-[var(--color-text-tertiary)]">
                  {o.count.toLocaleString()}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!showAll && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-[var(--color-primary-cornell-red)] hover:underline"
        >
          <ChevronDown aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          Show all {options.length}
        </button>
      ) : null}
      {showAll && options.length > collapseAfter ? (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-[var(--color-primary-cornell-red)] hover:underline"
        >
          <ChevronDown aria-hidden className="h-3.5 w-3.5 rotate-180" strokeWidth={2} />
          Show fewer
        </button>
      ) : null}
    </div>
  );
}
