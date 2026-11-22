/** lib/analytics/usage-events — which dated events a daily chart marks, and where. */
import { describe, expect, it } from "vitest";

import { USAGE_EVENTS, dayMarkers } from "@/lib/analytics/usage-events";

describe("dayMarkers", () => {
  it("places an event at its day slot's centre and skips events outside the days", () => {
    const days = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
    expect(dayMarkers(days)).toEqual([
      { date: "2026-11-11", label: "VIVO cutover", index: 1, pct: 37.5 },
    ]);
  });

  it("marks every event a range holds, in date order", () => {
    const days = Array.from({ length: 30 }, (_, i) =>
      new Date(Date.UTC(2026, 9, 23 + i)).toISOString().slice(0, 10),
    );
    expect(dayMarkers(days).map((m) => m.date)).toEqual(USAGE_EVENTS.map((e) => e.date));
  });

  it("marks nothing on an empty chart", () => {
    expect(dayMarkers([])).toEqual([]);
  });
});
