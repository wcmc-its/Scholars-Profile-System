/**
 * Adaptive year-collapse grouping for the profile publications list.
 *
 * Real data: ~94% of `publication.year` is 0 (PubMed-year backfill incomplete),
 * and per-scholar dated-year coverage is sparse. The grouping must degrade
 * gracefully from "department chair with decades of yearly output" down to
 * "year=0 dominates everything."
 *
 * Algorithm:
 *   1. Partition into dated (year > 0) and undated.
 *   2. Walk dated years newest-first. Emit one group per year until (a) 4
 *      individual years emitted, OR (b) >=50% of dated pubs placed —
 *      whichever first. Floor at 1 so the newest year always shows.
 *   3. Remaining dated pubs → 5-year buckets, aligned so the boundary year
 *      starts a new bucket. Empty buckets dropped.
 *   4. Undated → final "Year unknown" group, only when non-empty.
 *
 * Within a group: caller's input order is preserved (the page passes pubs
 * already sorted by year desc, then dateAddedToEntrez desc).
 */

export type PubGroup<P> = {
  /** Stable key for React. */
  key: string;
  /** Display label, e.g. "2024" or "2015–2019" or "Year unknown". */
  label: string;
  /** Number of pubs in this group. */
  count: number;
  pubs: P[];
};

const INDIVIDUAL_YEAR_TARGET = 4;
const INDIVIDUAL_YEAR_FLOOR = 1;
const INDIVIDUAL_YEAR_PUB_FRACTION = 0.5;
const BUCKET_SIZE = 5;

export function groupPublicationsByYear<P extends { year: number | null | undefined }>(
  pubs: P[],
): PubGroup<P>[] {
  if (pubs.length === 0) return [];

  const dated: P[] = [];
  const undated: P[] = [];
  for (const p of pubs) {
    if (typeof p.year === "number" && p.year > 0) dated.push(p);
    else undated.push(p);
  }

  const groups: PubGroup<P>[] = [];

  if (dated.length > 0) {
    const byYear = new Map<number, P[]>();
    for (const p of dated) {
      const y = p.year as number;
      const arr = byYear.get(y) ?? [];
      arr.push(p);
      byYear.set(y, arr);
    }
    const yearsDesc = [...byYear.keys()].sort((a, b) => b - a);

    // Phase 1 — individual recent years.
    const placedFractionThreshold = Math.ceil(dated.length * INDIVIDUAL_YEAR_PUB_FRACTION);
    let placed = 0;
    let cutIndex = 0;
    for (let i = 0; i < yearsDesc.length; i++) {
      const y = yearsDesc[i];
      const yearPubs = byYear.get(y)!;
      groups.push({ key: `y${y}`, label: String(y), count: yearPubs.length, pubs: yearPubs });
      placed += yearPubs.length;
      cutIndex = i + 1;
      const reachedTarget = cutIndex >= INDIVIDUAL_YEAR_TARGET;
      const reachedFraction =
        cutIndex >= INDIVIDUAL_YEAR_FLOOR && placed >= placedFractionThreshold;
      if (reachedTarget || reachedFraction) break;
    }

    // Phase 2 — 5-year buckets for remaining years (older).
    const remainingYears = yearsDesc.slice(cutIndex);
    if (remainingYears.length > 0) {
      // Align bucket boundaries to the first remaining year so labels stay
      // contiguous with the individual-year section above (e.g. last
      // individual year 2020 → bucket starts at 2019 → "2015–2019").
      const boundaryYear = remainingYears[0];
      const earliest = remainingYears[remainingYears.length - 1];
      // Iterate bucket starts from boundaryYear downward in BUCKET_SIZE steps.
      // Bucket [start, start - BUCKET_SIZE + 1] inclusive.
      for (let bucketEnd = boundaryYear; bucketEnd >= earliest; bucketEnd -= BUCKET_SIZE) {
        const bucketStart = bucketEnd - BUCKET_SIZE + 1;
        const bucketPubs: P[] = [];
        for (let y = bucketEnd; y >= bucketStart; y--) {
          const ys = byYear.get(y);
          if (ys) bucketPubs.push(...ys);
        }
        if (bucketPubs.length === 0) continue;
        groups.push({
          key: `b${bucketStart}-${bucketEnd}`,
          label: `${bucketStart}–${bucketEnd}`,
          count: bucketPubs.length,
          pubs: bucketPubs,
        });
      }
    }
  }

  if (undated.length > 0) {
    groups.push({
      key: "undated",
      label: "Year unknown",
      count: undated.length,
      pubs: undated,
    });
  }

  return groups;
}
