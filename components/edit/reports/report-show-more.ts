"use client";

/**
 * "Show 25 more" paging for a report table (reports redesign): the first
 * `step` rows, then `step` more per click. Resets to the first page when the
 * row list changes identity (a new filter or sort), so a narrowed list never
 * opens scrolled past its end.
 */
import { useEffect, useState } from "react";

export function useShowMore<T>(rows: ReadonlyArray<T>, step = 25) {
  const [shown, setShown] = useState(step);
  useEffect(() => setShown(step), [rows, step]);
  const visible = rows.slice(0, shown);
  return {
    visible,
    hasMore: shown < rows.length,
    showMore: () => setShown((n) => n + step),
    /** "Showing 25 of 69" — the caller adds its noun. */
    rangeLabel: `Showing ${visible.length.toLocaleString()} of ${rows.length.toLocaleString()}`,
  };
}
