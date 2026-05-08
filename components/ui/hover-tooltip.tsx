"use client";

/**
 * Hover/focus tooltip wrapper used across chip-style elements (author chips,
 * grant role chips, etc.). Dark zinc-900 pill, 11px white text, arrow
 * indicator. 200ms delay on mouse-enter, immediate on focus.
 *
 * Lifted out of components/publication/author-chip-row.tsx so other surfaces
 * can match the styling without duplicating the timer/visibility logic.
 */
import { useEffect, useRef, useState } from "react";

export function HoverTooltip({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
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
    <div
      className="relative inline-flex"
      onMouseEnter={showDelayed}
      onMouseLeave={hide}
      onFocus={showNow}
      onBlur={hide}
    >
      {children}
      {visible && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white shadow"
        >
          {text}
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-zinc-900"
            style={{ width: 0, height: 0 }}
          />
        </div>
      )}
    </div>
  );
}
