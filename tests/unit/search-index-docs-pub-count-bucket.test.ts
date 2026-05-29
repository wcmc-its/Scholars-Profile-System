/**
 * `computePubCountBuckets` — #254 §10. Buckets each scholar's displayed
 * `publicationCount` into `pubCountBucket ∈ {0..4}` for the autocomplete §6
 * primary tiebreak:
 *
 *   - 0    — zero displayed publications
 *   - 1..4 — quartiles of the *nonzero* population (4 = most prolific)
 *
 * Quartiles are taken over the nonzero population so the large mass of
 * zero / low-output scholars can't collapse all four cut points into one
 * bucket. These tests pin the boundary behavior, the zero carve-out, and the
 * degenerate-corpus cases that must not throw.
 */
import { describe, it, expect } from "vitest";
import { computePubCountBuckets } from "@/lib/search-index-docs";

describe("computePubCountBuckets (#254 §10)", () => {
  it("puts zero-publication scholars in bucket 0", () => {
    const { bucketOf } = computePubCountBuckets([0, 0, 0, 1, 2, 3, 4]);
    expect(bucketOf(0)).toBe(0);
  });

  it("quartiles a clean 1..8 distribution into contiguous, equal quarters", () => {
    const { bucketOf } = computePubCountBuckets([1, 2, 3, 4, 5, 6, 7, 8]);
    // Quarter boundaries at counts 2 / 4 / 6: {1,2}->1, {3,4}->2, {5,6}->3, {7,8}->4.
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(bucketOf)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  it("ignores zeros when computing the quartile cut points", () => {
    // Same nonzero population as above; the leading zeros must not shift cuts.
    const { bucketOf } = computePubCountBuckets([
      0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(8)).toBe(4);
    expect(bucketOf(1)).toBe(1);
  });

  it("places the corpus maximum in the top bucket (non-degenerate)", () => {
    const { bucketOf } = computePubCountBuckets([0, 0, 1, 1, 100]);
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1)).toBe(1);
    expect(bucketOf(100)).toBe(4);
  });

  it("does not throw on a uniform nonzero distribution (all tied)", () => {
    const { bucketOf } = computePubCountBuckets([10, 10, 10, 10]);
    // Tied counts can't be split across buckets — they all land together,
    // and crucially nothing NaNs or throws.
    const buckets = [10, 10, 10, 10].map(bucketOf);
    expect(new Set(buckets).size).toBe(1);
    expect(buckets[0]).toBeGreaterThanOrEqual(1);
    expect(buckets[0]).toBeLessThanOrEqual(4);
  });

  it("does not throw on a single nonzero scholar", () => {
    const { bucketOf } = computePubCountBuckets([0, 0, 5]);
    expect(bucketOf(0)).toBe(0);
    const b = bucketOf(5);
    expect(b).toBeGreaterThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(4);
  });

  it("handles an all-zero corpus without throwing", () => {
    const { bucketOf } = computePubCountBuckets([0, 0, 0]);
    expect([0, 0, 0].map(bucketOf)).toEqual([0, 0, 0]);
  });

  it("handles an empty corpus without throwing", () => {
    const { bucketOf } = computePubCountBuckets([]);
    expect(bucketOf(0)).toBe(0);
  });

  it("is monotonic: a higher count never lands in a lower bucket", () => {
    const counts = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    const { bucketOf } = computePubCountBuckets(counts);
    const sorted = [...counts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(bucketOf(sorted[i]!)).toBeGreaterThanOrEqual(bucketOf(sorted[i - 1]!));
    }
  });
});
