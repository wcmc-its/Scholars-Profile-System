"use client";

/**
 * A unit hero "Top research areas" pill with its hover preview (Unit Page v2):
 * a 384px card with the area label, a "{N} publications by {unit} {faculty |
 * members} · most cited" blurb, the unit's 3 most-cited papers in the area
 * (title, venue, year, "{n} {unit} authors") and a "See all N →" link to the
 * unit's Publications tab filtered to the area. 250ms open / 120ms close.
 *
 * The pill stays a link to /topics/{slug}. Data comes pre-computed from the
 * server (`getUnitAreaPreviews`); this module imports only TYPES from lib/api
 * so no Prisma code reaches the client bundle.
 *
 * Radix HoverCard is mouse-only by design, so three things are wired by hand:
 *  - Touch (#2588): Radix preventDefaults the trigger's `touchstart`, which on
 *    iOS cancels the link. First tap opens the card; a second tap on the pill
 *    re-issues the click so the /topics link still navigates. A touch that
 *    moved (a scroll or swipe starting on a pill) or was cancelled does
 *    neither. Tapping outside or Esc closes it; every link in the card is an
 *    ordinary link.
 *  - Keyboard: focusing the pill opens the card (Radix). The content is NOT
 *    portaled, so it sits in the DOM right after the pill and Tab walks into
 *    its links. Radix marks every tabbable in a hover card `tabindex=-1`; we
 *    undo that while open. A keyboard-driven close is vetoed while focus is
 *    inside the card; focus leaving the card closes it; Esc closes it and, if
 *    focus was in the card, returns focus to the pill without reopening it.
 *  - Missing preview: renders the plain pill link, no card.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { PubJournal, pubTitleProps } from "@/components/publication/pub-html";
import { cn, sanitizePubTitle } from "@/lib/utils";
import type { UnitAreaPreview } from "@/lib/api/unit-area-previews";

export const AREA_PREVIEW_OPEN_DELAY = 250;
export const AREA_PREVIEW_CLOSE_DELAY = 120;
/** A touch that travels further than this (px) is a scroll, not a tap. */
export const AREA_PREVIEW_TAP_SLOP = 10;

/** The shipped 32px pill (label + muted tabular count). */
const DEFAULT_PILL_CLASS =
  "border-apollo-border-strong text-foreground hover:bg-apollo-surface-2 inline-flex min-h-8 max-w-full items-center gap-2 rounded-full border bg-white px-3 py-1 text-[13px] leading-tight no-underline transition-colors duration-[120ms] ease-out hover:no-underline";
const DEFAULT_COUNT_CLASS = "text-muted-foreground text-[12px] whitespace-nowrap tabular-nums";

export type AreaPreviewPillArea = {
  topicId: string;
  topicLabel: string;
  topicSlug: string;
  pubCount: number;
};

export function areaSeeAllHref(basePath: string, topicId: string, anchor = "people"): string {
  return `${basePath}/areas/${encodeURIComponent(topicId)}?sort=most_cited#${anchor}`;
}

