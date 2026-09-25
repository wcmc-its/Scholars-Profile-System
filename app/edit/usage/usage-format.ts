/**
 * Pure formatting helpers shared by `/edit/usage`'s server page and its client
 * islands. Kept out of the "use client" module on purpose: a function exported
 * from a client module is a client reference on the server and can't be called
 * there.
 */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-26" -> "Aug 26" (the rollup's `dt` is a UTC calendar day). */
export function shortDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d || m > 12) return iso;
  return `${MON[m - 1]} ${d}`;
}

/** "2026-07" -> "Jul 2026". */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m || m > 12) return ym;
  return `${MON[m - 1]} ${y}`;
}

/** Rounds a max up to a "nice" chart ceiling (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10^k). */
export function niceCeil(max: number): number {
  if (!(max > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * mag >= max) ?? 10;
  return step * mag;
}

/** True for a Saturday or Sunday (UTC). */
export function isWeekend(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Share of a total as a percent label: 1 decimal, 2 under 1%, "<0.01%" for a sliver. */
export function pctLabel(share: number): string {
  if (share > 0 && share < 0.0001) return "<0.01%";
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
}

/** One chart slot: a day's pageviews, or `null` when the rollup has no row for it. */
export type ChartDay = { day: string; views: number | null };

/** Upper bound on chart slots: a bad bound can't spin (about three years). */
const MAX_CHART_SLOTS = 1100;

/**
 * Lays the rollup's rows on a continuous day axis from `since` through `until`
 * (inclusive), so a day with no rollup row is a `null` slot that the chart
 * draws as a gap, not a zero and not a silently dropped day. Falls back to the
 * data's own first/last day when a bound is missing or malformed.
 *
 * Never drops a real row: the axis always spans every row, and when the
 * requested window is longer than `MAX_CHART_SLOTS` it is trimmed to the
 * data's own span first (leading/trailing empty days go, rows stay). If even
 * the data span is too long to fill, the rows come back unfilled.
 */
export function fillDayGaps(
  days: ReadonlyArray<{ day: string; views: number }>,
  since?: string,
  until?: string,
): ChartDay[] {
  if (days.length === 0) return [];
  const DAY_MS = 86_400_000;
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const sorted = days.map((d) => d.day).sort();
  const firstRow = sorted[0];
  const lastRow = sorted[sorted.length - 1];
  const valid = (d: string | undefined): d is string =>
    !!d && iso.test(d) && Number.isFinite(ms(d));
  // The axis always covers every row, even one outside the requested window.
  let start = valid(since) && since < firstRow ? since : firstRow;
  let end = valid(until) && until > lastRow ? until : lastRow;
  const slots = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY_MS) + 1;
  if (slots(start, end) > MAX_CHART_SLOTS) {
    start = firstRow;
    end = lastRow;
  }
  if (!Number.isFinite(ms(start)) || !Number.isFinite(ms(end))) {
    return days.map((d) => ({ ...d }));
  }
  if (slots(start, end) > MAX_CHART_SLOTS) return days.map((d) => ({ ...d }));
  const byDay = new Map(days.map((d) => [d.day, d.views]));
  const out: ChartDay[] = [];
  for (let t = ms(start); t <= ms(end); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, views: byDay.get(day) ?? null });
  }
  return out;
}
