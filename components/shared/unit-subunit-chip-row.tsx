"use client";

/**
 * Unit Page v2 — the hero's subunit list (divisions / programs), the one
 * interactive piece of the server-rendered hero. Rendered as up to three
 * ranked columns of whole-row links (name in slate, count right-aligned under a
 * column header that names its unit); it was a wrap of slate-outline chips,
 * which read like the topic tags in the roster below. "Chip" survives in the
 * names for continuity. A chip that carries a
 * `filter` narrows the roster below IN PLACE (the mock's pick(): set the
 * Division / Program facet to that value, smooth-scroll to #people) through
 * the window-event contract in `lib/unit-subunit-filter.ts`; the roster's own
 * replaceState sync then writes `?div=` / `?program=` into the URL.
 *
 * Every chip is still a real link: a filter chip's `href` is
 * `?div=<code>#people`, which the roster's client-side mount seeds from — so
 * from another tab and on modified clicks (new tab / window) it opens the
 * Scholars tab already filtered. With JS OFF it lands on the UNFILTERED roster:
 * no route reads `div` / `program` server-side (and neither is in the edge
 * cache-key allowlist). A chip without `filter` links the first-class
 * division / program page as before.
 *
 * Active state = the roster's current selection (it broadcasts on every
 * change, so ticking the facet checkbox lights the chip too); the active chip
 * gets `aria-current="true"` and clicking it clears that value.
 */
import { useEffect, useState } from "react";
import { chunkColumns, cn } from "@/lib/utils";
import { matchesMedia, scrollIntoViewAndFocus } from "@/lib/scroll-focus";
import {
  SUBUNIT_SELECTION_EVENT,
  requestSubunitSelect,
  type SubunitParam,
  type SubunitSelectionDetail,
} from "@/lib/unit-subunit-filter";

export type SubunitChipView = {
  key: string;
  label: string;
  href: string;
  count?: number | null;
  /** Present ⇒ the chip filters the roster in place (see module doc). */
  filter?: { param: SubunitParam; value: string };
};

/** Tailwind `md` — below it the rosters stack the facet aside above the list. */
const NARROW_QUERY = "(max-width: 767px)";

/**
 * After a chip filters the roster: scroll to `#people` (tabs + facets + list),
 * or on a narrow viewport straight to `#people-results` — there the facet
 * stack sits above the list and would fill the screen. Then move focus to the
 * results (`preventScroll`: the smooth scroll owns the viewport) so keyboard
 * and screen-reader users land where the change happened instead of staying
 * on the chip in the hero.
 */
function scrollAndFocusRoster(): void {
  const people = document.getElementById("people");
  const results = document.getElementById("people-results");
  const narrow = matchesMedia(NARROW_QUERY);
  scrollIntoViewAndFocus(narrow && results ? results : people, results);
}

export function UnitSubunitChipRow({
  chips,
  itemLabel = "Name",
  countLabel,
}: {
  chips: SubunitChipView[];
  /** Left column header, e.g. "Division". */
  itemLabel?: string;
  /** Right column header naming what the count counts, e.g. "Scholars". */
  countLabel?: string;
}) {
  // Selected filter values per param (a page has one chip row ⇒ one param).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const param = chips.find((c) => c.filter)?.filter?.param ?? null;

  useEffect(() => {
    if (!param) return;
    // Seed from the URL (a shared `?div=` link) until the roster broadcasts.
    setSelected(new Set(new URLSearchParams(window.location.search).getAll(param)));
    const onSelection = (e: Event) => {
      const d = (e as CustomEvent<SubunitSelectionDetail>).detail;
      if (d?.param === param) setSelected(new Set(d.values));
    };
    window.addEventListener(SUBUNIT_SELECTION_EVENT, onSelection);
    return () => window.removeEventListener(SUBUNIT_SELECTION_EVENT, onSelection);
  }, [param]);

  // Rank reads down each column: split into up to three columns of equal
  // length, so the largest subunits sit at the top of the first column.
  const columns = chunkColumns(chips, chips.length <= 4 ? 1 : chips.length <= 8 ? 2 : 3);

  return (
    <div
      className={cn(
        "mt-3 grid grid-cols-1 items-start gap-x-8",
        columns.length >= 2 && "sm:grid-cols-2",
        columns.length === 3 && "lg:grid-cols-3",
      )}
    >
      {columns.map((col, ci) => (
        <div key={ci} className="flex min-w-0 flex-col">
          {/* The column header names the count's unit. Repeated per column on
              wide screens; below `sm` the columns stack, so only the first
              keeps it. */}
          <div
            className={cn(
              "border-apollo-border-strong text-muted-foreground justify-between border-b pb-1.5 text-[11px]",
              ci === 0 ? "flex" : "hidden sm:flex",
            )}
            aria-hidden="true"
          >
            <span>{itemLabel}</span>
            {countLabel ? <span>{countLabel}</span> : null}
          </div>
          {col.map((c) => {
            const active = !!c.filter && selected.has(c.filter.value);
            return (
              <a
                key={c.key}
                href={c.href}
                aria-current={active ? "true" : undefined}
                onClick={
                  c.filter
                    ? (e) => {
                        // Let the browser handle new-tab / new-window / download clicks.
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                          return;
                        const f = c.filter!;
                        const handled = requestSubunitSelect(
                          f.param,
                          f.value,
                          active ? "remove" : "only",
                        );
                        // No roster listening (another tab / facet off) ⇒ plain link.
                        if (!handled) return;
                        e.preventDefault();
                        if (!active) {
                          // The roster's replaceState sync keeps the hash (see
                          // `urlWithQuery`), so the URL ends `?div=<code>#people`.
                          window.history.replaceState(
                            window.history.state,
                            "",
                            `${window.location.pathname}${window.location.search}#people`,
                          );
                          scrollAndFocusRoster();
                        }
                      }
                    : undefined
                }
                className={cn(
                  // A whole-row link: the name is slate (the site's link ink)
                  // so it reads as clickable at rest; hover tints the row and
                  // underlines the name.
                  "group border-apollo-border flex items-baseline justify-between gap-3 border-b py-[7px] last:border-b-0 text-[14px] no-underline transition-colors duration-[120ms] ease-out hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--apollo-ring)]",
                  active ? "bg-apollo-slate-tint" : "hover:bg-apollo-page",
                )}
              >
                <span
                  className={cn(
                    "text-apollo-slate min-w-0 decoration-1 underline-offset-4 group-hover:underline",
                    active && "font-medium",
                  )}
                >
                  {c.label}
                </span>
                {typeof c.count === "number" && (
                  <span className="text-muted-foreground text-[13px] whitespace-nowrap tabular-nums">
                    {c.count.toLocaleString()}
                  </span>
                )}
              </a>
            );
          })}
        </div>
      ))}
    </div>
  );
}
