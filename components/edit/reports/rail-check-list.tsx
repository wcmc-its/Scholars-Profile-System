"use client";

/**
 * A rail section's checkbox list for a GET `AutoSubmitForm` (reports
 * redesign): plain named checkboxes, so ticking one submits the form with the
 * new selection, plus the mockup's conveniences, an optional search box and
 * "Show all N" past `shown` options.
 *
 * Nothing leaves the form: an option the search or the "Show all" cut hides
 * is `hidden`, not unmounted, so a ticked one still submits. The search box
 * has no `name` and its keystrokes stop here (the host form submits on every
 * bubbling change), and Enter in it is swallowed so it cannot submit either.
 * No server imports.
 */
import { useState } from "react";

export type RailOption = { value: string; label: string; count?: number };

export function RailCheckList({
  name,
  options,
  selected,
  searchPlaceholder,
  shown,
  countHeader,
  testId,
}: {
  /** The GET param each ticked option submits. */
  name: string;
  options: ReadonlyArray<RailOption>;
  selected: ReadonlyArray<string>;
  /** Shows a search box with this placeholder. */
  searchPlaceholder?: string;
  /** Options listed before "Show all N" (ticked ones always list). */
  shown?: number;
  /** The heading over the counts column, e.g. "People". */
  countHeader?: string;
  testId?: string;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const q = query.trim().toLowerCase();
  const matches = (o: RailOption) => o.label.toLowerCase().includes(q);
  const collapsed = shown !== undefined && !all && !q;
  const visible = new Set(
    options
      .filter(matches)
      .filter((o, i) => !collapsed || i < shown! || selected.includes(o.value))
      .map((o) => o.value),
  );
  // `i` above is the index among matches; with no query that is the option's own rank.
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      {searchPlaceholder && (
        <input
          type="search"
          value={query}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          onChange={(e) => {
            e.stopPropagation();
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          className="border-apollo-border-strong bg-apollo-surface mb-2 h-8 rounded-md border px-2.5 text-sm"
        />
      )}
      {countHeader && (
        <div className="text-muted-foreground flex justify-end pb-0.5 text-[11px] tracking-[0.06em] uppercase">
          {countHeader}
        </div>
      )}
      {options.map((o) => (
        <label
          key={o.value}
          hidden={!visible.has(o.value)}
          className="hover:bg-apollo-rail-hover -mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-[5px] text-sm"
        >
          <input
            type="checkbox"
            name={name}
            value={o.value}
            defaultChecked={selected.includes(o.value)}
            className="accent-apollo-maroon mt-0.5 size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 leading-[1.35]">{o.label}</span>
          {o.count !== undefined && (
            <span className="text-muted-foreground text-[13px] tabular-nums">
              {o.count.toLocaleString()}
            </span>
          )}
        </label>
      ))}
      {visible.size === 0 && (
        <div className="text-muted-foreground py-1 text-[13px]">No matches.</div>
      )}
      {shown !== undefined && !q && options.length > shown && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-apollo-slate mt-1 self-start text-xs hover:underline"
        >
          {all ? "Show fewer" : `Show all ${options.length}`}
        </button>
      )}
    </div>
  );
}
