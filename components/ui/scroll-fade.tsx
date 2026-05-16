"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Issue #339 — bottom-fade affordance for clipped sidebars.
 *
 * Wraps content in a vertically-scrollable viewport and overlays a subtle
 * ~40px gradient at the bottom edge to signal that the list continues past
 * the fold. The fade is shown only while the content actually overflows the
 * viewport, and hides once the user scrolls to the end — the cue is
 * meaningless when there is nothing more to reveal.
 *
 * `viewportClassName` carries the viewport sizing, typically a
 * breakpoint-gated `max-h` + `overflow-y-auto` pair. Clipping is detected by
 * measuring `scrollHeight` against `clientHeight`, so a responsive
 * `viewportClassName` (e.g. `lg:max-h-... lg:overflow-y-auto`) automatically
 * produces no fade below that breakpoint, where the viewport is uncapped.
 *
 * Sticky/width positioning stays on the caller's own wrapper element; this
 * component owns only the viewport, the overflow measurement, and the fade.
 */
export function ScrollFade({
  viewportClassName,
  children,
}: {
  viewportClassName?: string;
  children: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);

  const recompute = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    // 1px tolerance absorbs sub-pixel rounding (zoom, fractional DPR).
    const isClipped = el.scrollHeight > el.clientHeight + 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setShowFade(isClipped && !atBottom);
  }, []);

  useEffect(() => {
    recompute();
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport) return;
    // Observe the viewport (height tracks `100vh`-based caps on resize) and
    // the content (the list itself grows/shrinks, e.g. the subtopic filter).
    const observer = new ResizeObserver(recompute);
    observer.observe(viewport);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [recompute]);

  return (
    <div className="relative">
      <div ref={viewportRef} onScroll={recompute} className={viewportClassName}>
        <div ref={contentRef}>{children}</div>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-10",
          "from-background bg-gradient-to-t to-transparent",
          "transition-opacity duration-200",
          showFade ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
