/**
 * #1537 — cross-task bust signal for lib/api/swr-cache.ts.
 *
 * Covers the pure logic added on top of the existing Map/TTL cache:
 *   - `computeBusted` (mirrors `computeStale` in lib/cache/s3-cache-handler.js):
 *     an entry is busted iff a cross-task marker for its prefix landed after
 *     the entry was cached.
 *   - `bustPrefixOf`: the key→prefix derivation the epoch check uses, which
 *     must line up with what every existing `bust()` caller passes.
 *
 * `cachedRead`/`bust` themselves are exercised elsewhere (e.g.
 * tests/unit/edit-revalidation.test.ts mocks this module entirely) and run
 * under VITEST, which BYPASSes the cache — and NEXT_ISR_CACHE_BUCKET is unset
 * in CI, so the S3 epoch-check path is a no-op there too. No AWS mocking
 * needed for this file.
 */
import { describe, expect, it } from "vitest";
import { bustPrefixOf, computeBusted } from "@/lib/api/swr-cache";

describe("computeBusted (bust-epoch freshness math)", () => {
  it("not busted when no marker was ever seen (epoch 0)", () => {
    expect(computeBusted(1000, 0)).toBe(false);
  });
  it("not busted when the marker predates the cached entry", () => {
    expect(computeBusted(1000, 500)).toBe(false);
  });
  it("not busted when the marker exactly matches the entry's cache time", () => {
    expect(computeBusted(1000, 1000)).toBe(false);
  });
  it("busted when a cross-task bust marker landed after the entry was cached", () => {
    expect(computeBusted(1000, 1500)).toBe(true);
  });
});

describe("bustPrefixOf (key -> bust-prefix derivation)", () => {
  it("matches the entity-kind prefix real bust() callers pass", () => {
    expect(bustPrefixOf("center:detail:some-slug")).toBe("center:");
    expect(bustPrefixOf("department:detail:some-slug")).toBe("department:");
    expect(bustPrefixOf("division:faculty:code:0")).toBe("division:");
    expect(bustPrefixOf("methods:rollup:supercat:10")).toBe("methods:");
  });
  it("falls back to the whole key when there is no colon", () => {
    expect(bustPrefixOf("nocolon")).toBe("nocolon");
  });
});
