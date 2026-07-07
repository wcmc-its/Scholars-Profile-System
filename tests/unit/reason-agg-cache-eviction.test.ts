/**
 * `lib/api/reason-agg-cache.ts` — eviction.
 *
 * The cache's original "key space is naturally bounded" assumption fails for
 * /api/search/key-paper, whose key parts are attacker-controlled params on an
 * unauthenticated route. This suite pins the two bounds added for that:
 *  - entries past the 30-min staleness ceiling are dropped on the next write;
 *  - a FIFO size cap (5000) bounds a burst of distinct keys within one window.
 *
 * The module bypasses itself under vitest (REASON_AGG_BYPASS reads
 * VITEST/NODE_ENV at import), so each test re-imports it fresh with stubbed
 * env + fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CacheModule = typeof import("@/lib/api/reason-agg-cache");

async function freshModule(): Promise<CacheModule> {
  vi.resetModules();
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  return await import("@/lib/api/reason-agg-cache");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("reason-agg cache eviction", () => {
  it("drops entries past the staleness ceiling on the next write", async () => {
    const { cachedReasonAgg, reasonAggCacheSize } = await freshModule();

    await cachedReasonAgg("k1", async () => "v1");
    await cachedReasonAgg("k2", async () => "v2");
    expect(reasonAggCacheSize()).toBe(2);

    // Past the 30-min serve-stale ceiling — k1/k2 can never be served again.
    vi.advanceTimersByTime(31 * 60 * 1000);
    await cachedReasonAgg("k3", async () => "v3");
    expect(reasonAggCacheSize()).toBe(1);
  });

  it("keeps fresh entries when sweeping", async () => {
    const { cachedReasonAgg, reasonAggCacheSize } = await freshModule();

    await cachedReasonAgg("old", async () => "v");
    vi.advanceTimersByTime(31 * 60 * 1000);
    await cachedReasonAgg("fresh", async () => "v");
    vi.advanceTimersByTime(60 * 1000);
    await cachedReasonAgg("fresh2", async () => "v");

    // "old" swept; "fresh" (1 min old) retained alongside "fresh2".
    expect(reasonAggCacheSize()).toBe(2);
  });

  it("FIFO-caps a burst of distinct keys within one staleness window", async () => {
    const { cachedReasonAgg, reasonAggCacheSize } = await freshModule();

    for (let i = 0; i < 5_010; i++) {
      await cachedReasonAgg(`k${i}`, async () => i);
    }
    expect(reasonAggCacheSize()).toBe(5_000);

    // Oldest-inserted keys were the ones dropped: k0 reloads (cold), the most
    // recent key serves from cache (its loader is not called).
    const reload = vi.fn(async () => "reloaded");
    await cachedReasonAgg("k0", reload);
    expect(reload).toHaveBeenCalledTimes(1);
    const cachedLoad = vi.fn(async () => "should not run");
    await cachedReasonAgg("k5009", cachedLoad);
    expect(cachedLoad).not.toHaveBeenCalled();
  });
});
