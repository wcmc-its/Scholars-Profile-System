"use client";

/**
 * Issue #709 — "Research Areas" chip row in the search results header. Replaces
 * the top-right "Research area at WCM" spotlight card: the matched curated
 * research areas render as a horizontal row of chips (name + scholar count)
 * below the count line and above the result-type tabs.
 *
 *   - RA-4/RA-5: each area is a chip; row caps at the top 4 with a "+N more"
 *     control (N = total matched − 4) that expands the rest inline (RA-19, up to
 *     ROW_AREA_CAP=12), routing to Browse beyond what shipped in the payload.
 *   - RA-6/RA-15: chips are real anchor links to /topics/{slug}, focusable.
 *   - RA-7..RA-11/RA-16: hover/focus opens a HoverCard preview (eyebrow, name,
 *     description (clamped to 4 lines), publications · subtopics, "View research area →").
 *     Radix HoverCard supplies the hover-intent delay, focus/blur mirroring,
 *     Esc dismiss, and no focus-trap; it's hover-based so touch just navigates
 *     (RA-13). Everything in it is reachable by clicking through (RA-10).
 *   - RA-12: renders nothing when no area matched.
 *   - RA-14: chips wrap; the row never overflows horizontally.
 *
 * All data is on the TaxonomyMatchResult computed in page.tsx — no new fetch.
 */
import { useState } from "react";
import Link from "next/link";
import { Sparkles, Users, ArrowUpRight, Wrench, BookText } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { EntityBadge } from "@/components/ui/entity-badge";
import type { TaxonomyMatch, TaxonomyMatchResult } from "@/lib/api/search-taxonomy";

const VISIBLE = 4;
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8102E] focus-visible:ring-offset-1";

