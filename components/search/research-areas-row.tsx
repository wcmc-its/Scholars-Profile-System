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
import { Sparkles, Users, ArrowUpRight } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { TaxonomyMatch, TaxonomyMatchResult } from "@/lib/api/search-taxonomy";

const VISIBLE = 4;
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8102E] focus-visible:ring-offset-1";

export function ResearchAreasRow({ result }: { result: TaxonomyMatchResult }) {
  const [expanded, setExpanded] = useState(false);
  // RA-12 — nothing matched → render nothing (no label, no empty row).
  if (result.state !== "matches" || result.areas.length === 0) return null;

  const { areas, totalMatched, query } = result;
  const shown = expanded ? areas : areas.slice(0, VISIBLE);
  const moreCount = totalMatched - VISIBLE; // RA-5
  const beyondRow = totalMatched - areas.length; // areas capped at ROW_AREA_CAP

  return (
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
