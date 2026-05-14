"use client";

/**
 * Hover/focus tooltip wrapper used across chip-style elements (author chips,
 * grant role chips, etc.). Dark zinc-900 pill, 11px white text, arrow
 * indicator. Default behavior: 200ms delay on mouse-enter, immediate on focus.
 *
 * Lifted out of components/publication/author-chip-row.tsx so other surfaces
 * can match the styling without duplicating the timer/visibility logic.
 *
 * Optional `immediate` skips the mouse-enter delay (issue #259 §1.11 — the
 * MeSH-concept chip's scope note should surface without waiting). Optional
 * `wide` lets the tooltip wrap paragraph-length text (default
 * `whitespace-nowrap` is right for short labels but truncates sentences).
 */
import { useEffect, useRef, useState } from "react";

export function HoverTooltip({
  text,
  children,
  immediate = false,
  wide = false,
  placement = "top",
}: {
  text: string;
  children: React.ReactNode;
  /** Show on mouse-enter with no 200ms delay. Always immediate on focus. */
  immediate?: boolean;
  /** Allow wrapping + cap width — for sentence-length text such as MeSH
   *  scope notes. Defaults off so existing short-label callers are
   *  unaffected. */
  wide?: boolean;
  /** Side to render the pill on. Defaults `"top"` (the original behavior).
   *  Use `"bottom"` when the trigger sits near the page header — the
   *  resolved-concept chip at the top of /search clips against the page
   *  chrome otherwise. */
  placement?: "top" | "bottom";
}) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showDelayed = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(true), 200);
  };
  const showNow = () => {
    if (timer.current) clearTimeout(timer.current);
    setVisible(true);
  };
  const hide = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setVisible(false);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={immediate ? showNow : showDelayed}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          className={
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white shadow " +
            (placement === "bottom"
              ? "top-[calc(100%+6px)] "
              : "bottom-[calc(100%+6px)] ") +
            (wide
              ? "w-max max-w-[320px] whitespace-normal leading-snug"
              : "whitespace-nowrap")
          }
        >
          {text}
          <span
            aria-hidden="true"
            className={
              "absolute left-1/2 -translate-x-1/2 border-x-4 border-x-transparent " +
              (placement === "bottom"
                ? "bottom-full border-b-4 border-b-zinc-900"
                : "top-full border-t-4 border-t-zinc-900")
            }
            style={{ width: 0, height: 0 }}
          />
        </span>
      )}
    </span>
  );
}
