"use client";

/**
 * Accessible abbreviation tooltip (issue #78 F4).
 *
 * Renders a short label (sponsor short name, NIH IC code, mechanism code).
 * If `expand` is null the bare short label is rendered without any tooltip
 * affordance (no empty tooltips per spec).
 *
 * Otherwise the short label is wrapped in a focusable element that:
 *   - Reveals the tooltip on hover (200ms delay) and on keyboard focus / tap.
 *   - Carries `aria-describedby` referencing the tooltip element so screen
 *     readers announce the expansion.
 *
 * Higher-level wrappers (`<SponsorAbbr>`, `<MechanismAbbr>`) do the lookup
 * against the canonical tables.
 */

import { useEffect, useId, useRef, useState } from "react";

interface Props {
  short: string;
  expand: string | null;
  /** Visual style of the short label. Defaults to inheriting from parent. */
  className?: string;
}

export function AbbrTooltip({ short, expand, className }: Props) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!expand) {
    return <span className={className}>{short}</span>;
  }

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

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={showDelayed}
      onMouseLeave={hide}
    >
      <abbr
        title={expand}
        aria-describedby={visible ? tooltipId : undefined}
        tabIndex={0}
        onFocus={showNow}
        onBlur={hide}
        className={`cursor-help no-underline ${className ?? ""}`.trim()}
      >
        {short}
      </abbr>
      {visible && (
        <span
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white shadow"
        >
          {expand}
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-zinc-900"
            style={{ width: 0, height: 0 }}
          />
        </span>
      )}
    </span>
  );
}
