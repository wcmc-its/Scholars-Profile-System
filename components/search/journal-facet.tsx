"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Search } from "lucide-react";
import type { SearchFacetBucket } from "@/lib/api/search";

const TOP_VISIBLE = 8;

/**
 * Journal facet with a small search-within input. The full bucket list (up
 * to 50 from the OpenSearch agg) is filtered client-side by substring; the
 * "Show all N" toggle expands past the top visible window. Active values
 * are pulled to the head so they survive the cutoff.
 *
 * The toggle href hits the existing /search?journal=… repeated-param URL
 * shape — clicking a row navigates the full page; the search-within input
 * is a pure client filter with no URL footprint.
 */
export function JournalFacet({
  journals,
  activeJournals,
  toggleHref,
}: {
  journals: SearchFacetBucket[];
  activeJournals: string[];
  toggleHref: (axis: string, value: string) => string;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => {
    const active: SearchFacetBucket[] = [];
    const rest: SearchFacetBucket[] = [];
    for (const j of journals) {
      (activeJournals.includes(j.value) ? active : rest).push(j);
    }
    return [...active, ...rest];
  }, [journals, activeJournals]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((j) => j.value.toLowerCase().includes(q));
  }, [sorted, query]);

  const visible = showAll || query ? filtered : filtered.slice(0, TOP_VISIBLE);
  const hiddenCount = Math.max(0, filtered.length - visible.length);

  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[13px] font-semibold text-[#1a1a1a]">Journal</h3>
      <label className="mb-2 flex items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-2 py-1 text-[12.5px] focus-within:border-[#2c4f6e]">
        <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#757575]" strokeWidth={2} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search journals…"
          className="min-w-0 flex-1 bg-transparent text-[#1a1a1a] outline-none placeholder:text-[#9a9890]"
        />
      </label>
      <ul className="m-0 flex list-none flex-col p-0">
        {visible.map((j) => {
          const isActive = activeJournals.includes(j.value);
          return (
            <li key={j.value} className="flex items-center gap-2 py-1 leading-[1.4]">
              <Link
                href={toggleHref("journal", j.value)}
                title={j.value}
                className="flex flex-1 items-center gap-2 text-[#1a1a1a] no-underline hover:no-underline"
              >
                <input
                  type="checkbox"
                  readOnly
                  checked={isActive}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="cursor-pointer accent-[#2c4f6e]"
                />
                <span className="min-w-0 flex-1 truncate">{j.value}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-[#757575]">
                  {j.count.toLocaleString()}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && query ? (
        <div className="px-1 py-1 text-[12px] text-[#9a9890]">No journals match &ldquo;{query}&rdquo;</div>
      ) : null}
      {!query && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[12.5px] font-medium text-[#2c4f6e] hover:underline"
        >
          <ChevronDown aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
          Show all {filtered.length}
        </button>
      ) : null}
      {!query && showAll && filtered.length > TOP_VISIBLE ? (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[12.5px] font-medium text-[#2c4f6e] hover:underline"
        >
          <ChevronDown aria-hidden className="h-3.5 w-3.5 rotate-180" strokeWidth={2} />
          Show fewer
        </button>
      ) : null}
    </div>
  );
}
