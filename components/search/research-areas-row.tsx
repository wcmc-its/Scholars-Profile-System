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
 * Issue #860 — matched Method-taxonomy entities render as a parallel labeled
 * "Methods and Tools" chip row BELOW the "Research Areas" topic row (mirroring
 * the topic row's markup), replacing the former rust callout card. Each method
 * is a method-tinted chip whose hover card carries the eyebrow / description /
 * stats / "View the … page →" link.
 *
 * All data is on the TaxonomyMatchResult computed in page.tsx — no new fetch.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Sparkles, Users, ArrowUpRight, Wrench } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { TaxonomyMatch, TaxonomyMatchResult } from "@/lib/api/search-taxonomy";

/** Chips shown when layout can't be measured (SSR + jsdom). On a real client the
 *  count is measured to fill exactly one line (see {@link MeasuredChipRow}). */
const FALLBACK_VISIBLE = 4;
/** Tailwind `gap-2` between flex items, in px — used by the fit measurement. */
const GAP_PX = 8;
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8102E] focus-visible:ring-offset-1";

// useLayoutEffect on the client (measure before paint, no flash), useEffect on
// the server (React no-ops layout effects there — avoids the SSR warning).
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function ResearchAreasRow({ result }: { result: TaxonomyMatchResult }) {
  // RA-12 — nothing matched → render nothing (no label, no empty row, no card).
  if (result.state !== "matches") return null;
  const methodMatches = result.methodMatches ?? [];
  if (result.areas.length === 0 && methodMatches.length === 0) return null;

  const { areas, totalMatched, query } = result;

  return (
    <>
      {/* #709 — Research Areas chip row (Topic/Subtopic). Single line: as many
          chips as fit, the rest folded into "+N more" (expands inline). */}
      {areas.length > 0 ? (
        <MeasuredChipRow
          icon={<Sparkles aria-hidden className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />}
          label="Research Areas"
          items={areas}
          total={totalMatched}
          moreNoun="research area"
          renderChip={(m) => <AreaChip area={m} />}
          getKey={(m) => `${m.entityType}:${m.id}`}
          browseQuery={query}
        />
      ) : null}

      {/* #860 — Methods and Tools chip row. Mirrors the Research Areas row above
          (label → chips → "+N more"), with a method-tinted chip cue so the two
          rows read as a parallel pair. No "Browse" link on the methods row
          (methodMatches has no separate total, so "+N more" = the loaded set). */}
      {methodMatches.length > 0 ? (
        <MeasuredChipRow
          icon={<Wrench aria-hidden className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />}
          label="Methods and Tools"
          items={methodMatches}
          total={methodMatches.length}
          moreNoun="method"
          renderChip={(m) => <MethodChip match={m} />}
          getKey={(m) => `${m.entityType}:${m.id}`}
        />
      ) : null}
    </>
  );
}

/**
 * One labeled chip row (Research Areas or Methods and Tools) constrained to a
 * SINGLE line: it measures the available width and shows only as many chips as
 * fit, folding the rest into a "+N more" control that expands the row inline.
 *
 * Measurement runs in a `useLayoutEffect` (before paint, so there's no flash of
 * the full set) and re-runs on container resize. When layout is unavailable
 * (SSR / jsdom, `clientWidth === 0`) it falls back to {@link FALLBACK_VISIBLE}
 * chips so the server render and unit tests stay deterministic.
 */
