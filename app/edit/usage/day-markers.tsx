/**
 * Dated-event markers (lib/analytics/usage-events) for `/edit/usage`'s daily
 * charts: the profile pageviews chart (./usage-widgets) and the edge firewall
 * chart (./traffic-widgets). No hooks, so either client island can draw it.
 */
import type { DayMarker } from "@/lib/analytics/usage-events";
import { cn } from "@/lib/utils";

import { shortDay } from "./usage-format";

/** Height of one event-marker label row above a daily chart's plot. */
export const MARKER_ROW_PX = 16;

/** The markers as a chart's accessible-name suffix (the overlay is aria-hidden). */
export function markersLabel(markers: readonly DayMarker[]): string {
  return markers.length === 0
    ? ""
    : `; marked: ${markers.map((m) => `${shortDay(m.date)} ${m.label}`).join("; ")}`;
}

/** Dated events (USAGE_EVENTS) over a daily chart's plot: a thin line at the
 *  event's day and its label in the axis-label style, one label row per
 *  marker in a band just above the plot so labels never collide. The chart
 *  reserves the band (`markers.length * MARKER_ROW_PX`). A label runs right of
 *  its line in the plot's left half, left of it in the right half, and
 *  truncates rather than overflow the card. `bottom` stops the lines at the
 *  baseline when the plot box extends below it. */
export function DayMarkerOverlay({
  markers,
  bottom = 0,
}: {
  markers: readonly DayMarker[];
  bottom?: string | number;
}) {
  if (markers.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0"
      style={{ top: -markers.length * MARKER_ROW_PX, bottom }}
      aria-hidden="true"
    >
      {markers.map((m, j) => {
        const top = j * MARKER_ROW_PX;
        const rightward = m.pct <= 50;
        return (
          <div key={m.date} data-testid="usage-day-marker" data-date={m.date}>
            <div
              className="border-muted-foreground absolute bottom-0 border-l"
              style={{ left: `${m.pct}%`, top }}
            />
            <span
              className={cn(
                "text-muted-foreground absolute truncate text-[11.5px] leading-4",
                rightward ? "pl-1" : "pr-1 text-right",
              )}
              style={
                rightward
                  ? { left: `${m.pct}%`, top, maxWidth: `${100 - m.pct}%` }
                  : { right: `${100 - m.pct}%`, top, maxWidth: `${m.pct}%` }
              }
            >
              {m.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
