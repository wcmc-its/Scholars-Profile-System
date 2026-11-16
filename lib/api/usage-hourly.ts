/**
 * Hourly traffic for `/edit/usage`'s "Traffic by hour" card: types and pure
 * helpers shared by the server shaper (lib/api/usage-summary.ts) and the client
 * chart (app/edit/usage/usage-widgets.tsx). No server imports, so it is safe in
 * the client bundle.
 *
 * The `hourly` rollup metric is keyed by UTC hour; the console reads in Eastern
 * time, so every bucket carries its Eastern calendar day and hour.
 */

export const TRAFFIC_CLASSES = ["human", "bot", "error"] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];
export type ClassCounts = Record<TrafficClass, number>;

/** One hour of page requests by traffic class. */
export type HourBucket = ClassCounts & {
  /** Start of the hour, epoch ms (orders and spaces the timeline). */
  at: number;
  /** Eastern calendar day (YYYY-MM-DD) and hour (0-23) of `at`. */
  day: string;
  hour: number;
};

export type HourlyTraffic = {
  /** Sorted by `at`; all 24 hours of every UTC day the rollup covered. */
  buckets: HourBucket[];
  /** Earliest UTC day with hourly data in the range, or null when none. */
  firstDay: string | null;
  /** Distinct UTC days with hourly data (the per-day average's divisor). */
  days: number;
};

export const EMPTY_HOURLY: HourlyTraffic = { buckets: [], firstDay: null, days: 0 };

const HOUR_MS = 3_600_000;

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** The Eastern (America/New_York) calendar day and hour of an instant. */
export function easternHour(at: number): { day: string; hour: number } {
  const p: Record<string, string> = {};
  for (const part of EASTERN.formatToParts(new Date(at))) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/** 0 -> "12 AM", 13 -> "1 PM". */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** One timeline slot: an hour, with `counts` null when the rollup has no data for it. */
export type HourSlot = { at: number; day: string; hour: number; counts: ClassCounts | null };

/**
 * Lays the buckets on a continuous hourly axis, capped to the most recent
 * `maxDays` days (counted back from the last bucket). An hour with no bucket
 * (a day the rollup never covered) is a `null` slot the chart draws as a gap.
 */
export function hourlyTimeline(
  buckets: readonly HourBucket[],
  maxDays = 30,
): { slots: HourSlot[]; capped: boolean } {
  if (buckets.length === 0) return { slots: [], capped: false };
  const first = buckets[0].at;
  const last = buckets[buckets.length - 1].at;
  const floor = last - (maxDays * 24 - 1) * HOUR_MS;
  const start = Math.max(first, floor);
  const byAt = new Map(buckets.map((b) => [b.at, b]));
  const slots: HourSlot[] = [];
  for (let at = start; at <= last; at += HOUR_MS) {
    const b = byAt.get(at);
    slots.push(
      b
        ? { at, day: b.day, hour: b.hour, counts: { human: b.human, bot: b.bot, error: b.error } }
        : { at, ...easternHour(at), counts: null },
    );
  }
  return { slots, capped: first < floor };
}

/**
 * The range folded into 24 Eastern hours of the day, each the average per
 * day: the hour's total over every covered day, divided by the number of
 * covered (UTC) days. Each covered UTC day contributes exactly one of each
 * Eastern hour (bar a DST changeover), so the divisor is the same for all 24.
 */
export function hourOfDayAverages(traffic: HourlyTraffic): (ClassCounts & { hour: number })[] {
  const out = Array.from({ length: 24 }, (_, hour) => ({ hour, human: 0, bot: 0, error: 0 }));
  if (traffic.days === 0) return out;
  for (const b of traffic.buckets) {
    for (const c of TRAFFIC_CLASSES) out[b.hour][c] += b[c];
  }
  for (const row of out) {
    for (const c of TRAFFIC_CLASSES) row[c] /= traffic.days;
  }
  return out;
}
