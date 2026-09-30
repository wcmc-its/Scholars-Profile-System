"use client";

/**
 * Unit Page v2 — the hero's subunit chip row (divisions / programs), the one
 * interactive piece of the server-rendered hero. A chip that carries a
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
import { cn } from "@/lib/utils";
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

export function UnitSubunitChipRow({ chips }: { chips: SubunitChipView[] }) {
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

  return (
    <div className="mt-3 flex flex-wrap gap-[6px]">
      {chips.map((c) => {
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
              "border-apollo-slate text-apollo-slate inline-flex min-h-[26px] max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] leading-tight no-underline transition-colors duration-[120ms] ease-out hover:no-underline",
              active
                ? "bg-apollo-slate hover:bg-apollo-slate/90 text-white"
                : "hover:bg-apollo-slate-tint bg-white",
            )}
          >
            {c.label}
            {typeof c.count === "number" && (
              <span
                className={cn(
                  "whitespace-nowrap tabular-nums",
                  active ? "text-white/80" : "text-muted-foreground",
                )}
              >
                {c.count.toLocaleString()}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}
