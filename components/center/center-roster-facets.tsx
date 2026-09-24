"use client";

import { useId, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

export type FacetOption = { value: string; label: string; count: number };

/**
 * One facet group in the center-roster sidebar (#552 follow-on). Multi-select
 * checkbox list with live counts; a value whose count is 0 under the current
 * cross-facet selection is disabled (not hidden) so the option list is stable.
 * `collapseAfter` caps the visible rows (the Organizational-unit facet has many
 * departments) behind a "Show all" toggle.
 *
 * `variant="unit"` (Unit Page v2): 11px / 0.14em group label, DS `Checkbox` +
 * `<label>` rows (grid 14px | 1fr | auto), 13px foreground labels, muted
 * tabular counts, DS `Input` search with a leading icon. Each checkbox's
 * accessible name is "{label} {count}" (aria-labelledby over both cells). The
 * default variant is the original button-row facet (/edit rails share it).
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
  variant = "default",
}: {
  title: string;
  options: FacetOption[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  collapseAfter?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  noMatchLabel?: string;
  /** "unit" — the Unit Page v2 look (dept / division / center rosters): DS
   *  Checkbox rows, 0.14em label, DS Input search. "default" keeps the
   *  original button-row facet the /edit console rails share, unchanged. */
  variant?: "default" | "unit";
}) {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const idBase = useId();
  if (options.length === 0) return null;

  // Search input only when explicitly enabled AND there are enough options to
  // warrant filtering (mirrors the collapse threshold so short lists stay simple).
  const showSearch = searchable && options.length > collapseAfter;
  const q = query.trim().toLowerCase();

  // Selected options must always stay visible + de-selectable, even when they
  // don't match the query: pin selected first, then the query-filtered
  // UNSELECTED matches, de-duped (a selected option never appears twice). The
  // search bypasses the collapse cap. With no query this is the original
  // collapse-after list in original order, plus any selection that sits past
  // the cap — a filter you can see acting but can't see (or un-tick) is worse
  // than a longer list, and "Clear" would take every other facet down with it.
  let visible: FacetOption[];
  if (q) {
    const selectedOpts = options.filter((o) => selected.has(o.value));
    const matches = options.filter(
      (o) => !selected.has(o.value) && o.label.toLowerCase().includes(q),
    );
    visible = [...selectedOpts, ...matches];
  } else {
    visible = showAll
      ? options
      : options.filter((o, i) => i < collapseAfter || selected.has(o.value));
  }
  const hiddenCount = q ? 0 : options.length - visible.length;
  const noMatches = showSearch && q.length > 0 && visible.length === 0;

  if (variant === "unit") {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-normal uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h3>
        {showSearch ? (
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-[9px] top-1/2 z-[1] size-[13px] -translate-y-1/2 text-muted-foreground"
              strokeWidth={2}
            />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={`Search ${title}`}
              className="h-8 border-muted-foreground bg-white pl-7 text-[13px] md:text-[13px]"
            />
          </div>
        ) : null}
        <ul className="m-0 flex list-none flex-col p-0">
          {visible.map((o, i) => {
            const isSelected = selected.has(o.value);
            const disabled = o.count === 0 && !isSelected;
            const id = `${idBase}-${i}`;
            return (
              <li
                key={o.value}
                className={`grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-[7px] py-[3px] ${
                  disabled ? "opacity-40" : ""
                }`}
              >
                <Checkbox
                  id={id}
                  checked={isSelected}
                  disabled={disabled}
                  onCheckedChange={() => onToggle(o.value)}
                  aria-labelledby={`${id}-label ${id}-count`}
                  className="mt-[2px] size-3.5 border-muted-foreground bg-white"
                />
                <label
                  id={`${id}-label`}
                  htmlFor={id}
                  className={`break-words text-[13px] leading-[18px] text-foreground ${
                    disabled ? "cursor-default" : "cursor-pointer"
                  }`}
                >
                  {o.label}
                </label>
                <span
                  id={`${id}-count`}
                  className="text-[12px] leading-[18px] tabular-nums text-muted-foreground"
                >
                  {o.count.toLocaleString()}
                </span>
              </li>
            );
          })}
        </ul>
        {noMatches ? (
          <div
            role="status"
            aria-live="polite"
            className="py-1 text-[12px] text-muted-foreground"
          >
            {noMatchLabel}
          </div>
        ) : null}
        {!q && !showAll && hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="inline-flex cursor-pointer items-center gap-1 self-start text-[13px] text-[var(--color-primary-cornell-red)] hover:underline"
          >
            <ChevronDown aria-hidden className="size-[11px]" strokeWidth={2.5} />
            Show all {options.length}
          </button>
        ) : null}
        {!q && showAll && options.length > collapseAfter ? (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="inline-flex cursor-pointer items-center gap-1 self-start text-[13px] text-[var(--color-primary-cornell-red)] hover:underline"
          >
            <ChevronDown aria-hidden className="size-[11px] rotate-180" strokeWidth={2.5} />
            Show fewer
          </button>
        ) : null}
      </div>
    );
  }

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