export function ResearchAreasRow({ result }: { result: TaxonomyMatchResult }) {
  const [expanded, setExpanded] = useState(false);
  // RA-12 — nothing matched → render nothing (no label, no empty row, no card).
  if (result.state !== "matches") return null;
  const methodMatches = result.methodMatches ?? [];
  if (result.areas.length === 0 && methodMatches.length === 0) return null;

  const { areas, totalMatched, query } = result;
  const shown = expanded ? areas : areas.slice(0, VISIBLE);
  const moreCount = totalMatched - VISIBLE; // RA-5
  const beyondRow = totalMatched - areas.length; // areas capped at ROW_AREA_CAP

  return (
    <>
      {/* #824 PR-2 — Method-taxonomy callout(s): a method-tinted card per matched
          family / supercategory, above the Topic chip row. Mirrors the topic
          taxonomy callout's shape (eyebrow → name + Method badge → descriptor →
          scholar/pub stats → "View the … page →" link), tinted toward the rust
          Method hue. Only the top match renders by default; siblings disclose. */}
      {methodMatches.length > 0 ? <MethodCallouts matches={methodMatches} /> : null}

      {/* #709 — Research Areas chip row (Topic/Subtopic). Unchanged. */}
      {areas.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="mr-0.5 inline-flex items-center gap-1.5 text-[12.5px] text-[#7a7e85]">
            <Sparkles aria-hidden className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />
            Research Areas
          </span>

          {shown.map((area) => (
            <AreaChip key={`${area.entityType}:${area.id}`} area={area} />
          ))}

          {!expanded && moreCount > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label={`Show ${moreCount} more research area${moreCount === 1 ? "" : "s"}`}
              className={`rounded px-1 text-[13px] text-[#1f51a8] hover:underline ${FOCUS_RING}`}
            >
              +{moreCount} more
            </button>
          ) : null}

          {expanded && beyondRow > 0 ? (
            <Link
              href={`/search?q=${encodeURIComponent(query)}`}
              className={`rounded px-1 text-[13px] text-[#1f51a8] no-underline hover:underline ${FOCUS_RING}`}
            >
              +{beyondRow} more in Browse →
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * #824 PR-2 — the method-tinted taxonomy callout. Renders the top matched method
 * (family or supercategory) as a card; any sibling matches disclose behind a quiet
 * "+N related method{s}" toggle so the header never stacks many cards.
 */
function MethodCallouts({ matches }: { matches: TaxonomyMatch[] }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = matches;
  if (!first) return null;
  const shown = open ? matches : [first];

  return (
    <div className="mt-4 flex flex-col gap-2">
      {shown.map((m) => (
        <MethodCallout key={`${m.entityType}:${m.id}`} match={m} />
      ))}
      {rest.length > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`self-start rounded px-1 text-[13px] text-[#1f51a8] hover:underline ${FOCUS_RING}`}
        >
          {open
            ? "Show fewer methods"
            : `+${rest.length} related method${rest.length === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </div>
  );
}

function MethodCallout({ match }: { match: TaxonomyMatch }) {
  const isSupercategory = match.entityType === "supercategory";
  const eyebrow = isSupercategory ? "Research methods" : "Method & tool family";
  return (
    <div
      role="region"
      aria-label={isSupercategory ? "Matched research methods" : "Matched method family"}
      className="flex items-start gap-3.5 rounded-[10px] border-[0.5px] border-[#ecdcc8] bg-[#fbf4ea] px-4 py-3.5"
    >
      <span
        aria-hidden
        className="mt-px flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-[#f3e3cf] text-[#8a5a1e]"
      >
        <Wrench className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <span className="mb-[3px] inline-flex items-center gap-1.5 text-[12.5px] text-[#8a7a63]">
          <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          {eyebrow}
        </span>

        <div className="flex flex-wrap items-center gap-x-[9px] gap-y-1">
          <span className="text-[17px] font-bold tracking-[-0.005em] text-[#2b2f36]">
            {match.name}
          </span>
          <EntityBadge kind="method" />
        </div>

        {match.description ? (
          <p className="mt-[5px] max-w-[640px] text-[13px] leading-[1.5] text-[#5e636b]">
            {match.description}
          </p>
        ) : null}

        <div className="mt-[9px] flex items-center gap-[7px] text-[12.5px] text-[#6f7077]">
          <span className="inline-flex items-center gap-[5px]">
            <Users aria-hidden className="h-[13px] w-[13px] shrink-0" strokeWidth={2} />
            <strong className="font-semibold text-[#2b2f36]">
              {match.scholarCount.toLocaleString()}
            </strong>
            {match.scholarCount === 1 ? "scholar" : "scholars"}
          </span>
          {match.publicationCount > 0 ? (
            <>
              <span className="text-[#c7bca8]">·</span>
              <span className="inline-flex items-center gap-[5px]">
                <BookText aria-hidden className="h-[13px] w-[13px] shrink-0" strokeWidth={2} />
                <strong className="font-semibold text-[#2b2f36]">
                  {match.publicationCount.toLocaleString()}
                </strong>
                {match.publicationCount === 1 ? "publication" : "publications"}
              </span>
            </>
          ) : null}
        </div>

        <div className="mt-[11px]">
          <Link
            href={match.href}
            className="inline-flex items-center gap-[5px] text-[13px] font-semibold text-[#1f51a8] no-underline hover:underline"
          >
            View the {match.name} page
            <ArrowUpRight aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
          </Link>
        </div>
      </div>
    </div>
  );
}

function AreaChip({ area }: { area: TaxonomyMatch }) {
  return (
    <HoverCard openDelay={300} closeDelay={120}>
      <HoverCardTrigger asChild>
        <Link
          href={area.href}
          className={`group inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-[#E2E0D8] bg-[#F2F1EC] px-[11px] py-[5px] text-[13px] leading-none text-[#2b2f36] no-underline transition-colors hover:border-[#C8102E] hover:bg-[#fdeaec] hover:text-[#8f1320] ${FOCUS_RING}`}
        >
          {area.name}
          <span className="inline-flex items-center gap-[3px] text-[#7a7e85] group-hover:text-[#a33]">
            <Users aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2} />
            {area.scholarCount.toLocaleString()}
          </span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <AreaPreview area={area} />
      </HoverCardContent>
    </HoverCard>
  );
}

function AreaPreview({ area }: { area: TaxonomyMatch }) {
  return (
    <div className="text-[13px] leading-snug">
      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        Research area
      </div>
      <div className="mt-0.5 font-semibold text-foreground">{area.name}</div>
      {area.description ? (
        <p className="mt-1 line-clamp-4 text-[12.5px] text-muted-foreground">{area.description}</p>
      ) : null}
      {/* RA-11 — publications · subtopics; scholar count is on the chip. */}
      <div className="mt-2 text-[12px] text-muted-foreground">
        {area.publicationCount.toLocaleString()}{" "}
        {area.publicationCount === 1 ? "publication" : "publications"}
        {area.subtopicCount > 0 ? (
          <>
            {" · "}
            {area.subtopicCount.toLocaleString()}{" "}
            {area.subtopicCount === 1 ? "subtopic" : "subtopics"}
          </>
        ) : null}
      </div>
      <Link
        href={area.href}
        className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-[#1f51a8] no-underline hover:underline"
      >
        View research area
        <ArrowUpRight aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
      </Link>
    </div>
  );
}
