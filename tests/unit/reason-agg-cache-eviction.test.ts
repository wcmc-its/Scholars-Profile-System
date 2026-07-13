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

/**
 * `shouldCache` — the guard that separates a memo from a stuck failure.
 *
 * The sponsor matcher's loader DEGRADES INSTEAD OF THROWING: when Bedrock throttles or times
 * out, the concept extractor logs and returns `[]`, and the engine RESOLVES with an empty
 * result. A resolved value is a cacheable value, so without this gate a ten-second Bedrock
 * blip would be frozen into the cache and the officer's re-submit — the very thing that would
 * have healed it — would be served the cached empty instead of retrying.
 */
describe("reason-agg cache shouldCache gate", () => {
  it("does not cache a result the caller calls degraded, so the next call retries", async () => {
    const { cachedReasonAgg, reasonAggCacheSize } = await freshModule();
    const nonEmpty = (r: string[]) => r.length > 0;

    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls === 1 ? [] : ["recovered"]; // first call = the outage
    };

    expect(await cachedReasonAgg("k", load, nonEmpty)).toEqual([]);
    expect(reasonAggCacheSize()).toBe(0); // the empty was NOT retained

    // The retry actually re-runs the loader rather than being served the cached empty.
    expect(await cachedReasonAgg("k", load, nonEmpty)).toEqual(["recovered"]);
    expect(calls).toBe(2);
    expect(reasonAggCacheSize()).toBe(1); // the good result IS retained
  });

  it("still caches every resolved value when no gate is supplied", async () => {
    const { cachedReasonAgg, reasonAggCacheSize } = await freshModule();
    let calls = 0;
    await cachedReasonAgg("k", async () => {
      calls += 1;
      return [];
    });
    expect(reasonAggCacheSize()).toBe(1);
    await cachedReasonAgg("k", async () => {
      calls += 1;
      return [];
    });
    expect(calls).toBe(1); // served from cache — the pre-existing behaviour, unchanged
  });
});
