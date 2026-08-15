"use client";

import { useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** localStorage key — namespaced like the other sticky edit-surface prefs
 *  (`coi-gap:groupBy`, `matcha:density`). */
const STORAGE_KEY = "edit-shell:rail-collapsed";

/**
 * Desktop-only collapse toggle around the ATTRIBUTES rail column. Reclaims
 * horizontal width for the detail panel on narrower desktop viewports without
 * touching the existing `md:` breakpoint that swaps the whole column for
 * `RailSheet` on phones — this wraps the SAME "hidden … md:flex" column, it
 * doesn't replace it.
 *
 * `children` is the server-rendered rail (`AttributeRail` + the optional
 * `subRail` block) passed straight through from `EditShell`, so the rail
 * itself stays server-rendered — only this thin chrome is a client island.
 *
 * Defaults EXPANDED (today's behavior, unchanged) and only flips to the
 * persisted collapsed state after mount, matching the SSR-safe "default first,
 * then read localStorage in an effect" pattern used for the sticky COI-gap
 * group-by (`coi-gap-card.tsx`) — no hydration mismatch, at the cost of a
 * one-frame flash for the (rare) returning collapsed user.
 *
 * The column's width is an explicit Tailwind width (`w-64` / `w-9`), so the
 * parent grid's `auto` first track just tracks it — no lifted state, no
 * re-render of `EditShell` itself.
 */
export function RailCollapse({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* private mode / disabled storage — keep the default (expanded). */
    }
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  if (collapsed) {
    return (
      <div
        className="bg-apollo-rail border-apollo-rail-border hidden w-9 flex-col items-center rounded-md border py-2 md:flex"
        data-testid="rail-collapsed"
      >
        <button
          type="button"
          onClick={toggle}
          aria-label="Expand attributes rail"
          data-testid="rail-collapse-toggle"
          className="text-muted-foreground hover:text-foreground hover:bg-apollo-rail-hover focus-visible:ring-apollo-ring inline-flex size-7 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronRightIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn("hidden w-64 flex-col gap-3 md:flex")} data-testid="rail-expanded">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={toggle}
          aria-label="Collapse attributes rail"
          data-testid="rail-collapse-toggle"
          className="text-muted-foreground hover:text-foreground hover:bg-apollo-rail-hover focus-visible:ring-apollo-ring inline-flex size-7 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  );
}
