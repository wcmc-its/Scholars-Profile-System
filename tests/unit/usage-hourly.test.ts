import { describe, expect, it } from "vitest";

import {
  type HourBucket,
  easternHour,
  hourLabel,
  hourOfDayAverages,
  hourlyTimeline,
} from "@/lib/api/usage-hourly";

const H = 3_600_000;

function bucket(at: number, counts: Partial<HourBucket> = {}): HourBucket {
  return { at, ...easternHour(at), human: 0, bot: 0, error: 0, ...counts };
}

/** All 24 hours of a UTC day, every hour `counts`. */
function day(dt: string, counts: Partial<HourBucket> = {}): HourBucket[] {
  const base = Date.parse(`${dt}T00:00:00Z`);
  return Array.from({ length: 24 }, (_, h) => bucket(base + h * H, counts));
}

describe("easternHour", () => {
  it("handles EST, EDT and midnight", () => {
    expect(easternHour(Date.parse("2026-11-16T15:00:00Z"))).toEqual({
      day: "2026-11-16",
      hour: 10,
    });
    expect(easternHour(Date.parse("2026-07-01T14:00:00Z"))).toEqual({
      day: "2026-07-01",
      hour: 10,
    });
    expect(easternHour(Date.parse("2026-11-17T05:00:00Z"))).toEqual({
      day: "2026-11-17",
      hour: 0,
    });
  });
});

describe("hourLabel", () => {
  it("formats 12-hour clock labels", () => {
    expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual([
      "12 AM",
      "1 AM",
      "11 AM",
      "12 PM",
      "1 PM",
      "11 PM",
    ]);
  });
});

describe("hourlyTimeline", () => {
  it("is empty without buckets", () => {
    expect(hourlyTimeline([])).toEqual({ slots: [], capped: false });
  });

  it("lays a continuous hourly axis with null gaps for uncovered days", () => {
    const buckets = [...day("2026-11-16", { human: 1 }), ...day("2026-11-18", { human: 2 })];
    const { slots, capped } = hourlyTimeline(buckets);
    expect(capped).toBe(false);
    expect(slots).toHaveLength(72);
    expect(slots[0].counts).toEqual({ human: 1, bot: 0, error: 0 });
    // Nov 17 (UTC) was never rolled: a gap, labelled in Eastern time.
    expect(slots[24].counts).toBeNull();
    expect(slots[24]).toMatchObject({ day: "2026-11-16", hour: 19 });
    expect(slots[71].counts).toEqual({ human: 2, bot: 0, error: 0 });
  });

  it("caps to the most recent maxDays days", () => {
    const buckets = [...day("2026-11-14"), ...day("2026-11-15"), ...day("2026-11-16")];
    const { slots, capped } = hourlyTimeline(buckets, 2);
    expect(capped).toBe(true);
    expect(slots).toHaveLength(48);
    expect(slots[0].at).toBe(Date.parse("2026-11-15T00:00:00Z"));
    expect(slots[47].at).toBe(Date.parse("2026-11-16T23:00:00Z"));
  });
});

describe("hourOfDayAverages", () => {
  it("returns 24 zero hours without data", () => {
    const rows = hourOfDayAverages({ buckets: [], firstDay: null, days: 0 });
    expect(rows).toHaveLength(24);
    expect(rows.every((r) => r.human === 0 && r.bot === 0 && r.error === 0)).toBe(true);
  });

  it("averages each Eastern hour over the covered days", () => {
    const d1 = day("2026-11-16", { human: 10 });
    const d2 = day("2026-11-17", { human: 20, bot: 4 });
    // An outage at 15Z (10 AM Eastern) on the second day.
    d2[15] = { ...d2[15], human: 0, error: 30 };
    const rows = hourOfDayAverages({ buckets: [...d1, ...d2], firstDay: "2026-11-16", days: 2 });
    expect(rows[10]).toEqual({ hour: 10, human: 5, bot: 2, error: 15 });
    expect(rows[11]).toEqual({ hour: 11, human: 15, bot: 2, error: 0 });
  });
});
