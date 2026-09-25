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
