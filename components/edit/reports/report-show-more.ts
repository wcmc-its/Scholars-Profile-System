"use client";

/**
 * "Show 25 more" paging for a report table (reports redesign): the first
 * `step` rows, then `step` more per click. Resets to the first page when the
 * row list changes identity (a new filter or sort), so a narrowed list never
 * opens scrolled past its end. Pass `resetKey` (e.g. the filter query string)
 * to reset on THAT instead: a table whose rows are re-fetched after an inline
 * save gets a new array each time and would otherwise snap back to page one.
 */
import { useEffect, useState } from "react";

export function useShowMore<T>(rows: ReadonlyArray<T>, step = 25, resetKey?: string) {
  const [shown, setShown] = useState(step);
  const reset = resetKey ?? rows;
  useEffect(() => setShown(step), [reset, step]);
  const visible = rows.slice(0, shown);
  return {
    visible,
    hasMore: shown < rows.length,
    showMore: () => setShown((n) => n + step),
    /** "Showing 25 of 69" — the caller adds its noun. */
    rangeLabel: `Showing ${visible.length.toLocaleString()} of ${rows.length.toLocaleString()}`,
  };
}
