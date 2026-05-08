"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Search } from "lucide-react";

const TOP_VISIBLE = 8;

/**
 * Journal facet with a small search-within input. Buckets come in
 * pre-sorted (active values first) with their toggleHref already computed
 * server-side — Next.js can't pass a function from a Server to a Client
 * component, so the parent precomputes per-bucket hrefs and we filter +
 * paginate them in the browser.
 */
export type JournalFacetItem = {
  value: string;
  count: number;
  isActive: boolean;
  toggleHref: string;
};

export function JournalFacet({ items }: { items: JournalFacetItem[] }) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((j) => j.value.toLowerCase().includes(q));
  }, [items, query]);

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
        {visible.map((j) => (
          <li key={j.value} className="py-1 leading-[1.4]">
            <Link
              href={j.toggleHref}
              className="flex items-start gap-2 text-[#1a1a1a] no-underline hover:no-underline"
            >
              {/* Top-align so input + count sit on the first line of a
                  wrapping label rather than floating to the vertical
                  center; the offset matches the input's vertical inset. */}
              <input
                type="checkbox"
                readOnly
                checked={j.isActive}
                tabIndex={-1}
                aria-hidden="true"
                className="mt-[3px] cursor-pointer accent-[#2c4f6e]"
              />
              <span className="min-w-0 flex-1 break-words">{j.value}</span>
              <span className="mt-[1px] shrink-0 text-[12px] tabular-nums text-[#757575]">
                {j.count.toLocaleString()}
              </span>
            </Link>
          </li>
        ))}
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
