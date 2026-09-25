"use client";

/**
 * A long checkbox list inside a report rail's GET form (reports redesign,
 * 2026-09-24; report 7's Publication year and Mentor sections): native
 * `name=value` checkboxes, so a tick bubbles `change` to the body's
 * `AutoSubmitForm` and the selection rides the query string like every other
 * rail control; a count per option under a small column label ("Learners",
 * "Publications"); optionally a search box and a "Show all N" cap.
 *
 * Hidden options stay in the DOM (`hidden`), never unmounted, and a CHECKED
 * option is always visible — a filter you can see acting but can't un-tick is
 * worse than a longer list (`RosterFacet`'s rule). The search box has no
 * `name` and stops its own `change` / Enter, so typing never submits the
 * form. Nothing here reaches `@/lib/db`.
 */
import { useState } from "react";

export type RailChecklistOption = { value: string; label: string; count: number };

export function RailChecklist({
  name,
  options,
  selected,
  countLabel,
  collapseAfter = Infinity,
  searchPlaceholder,
  testId,
}: {
  /** The query-string key each checkbox submits. */
  name: string;
  options: ReadonlyArray<RailChecklistOption>;
  selected: ReadonlyArray<string>;
  /** The small uppercase label over the counts column. */
  countLabel: string;
  collapseAfter?: number;
  /** Given → a search box (shown when the list is longer than the cap). */
  searchPlaceholder?: string;
  testId?: string;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const chosen = new Set(selected);
  const q = query.trim().toLowerCase();
  const showSearch = searchPlaceholder !== undefined && options.length > collapseAfter;

  let visibleCount = 0;
  const rows = options.map((o, i) => {
    const checked = chosen.has(o.value);
    const shown = checked || (q ? o.label.toLowerCase().includes(q) : showAll || i < collapseAfter);
    if (shown) visibleCount += 1;
    return { ...o, checked, shown };
  });
  const hiddenCount = q ? 0 : options.length - visibleCount;

  if (options.length === 0) return <p className="text-muted-foreground text-[13px]">None in this selection.</p>;
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      {showSearch && (
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
          className="border-apollo-border-strong bg-apollo-surface mb-1.5 h-8 rounded-md border px-2 text-sm"
        />
      )}
      <div className="text-muted-foreground flex justify-end text-[11px] tracking-[0.06em] uppercase" aria-hidden>
        {countLabel}
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((o) => {
          const dim = o.count === 0 && !o.checked;
          return (
            <li key={o.value} hidden={!o.shown}>
              <label
                className={`hover:bg-apollo-rail-hover -mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 text-sm ${
                  dim ? "opacity-50" : ""
                }`}
              >
                <input
                  type="checkbox"
                  name={name}
                  value={o.value}
                  defaultChecked={o.checked}
                  className="mt-[3px] accent-[var(--apollo-maroon)]"
                />
                <span className="min-w-0 flex-1 leading-[1.35] break-words">{o.label}</span>
                <span className="text-muted-foreground text-[13px] tabular-nums">{o.count.toLocaleString()}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {q && visibleCount === 0 && <p className="text-muted-foreground py-1 text-[13px]">No matches.</p>}
      {!q && (hiddenCount > 0 || (showAll && options.length > collapseAfter)) && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-apollo-slate self-start text-[13px] hover:underline"
        >
          {showAll ? "Show fewer" : `Show all ${options.length.toLocaleString()}`}
        </button>
      )}
    </div>
  );
}
