"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

/**
 * Funder facet with type-ahead (issue #80 items 6 + 7).
 *
 * Above the standard checkbox list, render a search input that filters by
 * canonical short, full name, or alias. When the input matches one or more
 * direct sponsors (subaward issuers), surface a "via [name]" row below the
 * primary list so a user typing "Duke" can filter to Duke-issued subawards
 * without a separate UI dimension.
 *
 * Each item carries its own toggle href (computed server-side) so the
 * facet stays a thin display component — selection state lives in the URL.
 */

export type FunderFacetItem = {
  value: string;
  /** Canonical short — used for type-ahead matching; falls back into the
   *  display label when no full name is available. */
  short: string;
  /** Full name from the canonical lookup. Drives both the verbose
   *  display and type-ahead matching; null when the sponsor isn't in
   *  the lookup. */
  full: string | null;
  /** Lowercased alias strings for type-ahead matching. */
  aliases: string[];
  count: number;
  isActive: boolean;
  href: string;
};

interface Props {
  items: FunderFacetItem[];
  /** Direct-sponsor entries for the "via" surface. Only rendered when the
   *  type-ahead query matches one of them. */
  directItems: FunderFacetItem[];
  collapseAfter?: number;
}

function matches(it: FunderFacetItem, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (it.short.toLowerCase().includes(needle)) return true;
  if (it.full && it.full.toLowerCase().includes(needle)) return true;
  for (const a of it.aliases) {
    if (a.includes(needle)) return true;
  }
  return false;
}

export function FunderFacet({ items, directItems, collapseAfter = 6 }: Props) {
  const [query, setQuery] = React.useState("");
  const trimmed = query.trim();

  // Active items always live at the head, even when filtered out by the
  // type-ahead. Otherwise toggling a facet would visually disappear it
  // when the user mistypes.
  const filtered = React.useMemo(() => {
    if (!trimmed) return items;
    return items.filter((it) => it.isActive || matches(it, trimmed));
  }, [items, trimmed]);

  const directMatches = React.useMemo(() => {
    if (!trimmed) {
      return directItems.filter((d) => d.isActive);
    }
    return directItems.filter((d) => d.isActive || matches(d, trimmed));
  }, [directItems, trimmed]);

  const showCollapse =
    !trimmed && filtered.length > collapseAfter;
  const head = showCollapse ? filtered.slice(0, collapseAfter) : filtered;
  const tail = showCollapse ? filtered.slice(collapseAfter) : [];

  return (
    <div className="mb-5">
      <h3 className="mb-2 text-[13px] font-semibold text-[#1a1a1a]">Funder</h3>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search funders…"
        aria-label="Search funders"
        className="border-border-strong mb-2 h-7 w-full rounded-sm border bg-white px-2 text-[12.5px] focus:border-[#2c4f6e] focus:outline-none"
      />
      {filtered.length === 0 && directMatches.length === 0 ? (
        <p className="text-[12px] text-[#757575]">No funders match.</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {head.map((it) => (
          <FunderRow key={`p-${it.value}`} item={it} />
        ))}
      </ul>
      {tail.length > 0 ? (
        <details className="mt-1 [&[open]_.fg-show]:hidden [&:not([open])_.fg-hide]:hidden [&[open]_.fg-chevron]:rotate-180">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12.5px] font-medium text-[#2c4f6e] hover:underline [&::-webkit-details-marker]:hidden">
            <ChevronDown
              aria-hidden
              className="fg-chevron h-3.5 w-3.5 transition-transform"
              strokeWidth={2}
            />
            <span className="fg-show">Show all {filtered.length}</span>
            <span className="fg-hide">Show fewer</span>
          </summary>
          <ul className="m-0 mt-1 flex list-none flex-col p-0">
            {tail.map((it) => (
              <FunderRow key={`p-${it.value}`} item={it} />
            ))}
          </ul>
        </details>
      ) : null}
      {directMatches.length > 0 ? (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 border-t border-[#e3e2dd] pt-2 p-0">
          {directMatches.map((it) => (
            <FunderRow key={`d-${it.value}`} item={it} via />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FunderRow({ item, via }: { item: FunderFacetItem; via?: boolean }) {
  // Verbose label — full canonical name when known, otherwise fall back
  // to the short. NIH ICs render their full institute name (no "NIH/"
  // prefix in verbose mode — the "National X Institute" form already
  // signals the parent agency).
  const display = item.full ?? item.short;
  return (
    <li className="py-1 leading-[1.4]">
      <Link
        href={item.href}
        className="flex w-full items-start gap-2 text-[#1a1a1a] no-underline hover:no-underline"
      >
        <input
          type="checkbox"
          readOnly
          checked={item.isActive}
          tabIndex={-1}
          aria-hidden="true"
          className="mt-[3px] cursor-pointer accent-[#2c4f6e]"
        />
        <span className="min-w-0 flex-1 break-words">
          {via ? <span className="text-[#757575]">via </span> : null}
          {display}
        </span>
        <span className="mt-[1px] shrink-0 text-[12px] tabular-nums text-[#757575]">
          {item.count.toLocaleString()}
        </span>
      </Link>
    </li>
  );
}