export function AreaPreviewPill({
  area,
  preview,
  basePath,
  unitShort,
  membersNoun,
  anchor = "people",
  className = DEFAULT_PILL_CLASS,
  countClassName = DEFAULT_COUNT_CLASS,
}: {
  area: AreaPreviewPillArea;
  /** Absent → the plain pill link (graceful fallback). */
  preview?: UnitAreaPreview | null;
  /** The unit's page path, e.g. `/departments/medicine`. */
  basePath: string;
  /** Short unit name for "{n} {unitShort} authors", e.g. "Medicine". */
  unitShort: string;
  /** "faculty" (departments, divisions) or "members" (centers). */
  membersNoun: "faculty" | "members";
  /** In-page anchor the "See all" link lands on (the tab section). */
  anchor?: string;
  className?: string;
  countClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The content node as state too: Radix attaches it after the commit that
  // flips `open`, so the tabindex effect below must re-run when it lands.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    setContentEl(node);
  }, []);
  // True while the latest interaction was the keyboard — only then is a close
  // vetoed for focus-inside-the-card, so a mouse user's card still closes on
  // pointer-leave after clicking one of its links.
  const keyboardRef = useRef(false);
  // Where the current touch began; null once it is cancelled (or before any).
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  // Set when Esc hands focus back to the pill: the pill's own onFocus schedules
  // a Radix open, which must not re-show the card the user just dismissed.
  const suppressOpenRef = useRef(false);
  const contentId = useId();

  // Radix sets tabindex=-1 on every tabbable in a hover card (on each of its
  // renders); restore the card's links to the tab order while it is open.
  useEffect(() => {
    const el = contentEl;
    if (!open || !el) return;
    const restore = () =>
      el.querySelectorAll("a[tabindex='-1']").forEach((a) => a.removeAttribute("tabindex"));
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(el, { subtree: true, attributes: true, attributeFilter: ["tabindex"] });
    return () => observer.disconnect();
  }, [open, contentEl]);

  const pillContent = (
    <>
      {area.topicLabel}
      <span className={countClassName}>{area.pubCount.toLocaleString()}</span>
    </>
  );

  if (!preview) {
    return (
      <a href={`/topics/${area.topicSlug}`} className={className}>
        {pillContent}
      </a>
    );
  }

  const focusInsideCard = () =>
    !!contentRef.current && contentRef.current.contains(document.activeElement);

  const onOpenChange = (next: boolean) => {
    if (next && suppressOpenRef.current) {
      suppressOpenRef.current = false;
      return;
    }
    if (!next && keyboardRef.current && focusInsideCard()) return;
    setOpen(next);
  };

  const markKeyboard = () => {
    keyboardRef.current = true;
  };
  const markPointer = () => {
    keyboardRef.current = false;
  };

  const total = preview.total;
  const blurb = `${total.toLocaleString()} ${total === 1 ? "publication" : "publications"} by ${unitShort} ${membersNoun} · most cited`;

  return (
    <HoverCardPrimitive.Root
      open={open}
      onOpenChange={onOpenChange}
      openDelay={AREA_PREVIEW_OPEN_DELAY}
      closeDelay={AREA_PREVIEW_CLOSE_DELAY}
    >
      <HoverCardPrimitive.Trigger
        ref={triggerRef}
        href={`/topics/${area.topicSlug}`}
        className={className}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onKeyDown={markKeyboard}
        onPointerDown={markPointer}
        onBlur={() => {
          suppressOpenRef.current = false;
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          touchStartRef.current = t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchCancel={() => {
          touchStartRef.current = null;
        }}
        onTouchEnd={(e) => {
          const start = touchStartRef.current;
          touchStartRef.current = null;
          const t = e.changedTouches[0];
          // A scroll/swipe that began on the pill, or a cancelled touch: leave
          // it alone — never open the card, never navigate.
          if (
            !start ||
            !t ||
            Math.hypot(t.clientX - start.x, t.clientY - start.y) > AREA_PREVIEW_TAP_SLOP
          ) {
            return;
          }
          e.preventDefault();
          markPointer();
          if (open) e.currentTarget.click();
          else setOpen(true);
        }}
      >
        {pillContent}
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Content
        ref={setContentRef}
        id={contentId}
        role="group"
        aria-label={`${area.topicLabel}: most-cited publications`}
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onKeyDown={markKeyboard}
        onPointerDown={markPointer}
        onEscapeKeyDown={() => {
          // Radix unmounts the card on Esc; with focus inside it, focus would
          // fall to <body>. Hand it back to the pill instead.
          if (focusInsideCard()) {
            suppressOpenRef.current = true;
            triggerRef.current?.focus();
          }
        }}
        onPointerDownOutside={(e) => {
          // A tap on the pill itself is not "outside": the pill's own touch
          // handler decides between open and navigate.
          if (triggerRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && (contentRef.current?.contains(next) || triggerRef.current?.contains(next))) {
            return;
          }
          if (next) setOpen(false);
        }}
        className="border-border bg-popover text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 animate-in fade-in-0 zoom-in-95 z-50 w-96 max-w-[calc(100vw-16px)] origin-(--radix-hover-card-content-transform-origin) rounded-md border p-0 shadow-lg outline-none"
      >
        <div className="px-4 pt-[14px] pb-1">
          <div className="text-foreground text-[13px] leading-[18px] font-semibold">
            {area.topicLabel}
          </div>
          <div className="text-muted-foreground mt-0.5 text-[12px] leading-4">{blurb}</div>
        </div>
        {preview.papers.length > 0 && (
          <ul className="px-4">
            {preview.papers.map((p) => (
              <li key={p.pmid}>
                <PaperRow paper={p} unitShort={unitShort} />
              </li>
            ))}
          </ul>
        )}
        {total > 0 && (
          <a
            href={areaSeeAllHref(basePath, area.topicId, anchor)}
            className="block px-4 pt-2.5 pb-3 text-[13px]"
          >
            See all {total.toLocaleString()} →
          </a>
        )}
      </HoverCardPrimitive.Content>
    </HoverCardPrimitive.Root>
  );
}

function PaperRow({
  paper,
  unitShort,
}: {
  paper: UnitAreaPreview["papers"][number];
  unitShort: string;
}) {
  const n = paper.unitAuthorCount;
  const meta: ReactNode[] = [];
  if (paper.venue) meta.push(<PubJournal key="venue" as="em" value={paper.venue} />);
  if (paper.year) meta.push(<span key="year">{paper.year}</span>);
  if (n > 0) {
    meta.push(
      <span key="authors">
        {n} {unitShort} {n === 1 ? "author" : "authors"}
      </span>,
    );
  }
  const body = (
    <>
      <span
        {...pubTitleProps(
          sanitizePubTitle(paper.title),
          "line-clamp-2 text-[13.5px] leading-[19px] font-medium text-pretty",
        )}
      />
      {meta.length > 0 && (
        <span className="text-muted-foreground text-[12px] leading-4">
          {meta.map((m, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {m}
            </span>
          ))}
        </span>
      )}
    </>
  );
  const rowClass =
    "border-apollo-border text-foreground flex flex-col gap-[3px] border-b py-2.5 no-underline";
  if (!paper.href) return <div className={rowClass}>{body}</div>;
  return (
    <a
      href={paper.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(rowClass, "hover:text-apollo-slate hover:no-underline")}
    >
      {body}
    </a>
  );
}
