"use client";

/**
 * /browse anchor strip — in-page section anchors + one cross-link.
 *
 * Sticky pill track (Departments & Centers v2 mock) with a scroll-spy: the
 * active tab is the last `[data-spy]` section whose top has scrolled above
 * SPY_THRESHOLD_PX, defaulting to Departments. The active tab carries
 * aria-current="true". The strip sticks just below the sticky 60px site
 * header (top: 68px), so sections carry a matching scroll-margin-top.
 *
 * The A–Z anchor used to live here; surname-finding now lives on /search's
 * empty People tab per docs/browse-vs-search.md. "Research areas →" targets
 * /#browse-all-research-areas because no /topics index page exists yet.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

/** A section counts as "in view" once its top is within this many px of the
 *  viewport top (header 60px + strip ~48px + breathing room). */
export const SPY_THRESHOLD_PX = 160;

type SpyId = "departments" | "centers" | "cores";

export function BrowseAnchorStrip({
  showCores = true,
}: {
  /** Core facilities tab renders only when the Cores section does. */
  showCores?: boolean;
}) {
  const [active, setActive] = useState<SpyId>("departments");

  useEffect(() => {
    function onScroll() {
      let cur: SpyId = "departments";
      for (const el of document.querySelectorAll<HTMLElement>("[data-spy]")) {
        if (el.getBoundingClientRect().top < SPY_THRESHOLD_PX) {
          cur = el.dataset.spy as SpyId;
        }
      }
      setActive(cur);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const items: Array<{ id: SpyId; label: string }> = [
    { id: "departments", label: "Departments" },
    { id: "centers", label: "Centers & Institutes" },
    ...(showCores ? [{ id: "cores" as const, label: "Core Facilities" }] : []),
  ];

  return (
    <>
      <div className="sticky top-[68px] z-10 mt-8">
        <nav
          aria-label="Browse sections"
          className="flex items-center gap-1 overflow-x-auto rounded-xl bg-apollo-surface-2 p-1.5"
        >
          {items.map((n) => {
            const isActive = active === n.id;
            return (
              <a
                key={n.id}
                href={`#${n.id}`}
                aria-current={isActive ? "true" : undefined}
                className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-[14px] text-foreground transition-[background-color,box-shadow] duration-[120ms] ease-out hover:no-underline ${
                  isActive
                    ? "bg-apollo-surface font-medium shadow-[var(--apollo-shadow-card)]"
                    : "hover:bg-apollo-rail"
                }`}
              >
                {n.label}
              </a>
            );
          })}
        </nav>
      </div>
      <div className="mt-3.5 text-right">
        <Link
          href="/#browse-all-research-areas"
          className="text-[14px] text-apollo-slate hover:underline"
        >
          Or browse by research area &#x2192;
        </Link>
      </div>
    </>
  );
}
