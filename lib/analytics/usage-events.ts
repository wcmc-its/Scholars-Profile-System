/**
 * Dated events marked on the Usage dashboard's daily charts, so a step in a
 * series reads with its cause instead of looking like a real change in use.
 * `date` is a UTC calendar day (the rollup's `dt`), ascending. Pure: shared by
 * the server page and the client chart islands.
 */

export type UsageEvent = { date: string; label: string };

export const USAGE_EVENTS: readonly UsageEvent[] = [
  { date: "2026-11-11", label: "VIVO cutover" },
  { date: "2026-11-21", label: "Bot block rules, bot filter backfill" },
  { date: "2026-11-22", label: "Prefetch trimmed, scraper fingerprint rule (count)" },
];

/** One marker on a daily chart: the event, its slot index, and the slot's centre as a percent of the plot width. */
export type DayMarker = UsageEvent & { index: number; pct: number };

/**
 * The events that fall on one of `days` (a chart's slots, in order), placed at
 * their slot's centre. An event outside the chart's days is left out, so a
 * chart only marks events inside its own range.
 */
export function dayMarkers(
  days: readonly string[],
  events: readonly UsageEvent[] = USAGE_EVENTS,
): DayMarker[] {
  const n = days.length;
  if (n === 0) return [];
  return events.flatMap((e) => {
    const index = days.indexOf(e.date);
    return index < 0 ? [] : [{ ...e, index, pct: ((index + 0.5) / n) * 100 }];
  });
}
