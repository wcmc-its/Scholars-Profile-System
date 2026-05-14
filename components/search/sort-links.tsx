"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

/**
 * Sort selector for the /search results header. Renders the active option
 * as a visible label and the rest as a dropdown of <Link>s.
 *
 * Issue #270 — uses controlled `open` state instead of a native <details>
 * because Next.js client-side navigation re-renders the page but does not
 * dispatch any event that closes a <details> element, so the menu stayed
 * expanded after a sort was selected. With controlled state we can call
 * `setOpen(false)` on the option's `onClick` so the dropdown collapses
 * synchronously with the soft nav. Pathname / searchParams aren't useful
 * triggers here — the link target is what changes the URL.
 *
 * Outside-click and Escape close the dropdown so it behaves like the
 * shadcn Select used elsewhere in the app.
 */
export function SortLinks({
  current,
  options,
}: {
  current: string;
  /**
   * Each option carries its own `href` precomputed by the server component.
   * We deliberately do NOT take a `buildSortHref` function prop here:
   * functions can't cross the server→client boundary in RSC without being
   * Server Actions, and the URL-building closure on the search page
   * captures the caller's `searchParams`, which isn't action-shaped.
   */
  options: Array<{ value: string; label: string; href: string }>;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeLabel =
    options.find((o) => o.value === current)?.label ?? options[0].label;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-2 py-1 text-[13px] text-[#1a1a1a] hover:border-[#2c4f6e]"
      >
        {activeLabel}
        <ChevronDown
          aria-hidden
          className="h-3.5 w-3.5 text-[#757575]"
          strokeWidth={2}
        />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 top-full z-20 mt-1 min-w-[180px] rounded-md border border-[#e3e2dd] bg-white py-1 shadow-md"
        >
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === current}>
              <Link
                href={o.href}
                onClick={() => setOpen(false)}
                className={`block px-3 py-1.5 text-[13px] hover:bg-[#fafaf8] ${
                  o.value === current
                    ? "font-semibold text-[#2c4f6e]"
                    : "text-[#1a1a1a]"
                }`}
              >
                {o.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
