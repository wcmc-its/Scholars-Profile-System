"use client";

import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";

export type FacetOption = {
  value: string;
  label: string;
  count: number;
  /** Optional nesting depth (0/undefined = top level). Each level adds a left
   *  indent so a child option reads as nested under the one above it. */
  indent?: number;
};

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
  searchable = false,
  searchPlaceholder = "Search…",
  noMatchLabel = "No matches",
}: {
  title: string;
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  collapseAfter?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  noMatchLabel?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  if (options.length === 0) return null;

  // Search input only when explicitly enabled AND there are enough options to
  // warrant filtering (mirrors the collapse threshold so short lists stay simple).
  const showSearch = searchable && options.length > collapseAfter;
  const q = query.trim().toLowerCase();

  // Selected options must always stay visible + de-selectable, even when they
  // don't match the query: pin selected first, then the query-filtered
  // UNSELECTED matches, de-duped (a selected option never appears twice). The
  // search bypasses the collapse cap. With no query this is the original
  // collapse-after list in original order.
  let visible: FacetOption[];
  if (q) {
    const selectedOpts = options.filter((o) => selected.has(o.value));
    const matches = options.filter(
      (o) => !selected.has(o.value) && o.label.toLowerCase().includes(q),
    );
    visible = [...selectedOpts, ...matches];
  } else {
    visible = showAll ? options : options.slice(0, collapseAfter);
  }
  const hiddenCount = q ? 0 : options.length - visible.length;
  const noMatches = showSearch && q.length > 0 && visible.length === 0;

  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      {showSearch ? (
        <label className="mb-2 flex items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-2 py-1 text-[12.5px] focus-within:border-[var(--color-primary-cornell-red)]">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={`Search ${title}`}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
      ) : null}
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
                style={o.indent ? { paddingInlineStart: `${o.indent}rem` } : undefined}
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
      {noMatches ? (
        <div
          role="status"
          aria-live="polite"
          className="px-1 py-1 text-[12px] text-muted-foreground"
        >
          {noMatchLabel}
        </div>
      ) : null}
      {!q && !showAll && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-[var(--color-primary-cornell-red)] hover:underline"
        >
          <ChevronDown aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          Show all {options.length}
        </button>
      ) : null}
      {!q && showAll && options.length > collapseAfter ? (
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
