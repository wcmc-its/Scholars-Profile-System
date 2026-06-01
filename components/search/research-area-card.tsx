"use client";

/**
 * Issue #638 — Research-area card (replaces the full-width TaxonomyCallout
 * banner). A compact card pinned to the top-right of the results header, on
 * the same row as the results title.
 *
 * Layout / interaction:
 *   - The whole card is the primary click target → the matched topic page.
 *     A single stretched <Link> (absolute inset-0) covers the card; the
 *     visible content sits above it with `pointer-events-none` so clicks
 *     anywhere navigate. HTML forbids a <button> inside an <a>, so the only
 *     interactive child — the "N more areas" popover trigger — opts back into
 *     pointer events (`pointer-events-auto z-10`) and sits above the link.
 *   - "N more areas" opens an anchored popover (does NOT navigate); each row
 *     links to its own topic page. Radix Popover supplies aria-expanded,
 *     Esc + outside-click dismiss, and focus-return for free.
 *
 * Renders nothing when no research area matched (`result.state !== "matches"`).
 * All data (name, href, counts, secondary list, overflow) is already on the
 * TaxonomyMatchResult computed in page.tsx — no new fetch.
 */
import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { TaxonomyMatchResult, TaxonomyMatch } from "@/lib/api/search-taxonomy";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-slate)] focus-visible:ring-offset-1";

export function ResearchAreaCard({ result }: { result: TaxonomyMatchResult }) {
  if (result.state !== "matches") return null;
  const { primary, secondary, overflowCount, query } = result;
  // "N more areas" counts every additional matched area: the (capped)
  // secondary rows plus any that didn't fit the resolver's cap.
  const moreCount = secondary.length + overflowCount;

  return (
    <div className="group relative w-full shrink-0 rounded-md border border-border bg-card p-3 transition-colors hover:border-[#c2d2df] hover:bg-[#eef4f9] sm:w-[260px]">
      {/* Stretched primary link — the whole card navigates to the topic page. */}
      <Link
        href={primary.href}
        aria-label={ariaLabelFor(primary)}
        className={`absolute inset-0 rounded-md ${FOCUS_RING}`}
      />
      <ArrowUpRight
        aria-hidden
        className="pointer-events-none absolute top-2.5 right-3 h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-[var(--color-accent-slate)]"
        strokeWidth={2}
      />
      <div className="pointer-events-none relative">
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Sparkles
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-slate)]"
            strokeWidth={2}
          />
          Research area at WCM
        </div>
        <div className="mt-1 pr-5 text-[13px] leading-tight font-medium text-[var(--color-accent-slate)]">
          {primary.name}
        </div>
        <div className="mt-1 text-[12px] text-muted-foreground">
          {formatCount(primary.scholarCount, "scholar")} ·{" "}
          {formatCount(primary.publicationCount, "pub")}
          {moreCount > 0 ? (
            <>
              {" · "}
              <MoreAreasPopover
                secondary={secondary}
                overflowCount={overflowCount}
                query={query}
                moreCount={moreCount}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MoreAreasPopover({
  secondary,
  overflowCount,
  query,
  moreCount,
}: {
  secondary: TaxonomyMatch[];
  overflowCount: number;
  query: string;
  moreCount: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Show ${moreCount} more research area${moreCount === 1 ? "" : "s"}`}
          className={`pointer-events-auto relative z-10 rounded text-[var(--color-accent-slate)] underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          {moreCount} more area{moreCount === 1 ? "" : "s"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold">
          More research areas
        </div>
        <ul className="max-h-80 overflow-y-auto p-1">
          {secondary.map((m) => (
            <li key={`${m.entityType}:${m.id}`}>
              <Link
                href={m.href}
                aria-label={ariaLabelFor(m)}
                className="block rounded px-2 py-1.5 text-xs no-underline transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <span className="font-medium text-foreground">{m.name}</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {formatCount(m.scholarCount, "scholar")} ·{" "}
                  {formatCount(m.publicationCount, "pub")}
                </span>
              </Link>
            </li>
          ))}
          {overflowCount > 0 ? (
            <li>
              <Link
                href={`/search?q=${encodeURIComponent(query)}`}
                className="block rounded px-2 py-1.5 text-xs italic text-muted-foreground no-underline transition-colors hover:bg-zinc-100 hover:text-[var(--color-accent-slate)] dark:hover:bg-zinc-800"
              >
                See all matches &rarr;
              </Link>
            </li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function formatCount(n: number, noun: string): string {
  const formatted = n.toLocaleString();
  return n === 1 ? `${formatted} ${noun}` : `${formatted} ${noun}s`;
}

function ariaLabelFor(match: TaxonomyMatch): string {
  if (match.entityType === "parentTopic") {
    return `View ${match.name}, a research area at WCM`;
  }
  return `View ${match.name}, a subtopic of ${match.parentTopicLabel ?? "a research area"} at WCM`;
}
