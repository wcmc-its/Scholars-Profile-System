"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

const TOP_VISIBLE = 10;
const EXPANDED_VISIBLE = 50;

/**
 * Issue #88 — Author facet on the Publications-tab left rail.
 *
 * Buckets arrive pre-hydrated from the server (display name, slug, avatar
 * endpoint) so the client only handles UI: typeahead, sort toggle, pinned
 * selections, "Show all" expansion. URLs are precomputed server-side
 * (Next.js can't pass functions Server → Client) — we toggle by navigating
 * to the resolved href.
 */
export type AuthorFacetItem = {
  cwid: string;
  displayName: string;
  slug: string;
  identityImageEndpoint: string;
  count: number;
  isActive: boolean;
  toggleHref: string;
};

type SortMode = "count" | "name";

export function AuthorFacet({
  items,
  totalDistinct,
}: {
  items: AuthorFacetItem[];
  totalDistinct: number;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<SortMode>("count");

  const selected = useMemo(() => items.filter((a) => a.isActive), [items]);
  const unselected = useMemo(() => items.filter((a) => !a.isActive), [items]);

  // Match against the full display name (case-insensitive substring) AND
  // last-name word-prefix so `wol` finds `Myles Wolf` without requiring
  // the user to type the full token. Operates on the unselected list —
  // selected items are pinned regardless of whether they match the query.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let pool = unselected;
    if (q) {
      pool = pool.filter((a) => {
        const name = a.displayName.toLowerCase();
        if (name.includes(q)) return true;
        // Word-prefix match against any token (covers last-name lookups).
        return name.split(/\s+/).some((tok) => tok.startsWith(q));
      });
    }
    if (sort === "name") {
      pool = [...pool].sort((a, b) =>
        lastNameKey(a.displayName).localeCompare(lastNameKey(b.displayName)),
      );
    }
    // sort === "count": items already arrive count-desc from the server.
    return pool;
  }, [unselected, query, sort]);

  const hasQuery = query.trim().length > 0;
  // Show-all unconditionally expands; with a query, the search itself
  // narrows so we hide the Show-all toggle (per spec §"Search/typeahead").
  const visibleCap = hasQuery
    ? EXPANDED_VISIBLE
    : showAll
      ? EXPANDED_VISIBLE
      : TOP_VISIBLE;
  const visible = filtered.slice(0, visibleCap);
  const hiddenCount = Math.max(0, filtered.length - visible.length);

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold text-[#1a1a1a]">
          Author{" "}
          <span className="ml-1 text-[12px] font-normal tabular-nums text-[#757575]">
            {totalDistinct.toLocaleString()}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => setSort(sort === "count" ? "name" : "count")}
          className="text-[11.5px] font-medium text-[#2c4f6e] hover:underline"
          aria-label={`Sort authors by ${sort === "count" ? "name" : "publication count"}`}
        >
          {sort === "count" ? "A–Z" : "Most pubs"}
        </button>
      </div>

      <label className="mb-2 flex items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-2 py-1 text-[12.5px] focus-within:border-[#2c4f6e]">
        <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#757575]" strokeWidth={2} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search authors…"
          aria-label="Search authors"
          className="min-w-0 flex-1 bg-transparent text-[#1a1a1a] outline-none placeholder:text-[#9a9890]"
        />
      </label>

      {selected.length > 0 ? (
        <>
          <ul className="m-0 flex list-none flex-col p-0">
            {selected.map((a) => (
              <AuthorRow key={a.cwid} author={a} />
            ))}
          </ul>
          <hr className="my-2 border-[#e3e2dd]" />
        </>
      ) : null}

      <ul className="m-0 flex list-none flex-col p-0">
        {visible.map((a) => (
          <AuthorRow key={a.cwid} author={a} />
        ))}
      </ul>

      {visible.length === 0 && hasQuery ? (
        <div className="px-1 py-1 text-[12px] text-[#9a9890]">
          No matching authors
        </div>
      ) : null}

      {!hasQuery && !showAll && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-[12.5px] font-medium text-[#2c4f6e] hover:underline"
        >
          Show all {totalDistinct.toLocaleString()}
        </button>
      ) : null}
    </div>
  );
}

// Derive a last-name sort key from a display name. Drops trailing
// postnominal segments (", MD", ", PhD, MPH") then takes the final
// whitespace-separated token. Handles "Maria T. Diaz-Meco" → "diaz-meco"
// and "Curtis Cole, MD" → "cole". Compound surnames like "van der Berg"
// sort by their final token ("berg"), which matches how those are
// commonly indexed in faculty directories.
function lastNameKey(displayName: string): string {
  const noPostnom = displayName.split(/,\s*/)[0] ?? displayName;
  const tokens = noPostnom.trim().split(/\s+/);
  return (tokens[tokens.length - 1] ?? "").toLowerCase();
}

function AuthorRow({ author }: { author: AuthorFacetItem }) {
  return (
    <li className="py-1 leading-[1.4]">
      <Link
        href={author.toggleHref}
        className="flex items-center gap-2 text-[#1a1a1a] no-underline hover:no-underline"
      >
        <input
          type="checkbox"
          readOnly
          checked={author.isActive}
          tabIndex={-1}
          aria-hidden="true"
          className="cursor-pointer accent-[#2c4f6e]"
        />
        <HeadshotAvatar
          size="sm"
          cwid={author.cwid}
          preferredName={author.displayName}
          identityImageEndpoint={author.identityImageEndpoint}
        />
        <span className="min-w-0 flex-1 truncate" title={author.displayName}>
          {author.displayName}
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-[#757575]">
          {author.count.toLocaleString()}
        </span>
      </Link>
    </li>
  );
}
