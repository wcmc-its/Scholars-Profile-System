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

/**
 * Lays the rollup's rows on a continuous day axis from `since` through `until`
 * (inclusive), so a day with no rollup row is a `null` slot that the chart
 * draws as a gap, not a zero and not a silently dropped day. Falls back to the
 * data's own first/last day when a bound is missing or malformed.
 */
export function fillDayGaps(
  days: ReadonlyArray<{ day: string; views: number }>,
  since?: string,
  until?: string,
): ChartDay[] {
  if (days.length === 0) return [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const start = since && iso.test(since) ? since : days[0].day;
  const end = until && iso.test(until) ? until : days[days.length - 1].day;
  const byDay = new Map(days.map((d) => [d.day, d.views]));
  const out: ChartDay[] = [];
  const DAY_MS = 86_400_000;
  const endMs = Date.parse(`${end}T00:00:00Z`);
  // Bounded walk: a bad bound can't spin (at most ~3 years of slots).
  for (
    let t = Date.parse(`${start}T00:00:00Z`);
    Number.isFinite(t) && t <= endMs && out.length < 1100;
    t += DAY_MS
  ) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, views: byDay.get(day) ?? null });
  }
  return out.length > 0 ? out : days.map((d) => ({ ...d }));
}
