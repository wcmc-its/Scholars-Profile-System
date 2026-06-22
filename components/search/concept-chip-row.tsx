"use client";

/**
 * SEARCH_PEOPLE_CONCEPT_HINT — the People-card "concepts" identity hint: the
 * scholar's top MeSH descriptors, rendered as a single-line, fit-to-width row of
 * outline chips behind a leading tag glyph (no label, no box). Each chip
 * deep-links to the scholar's publications pre-filtered to that concept
 * (`/{slug}?mesh=<ui>#publications`); a concept whose descriptor `ui` is null
 * renders as a plain (non-link) chip. Overflow folds into a borderless "+N more"
 * control that EXPANDS the row inline (wrap) rather than navigating — so it never
 * reads as just another topic.
 *
 * The chips + control sit ABOVE the card's stretched profile link (the row is
 * `relative z-10` and each control `stopPropagation`s), so clicking a chip
 * follows the chip's href and clicking "+N more" expands, neither triggering the
 * card's whole-card profile navigation (mirrors the rep-papers disclosure).
 *
 * Measurement mirrors `research-areas-row.tsx`'s MeasuredChipRow: a layout
 * effect measures the row width and shows only the chips that fit (always >= 1),
 * re-running on resize; on SSR/jsdom (clientWidth 0) it falls back to a fixed
 * count so server render + unit tests stay deterministic.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Tag, ChevronDown } from "lucide-react";
import { profilePath } from "@/lib/profile-url";

type ConceptItem = { label: string; ui: string | null };

/** Tailwind `gap-1.5` between row items, in px — used by the fit measurement. */
const GAP_PX = 6;
/** Chips shown when layout can't be measured (SSR + jsdom). */
const FALLBACK_VISIBLE = 4;
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8102E] focus-visible:ring-offset-1";

// useLayoutEffect on the client (measure before paint, no flash), useEffect on
// the server (React no-ops layout effects there — avoids the SSR warning).
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Outline chip — 13px (visibly smaller than the 16px scholar name), border +
// transparent fill, subtle neutral hover. The link/span wrapper decides whether
// it is interactive; the visual is identical so a null-ui chip reads the same.
const CHIP_CLASS =
  "inline-flex shrink-0 items-center rounded-md border border-[#e3e2dd] bg-transparent px-2.5 py-[3px] text-[13px] leading-[1.3] text-[#4a4a4a] no-underline transition-colors hover:border-[#c9c4ba] hover:bg-[#f7f6f3] hover:text-[#1a1a1a]";

function conceptHref(slug: string, ui: string): string {
  return `${profilePath(slug)}?mesh=${encodeURIComponent(ui)}#publications`;
}

export function ConceptChipRow({ items, slug }: { items: ConceptItem[]; slug: string }) {
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
    const chipEls = row ? Array.from(row.querySelectorAll<HTMLElement>("[data-ccr-chip]")) : [];
    // No layout (SSR / jsdom) → deterministic fallback, stable + unit-testable.
    if (!row || avail <= 0 || chipEls.length === 0) {
      setFit(Math.min(items.length, FALLBACK_VISIBLE));
      setMeasuring(false);
      return;
    }
    const iconW = row.querySelector<HTMLElement>("[data-ccr-icon]")?.offsetWidth ?? 0;
    const moreW = (moreRef.current?.offsetWidth ?? 56) + GAP_PX;
    let used = iconW;
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
  }, [expanded, measuring, items]);

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

  if (items.length === 0) return null;

  const shown = expanded || measuring ? items : items.slice(0, fit);
  const hiddenCount = items.length - shown.length;

  return (
    <div
      ref={rowRef}
      className={`relative z-10 mt-2 flex items-center gap-1.5 ${
        expanded ? "flex-wrap" : "flex-nowrap overflow-hidden"
      }`}
    >
      <span className="sr-only">Research topics:</span>
      <Tag
        data-ccr-icon
        aria-hidden
        className="size-[15px] shrink-0 text-[#9a958a]"
        strokeWidth={1.75}
      />

      {shown.map((item, i) =>
        item.ui ? (
          <Link
            key={`${item.label}-${i}`}
            data-ccr-chip
            href={conceptHref(slug, item.ui)}
            onClick={(e) => e.stopPropagation()}
            className={`${CHIP_CLASS} ${FOCUS_RING}`}
          >
            {item.label}
          </Link>
        ) : (
          <span key={`${item.label}-${i}`} data-ccr-chip className={CHIP_CLASS}>
            {item.label}
          </span>
        ),
      )}

      {/* Invisible width sizer so the measure reserves real space for the
          (widest-possible) "+N more" control before deciding the fit. */}
      {measuring ? (
        <span ref={moreRef} aria-hidden className="invisible shrink-0 px-1 text-[13px]">
          +{items.length} more
        </span>
      ) : null}

      {!expanded && !measuring && hiddenCount > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          aria-label={`Show ${hiddenCount} more topic${hiddenCount === 1 ? "" : "s"}`}
          className={`inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[13px] text-[#7a7e85] hover:text-[#4a4a4a] ${FOCUS_RING}`}
        >
          <ChevronDown aria-hidden className="size-3.5" strokeWidth={2} />+{hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}
