/** "2018–2021" / "2018" / "" — a postgraduate training row's year span. */
export function trainingYearRange(from: number | null, to: number | null): string {
  if (from && to && from !== to) return `${from}–${to}`;
  return String(from ?? to ?? "");
}
