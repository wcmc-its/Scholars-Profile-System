/**
 * UnitSectionNav — the in-page section index for the single-scroll unit editor
 * (`components/edit/unit-edit-sections.tsx`, Edit Center / Edit Org Unit
 * mockups, 2026-09-25).
 *
 * Every section of the unit editor now lives on one scrolling page, so this nav
 * is a list of `#anchor` links (not the old `?attr=` panel switcher). Each row
 * carries a short stat on the right ("3", "No description") — an amber stat
 * flags something the curator should fill in.
 *
 * - Desktop (`md+`): a sticky rail beside the sections; the section currently
 *   in view gets the white fill + maroon spine (scroll-spy via
 *   IntersectionObserver, degrading to "first section" where it's missing).
 * - Phone: a horizontally scrolling chip row above the sections, so the page
 *   stays usable at 390px without a second column.
 *
 * `initialSection` keeps old `?attr=` deep links working: the page maps the
 * legacy attribute key to its section id and this component scrolls to it once
 * on mount.
 */
"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export type UnitSectionNavItem = {
  /** The section's DOM id (the `#anchor`). */
  id: string;
  label: string;
  /** Short right-aligned stat — a count, or a nudge like "No description". */
  stat?: string;
  /** Renders the stat in amber: something here still needs filling in. */
  warn?: boolean;
};

export function UnitSectionNav({
  items,
  initialSection,
}: {
  items: ReadonlyArray<UnitSectionNavItem>;
  initialSection?: string;
}) {
  const [active, setActive] = React.useState<string | undefined>(
    initialSection ?? items[0]?.id,
  );
  const idsKey = items.map((i) => i.id).join("|");

  // Legacy `?attr=` deep link → scroll that section into view once.
  React.useEffect(() => {
    if (!initialSection) return;
    const el = document.getElementById(initialSection);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
  }, [initialSection]);

  // Scroll-spy: the topmost section intersecting the upper part of the
  // viewport is the active one.
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = idsKey.split("|").filter(Boolean);
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [idsKey]);

  return (
    <>
      {/* Phone: a scrollable chip row. */}
      <nav
        aria-label="Sections"
        className="-mx-4 overflow-x-auto px-4 md:hidden"
        data-testid="unit-section-nav-mobile"
      >
        <ul className="flex w-max gap-1.5">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                onClick={() => setActive(item.id)}
                aria-current={active === item.id ? "location" : undefined}
                className={cn(
                  "border-apollo-border-strong inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] whitespace-nowrap",
                  active === item.id ? "bg-apollo-surface font-semibold" : "bg-apollo-rail",
                )}
              >
                {item.label}
                {item.stat && (
                  <span
                    className={cn(
                      "text-xs font-normal",
                      item.warn ? "text-apollo-amber" : "text-muted-foreground",
                    )}
                  >
                    {item.stat}
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* Desktop: the sticky rail. */}
      <nav
        aria-label="Sections"
        className="bg-apollo-rail border-apollo-rail-border hidden flex-col gap-px rounded-[13px] border p-2.5 md:flex"
        data-testid="unit-section-nav"
      >
        {items.map((item) => {
          const isActive = active === item.id;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={() => setActive(item.id)}
              aria-current={isActive ? "location" : undefined}
              data-testid={`section-nav-${item.id}`}
              className={cn(
                "flex items-center justify-between gap-2 rounded-[7px] px-2.5 py-2 transition-colors hover:bg-white",
                isActive && "bg-white shadow-[inset_2px_0_0_var(--apollo-maroon)]",
              )}
            >
              <span className={cn("text-sm", isActive && "font-semibold")}>{item.label}</span>
              {item.stat && (
                <span
                  className={cn(
                    "text-xs whitespace-nowrap",
                    item.warn ? "text-apollo-amber" : "text-muted-foreground",
                  )}
                >
                  {item.stat}
                </span>
              )}
            </a>
          );
        })}
      </nav>
    </>
  );
}