function MeasuredChipRow({
  icon,
  label,
  items,
  total,
  moreNoun,
  renderChip,
  getKey,
  browseQuery,
}: {
  icon: ReactNode;
  label: string;
  items: TaxonomyMatch[];
  /** The TRUE total matched (drives "+N more"); ≥ `items.length` when the
   *  payload caps the loaded set (areas at ROW_AREA_CAP). */
  total: number;
  moreNoun: string;
  renderChip: (m: TaxonomyMatch) => ReactNode;
  getKey: (m: TaxonomyMatch) => string;
  /** Areas only: when expanded past the loaded set, link to Browse for the rest. */
  browseQuery?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  // While measuring, ALL chips render (so their widths can be read); the effect
  // then collapses to the count that fits. Starts true so the first client pass
  // measures; flips back to true on resize.
  const [measuring, setMeasuring] = useState(true);
  const [fit, setFit] = useState(Math.min(items.length, FALLBACK_VISIBLE));

  useIsoLayoutEffect(() => {
    if (expanded || !measuring) return;
    const row = rowRef.current;
    const avail = row?.clientWidth ?? 0;
    const chipEls = row ? Array.from(row.querySelectorAll<HTMLElement>("[data-mcr-chip]")) : [];
    // No layout (SSR / jsdom) → deterministic fallback, stable + unit-testable.
    if (!row || avail <= 0 || chipEls.length === 0) {
      setFit(Math.min(items.length, FALLBACK_VISIBLE));
      setMeasuring(false);
      return;
    }
    const labelW = row.querySelector<HTMLElement>("[data-mcr-label]")?.offsetWidth ?? 0;
    const moreW = (moreRef.current?.offsetWidth ?? 56) + GAP_PX;
    let used = labelW;
    let n = 0;
    for (let i = 0; i < chipEls.length; i++) {
      // Reserve room for "+N more" whenever a chip would remain hidden after this
      // one (conservative: guarantees the control is never pushed off the line).
      const reserve = i < chipEls.length - 1 ? moreW : 0;
      const next = used + GAP_PX + chipEls[i].offsetWidth;
      if (next + reserve > avail) break;
      used = next;
      n += 1;
    }
    setFit(Math.max(1, n)); // always show at least one chip
    setMeasuring(false);
  }, [expanded, measuring, items, total]);

  // Re-measure when the row's width changes (collapsed only).
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!expanded) setMeasuring(true);
    });
    ro.observe(row);
    return () => ro.disconnect();
  }, [expanded]);

  const shown = expanded || measuring ? items : items.slice(0, fit);
  const hiddenCount = total - shown.length;
  const beyond = total - items.length; // loaded cap (areas) < total

  return (
    <div
      ref={rowRef}
      className={`mt-4 flex items-center gap-2 ${
        expanded ? "flex-wrap" : "flex-nowrap overflow-hidden"
      }`}
    >
      <span
        data-mcr-label
        className="mr-0.5 inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-[#7a7e85]"
      >
        {icon}
        {label}
      </span>

      {shown.map((m) => (
        <span key={getKey(m)} data-mcr-chip className="shrink-0">
          {renderChip(m)}
        </span>
      ))}

      {/* Invisible width sizer so the measure reserves real space for the
          (widest-possible) "+N more" control before deciding the fit. */}
      {measuring ? (
        <span ref={moreRef} aria-hidden className="invisible shrink-0 px-1 text-[13px]">
          +{total} more
        </span>
      ) : null}

      {!expanded && !measuring && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Show ${hiddenCount} more ${moreNoun}${hiddenCount === 1 ? "" : "s"}`}
          className={`shrink-0 rounded px-1 text-[13px] text-[#1f51a8] hover:underline ${FOCUS_RING}`}
        >
          +{hiddenCount} more
        </button>
      ) : null}

      {expanded && browseQuery && beyond > 0 ? (
        <Link
          href={`/search?q=${encodeURIComponent(browseQuery)}`}
          className={`shrink-0 rounded px-1 text-[13px] text-[#1f51a8] no-underline hover:underline ${FOCUS_RING}`}
        >
          +{beyond} more in Browse →
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

/**
 * #860 — a method chip. Same pill geometry as AreaChip, with a method cue:
 * the #824 soft-method tint at rest (bg #fbf4ea, border #ecdcc8), a small
 * leading Wrench glyph, and a hover that tints toward rust. The hover card
 * (MethodPreview) carries the eyebrow / description / stats / page link.
 */
function MethodChip({ match }: { match: TaxonomyMatch }) {
  return (
    <HoverCard openDelay={300} closeDelay={120}>
      <HoverCardTrigger asChild>
        <Link
          href={match.href}
          className={`group inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-[#ecdcc8] bg-[#fbf4ea] px-[11px] py-[5px] text-[13px] leading-none text-[#2b2f36] no-underline transition-colors hover:border-[#b5701f] hover:bg-[#f6ead8] hover:text-[#7a3f15] ${FOCUS_RING}`}
        >
          <Wrench
            aria-hidden
            className="h-3 w-3 shrink-0 text-[#8a5a1e] group-hover:text-[#7a3f15]"
            strokeWidth={2}
          />
          {match.name}
          <span className="inline-flex items-center gap-[3px] text-[#7a7e85] group-hover:text-[#7a3f15]">
            <Users aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2} />
            {match.scholarCount.toLocaleString()}
          </span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <MethodPreview match={match} />
      </HoverCardContent>
    </HoverCard>
  );
}

export function MethodPreview({ match }: { match: TaxonomyMatch }) {
  const eyebrow = match.entityType === "methodFamily" ? "Method family" : "Research methods";
  return (
    <div className="text-[13px] leading-snug">
      <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {eyebrow}
      </div>
      <div className="mt-0.5 font-semibold text-foreground">{match.name}</div>
      {match.description ? (
        <p className="mt-1 line-clamp-4 text-[12.5px] text-muted-foreground">{match.description}</p>
      ) : null}
      <div className="mt-2 text-[12px] text-muted-foreground">
        {match.scholarCount.toLocaleString()}{" "}
        {match.scholarCount === 1 ? "scholar" : "scholars"}
        {match.publicationCount > 0 ? (
          <>
            {" · "}
            {match.publicationCount.toLocaleString()}{" "}
            {match.publicationCount === 1 ? "publication" : "publications"}
          </>
        ) : null}
      </div>
      <Link
        href={match.href}
        className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-[#1f51a8] no-underline hover:underline"
      >
        View the {match.name} page
        <ArrowUpRight aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
      </Link>
    </div>
  );
}
