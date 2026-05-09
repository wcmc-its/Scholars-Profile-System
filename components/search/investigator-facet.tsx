"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { HeadshotAvatar } from "@/components/scholar/headshot-avatar";

const TOP_VISIBLE = 10;
const EXPANDED_VISIBLE = 50;

/**
 * Issue #94 — Investigator facet on the Funding-tab left rail. Mirrors
 * the Author facet on the Publications tab: pre-hydrated buckets, client
 * handles UI (typeahead, sort toggle, pinned selections, "Show all"),
 * URLs precomputed server-side.
 */
export type InvestigatorFacetItem = {
  cwid: string;
  displayName: string;
  slug: string;
  identityImageEndpoint: string;
  count: number;
  isActive: boolean;
  toggleHref: string;
};

type SortMode = "count" | "name";

export function InvestigatorFacet({
  items,
  totalDistinct,
}: {
  items: InvestigatorFacetItem[];
  totalDistinct: number;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<SortMode>("count");

  const selected = useMemo(() => items.filter((a) => a.isActive), [items]);
  const unselected = useMemo(() => items.filter((a) => !a.isActive), [items]);

  // Substring + last-name word-prefix match on the unselected list;
  // selected items are pinned regardless of query.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let pool = unselected;
    if (q) {
      pool = pool.filter((a) => {
        const name = a.displayName.toLowerCase();
        if (name.includes(q)) return true;
        return name.split(/\s+/).some((tok) => tok.startsWith(q));
      });
    }
    if (sort === "name") {
      pool = [...pool].sort((a, b) =>
        lastNameKey(a.displayName).localeCompare(lastNameKey(b.displayName)),
      );
    }
    return pool;
  }, [unselected, query, sort]);

  const hasQuery = query.trim().length > 0;
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
          Investigator{" "}
          <span className="ml-1 text-[12px] font-normal tabular-nums text-[#757575]">
            {totalDistinct.toLocaleString()}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => setSort(sort === "count" ? "name" : "count")}
          className="text-[11.5px] font-medium text-[#2c4f6e] hover:underline"
          aria-label={`Sort investigators by ${sort === "count" ? "name" : "grant count"}`}
        >
          {sort === "count" ? "A–Z" : "Most grants"}
        </button>
      </div>

      <label className="mb-2 flex items-center gap-1.5 rounded-sm border border-[#c8c6be] bg-white px-2 py-1 text-[12.5px] focus-within:border-[#2c4f6e]">
        <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#757575]" strokeWidth={2} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search investigators…"
          aria-label="Search investigators"
          className="min-w-0 flex-1 bg-transparent text-[#1a1a1a] outline-none placeholder:text-[#9a9890]"
        />
      </label>

      {selected.length > 0 ? (
        <>
          <ul className="m-0 flex list-none flex-col p-0">
            {selected.map((a) => (
              <InvestigatorRow key={a.cwid} investigator={a} />
            ))}
          </ul>
          <hr className="my-2 border-[#e3e2dd]" />
        </>
      ) : null}

      <ul className="m-0 flex list-none flex-col p-0">
        {visible.map((a) => (
          <InvestigatorRow key={a.cwid} investigator={a} />
        ))}
      </ul>

      {visible.length === 0 && hasQuery ? (
        <div className="px-1 py-1 text-[12px] text-[#9a9890]">
          No matching investigators
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

// Last-name sort key: drops postnominal segments, takes the final
// whitespace-separated token. Mirrors the Author facet helper.
function lastNameKey(displayName: string): string {
  const noPostnom = displayName.split(/,\s*/)[0] ?? displayName;
  const tokens = noPostnom.trim().split(/\s+/);
  return (tokens[tokens.length - 1] ?? "").toLowerCase();
}

function InvestigatorRow({ investigator }: { investigator: InvestigatorFacetItem }) {
  return (
    <li className="py-1 leading-[1.4]">
      <Link
        href={investigator.toggleHref}
        className="flex items-center gap-2 text-[#1a1a1a] no-underline hover:no-underline"
      >
        <input
          type="checkbox"
          readOnly
          checked={investigator.isActive}
          tabIndex={-1}
          aria-hidden="true"
          className="cursor-pointer accent-[#2c4f6e]"
        />
        <HeadshotAvatar
          size="sm"
          cwid={investigator.cwid}
          preferredName={investigator.displayName}
          identityImageEndpoint={investigator.identityImageEndpoint}
        />
        <span className="min-w-0 flex-1 truncate" title={investigator.displayName}>
          {investigator.displayName}
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-[#757575]">
          {investigator.count.toLocaleString()}
        </span>
      </Link>
    </li>
  );
}
