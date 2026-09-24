/**
 * Home-page Browse all research areas grid: a card of 3 column-major (A–Z
 * top-to-bottom per column) lists of parent topics with publication counts,
 * plus a type-to-filter box (home refinements mockup, 2026-09-24). A client
 * component for the filter; the ~67 rows are already on the page.
 * Per D-12 this surface NEVER hides; an empty `items` array renders the
 * "Research areas temporarily unavailable" error state.
 */
"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { SectionHeading } from "@/components/home/section-heading";
import type { ParentTopic } from "@/lib/api/home";

const COLUMNS = 3;

export function BrowseAllResearchAreasGrid({ items }: { items: ParentTopic[] }) {
  const [filter, setFilter] = useState("");

  if (items.length === 0) {
    return (
      <section className="mt-18">
        <SectionHeading>Browse all research areas</SectionHeading>
        <p className="text-muted-foreground mt-2 text-sm">
          Research areas temporarily unavailable.{" "}
          <Link href="/" className="text-[var(--color-accent-slate)] underline-offset-4 hover:underline">
            Retry
          </Link>
        </p>
      </section>
    );
  }

  const q = filter.trim().toLowerCase();
  const shown = q ? items.filter((t) => t.name.toLowerCase().includes(q)) : items;
  // Column-major split: items already arrive A–Z, so each column is a
  // contiguous alphabetical slice.
  const colSize = Math.max(1, Math.ceil(shown.length / COLUMNS));
  const columns = Array.from({ length: COLUMNS }, (_, i) => shown.slice(i * colSize, (i + 1) * colSize)).filter(
    (c) => c.length > 0,
  );

  return (
    <section className="mt-18 flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SectionHeading>Browse all research areas</SectionHeading>
          <p className="text-muted-foreground mt-1 text-[14px]">
            All {items.length} research areas at WCM, with publication counts.
          </p>
        </div>
        <div className="relative w-full sm:w-70">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter research areas"
            aria-label="Filter research areas"
            className="border-apollo-border-strong bg-apollo-surface h-9 w-full rounded-md border pr-3 pl-8 text-sm outline-none focus-visible:border-[var(--color-accent-slate)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)]/20"
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="border-apollo-border bg-apollo-surface text-muted-foreground rounded-[var(--apollo-radius-card)] border p-6 text-sm">
          No research areas match &ldquo;{filter.trim()}&rdquo;.
        </p>
      ) : (
        <div className="border-apollo-border bg-apollo-surface grid grid-cols-1 items-start gap-x-10 rounded-[var(--apollo-radius-card)] border px-6 pt-5 pb-3 shadow-[var(--apollo-shadow-card)] sm:grid-cols-2 lg:grid-cols-3">
          {columns.map((col, ci) => (
            <div key={ci}>
              {/* Header repeats per column only where columns sit side by side. */}
              <div
                className={`border-apollo-border-strong text-muted-foreground justify-between border-b px-2 pb-2 text-xs ${ci === 0 ? "flex" : "hidden sm:flex"} ${ci === 2 ? "sm:hidden lg:flex" : ""}`}
              >
                <span>Research area</span>
                <span>Publications</span>
              </div>
              <ul className="divide-apollo-border divide-y">
                {col.map((t) => (
                  <li key={t.slug}>
                    <a
                      href={`/topics/${t.slug}`}
                      className="text-foreground hover:bg-apollo-surface-2 hover:text-apollo-slate focus-visible:bg-apollo-surface-2 focus-visible:text-apollo-slate flex items-baseline justify-between gap-4 px-2 py-2.5 text-[15px] transition-colors duration-[120ms] ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--apollo-ring)]"
                    >
                      <span>{t.name}</span>
                      <span className="text-muted-foreground shrink-0 text-[13px] tabular-nums">
                        {t.publicationCount.toLocaleString()}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
