"use client";

/**
 * One checkbox facet inside a report rail section (reports redesign; report 8's
 * person type, department / division, centers, institution and article type):
 * an optional search box, the options as native checkboxes carrying `name` /
 * `value`, an optional people count per option, and "Show all N" past
 * `collapseAfter`.
 *
 * The checkboxes are the form's own inputs, so a tick bubbles a native
 * `change` to the body's `AutoSubmitForm`, which submits the new selection —
 * no hidden inputs, no effect. A selected option is always rendered (pinned
 * first while searching, kept past the collapse), so a collapsed or filtered
 * list never drops a filter from the submit. Typing in the search box stops
 * its `change` here, and Enter there is swallowed, so a search never submits.
 * Nothing here reaches `@/lib/db`.
 */
import { useId, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";

export type ReportFacetOption = { value: string; label: string; count?: number };

export function ReportFacetList({
  name,
  options,
  selected,
  collapseAfter = Infinity,
  searchPlaceholder,
  countsLabel,
  testId,
}: {
  /** The URL param each checkbox submits (`type`, `unit`, `atype`). */
  name: string;
  options: ReadonlyArray<ReportFacetOption>;
  selected: ReadonlyArray<string>;
  collapseAfter?: number;
  /** A search box, when the list is longer than `collapseAfter`. */
  searchPlaceholder?: string;
  /** The column heading over the counts ("People"); omitted → no counts. */
  countsLabel?: string;
  testId?: string;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const idBase = useId();
  const chosen = new Set(selected);
  const q = query.trim().toLowerCase();

  let visible: ReadonlyArray<ReportFacetOption>;
  if (q) {
    visible = [
      ...options.filter((o) => chosen.has(o.value)),
      ...options.filter((o) => !chosen.has(o.value) && o.label.toLowerCase().includes(q)),
    ];
  } else {
    visible = showAll ? options : options.filter((o, i) => i < collapseAfter || chosen.has(o.value));
  }
  const collapsible = options.length > collapseAfter;

  return (
    <div
      className="flex flex-col gap-0.5"
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type === "search") e.preventDefault();
      }}
    >
      {searchPlaceholder && collapsible && (
        <div className="relative mb-2">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => {
              e.stopPropagation();
              setQuery(e.target.value);
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="bg-apollo-surface border-apollo-border-strong h-8 pl-8 text-sm md:text-sm"
          />
        </div>
      )}
      {countsLabel && (
        <div className="text-muted-foreground flex justify-end pb-0.5 text-[11px] tracking-[0.06em] uppercase">
          {countsLabel}
        </div>
      )}
      {visible.map((o, i) => {
        const id = `${idBase}-${i}`;
        return (
          <label
            key={o.value}
            htmlFor={id}
            className="hover:bg-apollo-rail-hover -mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-[5px] text-sm"
          >
            <input
              id={id}
              type="checkbox"
              name={name}
              value={o.value}
              defaultChecked={chosen.has(o.value)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary-cornell-red)]"
            />
            <span className="min-w-0 flex-1 leading-[1.35] break-words">{o.label}</span>
            {countsLabel && o.count !== undefined && (
              <span className="text-muted-foreground text-[13px] tabular-nums">{o.count.toLocaleString()}</span>
            )}
          </label>
        );
      })}
      {q && visible.length === 0 && <div className="text-muted-foreground py-1 text-[13px]">No matches.</div>}
      {collapsible && !q && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-apollo-slate mt-1 self-start text-xs hover:underline"
        >
          {showAll ? "Show fewer" : `Show all ${options.length.toLocaleString()}`}
        </button>
      )}
    </div>
  );
}
