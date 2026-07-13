/**
 * Reason-agg result cache (scaling fix C).
 *
 * The People search fires ONE OpenSearch aggregation over the 178k-doc
 * publications index per request to build the per-row "N publications …" reason
 * line. Under concurrency (the ~10-user go-live target) this tails to 5–9s and
 * saturates the search thread pool. The aggregation is a pure function of
 * `[pageCwids, meshDescendantUis, contentQuery]` (plus the representative-pub
 * shape), so identical concurrent/repeat requests — pagination re-renders, the
 * same broad concept searched by several users — recompute the same buckets.
 *
 * This is a module-level Map + wall-clock TTL + stale-while-revalidate, the same
 * idiom already proven in lib/api/home.ts (cachedHomeRead). The inflight-dedup is
 * the load-shedding win: N concurrent misses for the same key collapse to ONE
 * OpenSearch round-trip; the rest await it.
 *
 * ponytail (full): deliberately a single-file Map cache, NOT unstable_cache or
 * an LRU dependency. The "key space is naturally bounded" assumption held for
 * server-derived keys but not for /api/search/key-paper, whose key parts are
 * attacker-controlled query params on an unauthenticated route — so entries now
 * expire on write (anything past the staleness ceiling) with a FIFO size cap as
 * the backstop. Still no dependency; mirrors the home.ts pattern.
 */

// 5 min fresh — shorter than home's 15 min because reason counts are live
// publication counts (rep-pub freshness matters more than home cards).
const REASON_AGG_TTL_MS = 5 * 60 * 1000;
// 30 min serve-stale ceiling — past this, block on a fresh load rather than
// serve very stale counts. Proportional to the shorter TTL.
const REASON_AGG_MAX_STALE_MS = 30 * 60 * 1000;
// Size backstop: sweeping expired entries bounds honest traffic, but a burst of
// distinct adversarial keys inside one staleness window could still grow the
// map — cap it and drop oldest-inserted first. 5k entries × a few KB ≈ tens of
// MB worst case, well within a 1-vCPU task's headroom.
const REASON_AGG_MAX_ENTRIES = 5000;
const REASON_AGG_BYPASS =
  Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

type ReasonAggEntry<T> = { data: T; ts: number };
const reasonAggCache = new Map<string, ReasonAggEntry<unknown>>();
const reasonAggInflight = new Map<string, Promise<unknown>>();

/** Drop entries past the staleness ceiling (they can never be served again),
 *  then FIFO-trim to the size cap. Runs on every cache write — O(n) over a
 *  few thousand entries every few minutes is noise next to the OS round-trip
 *  each write represents. */
function evictReasonAgg(now: number): void {
  for (const [key, entry] of reasonAggCache) {
    if (now - entry.ts >= REASON_AGG_MAX_STALE_MS) reasonAggCache.delete(key);
  }
  if (reasonAggCache.size > REASON_AGG_MAX_ENTRIES) {
    const excess = reasonAggCache.size - REASON_AGG_MAX_ENTRIES;
    let dropped = 0;
    for (const key of reasonAggCache.keys()) {
      if (dropped++ >= excess) break;
      reasonAggCache.delete(key);
    }
  }
}

/**
 * Build a stable cache key for a reason-agg run. Sorts the cwid/UI arrays so a
 * different hit ordering on the same page (or minor re-sort) hits the same key.
 * `representativePub` is part of the key because the agg body — and thus the
 * cached buckets — differ when the top_hits sub-agg is present.
 */
export function reasonAggKey(parts: {
  pageCwids: string[];
  meshDescendantUis: string[];
  contentQuery: string;
  representativePub: boolean;
}): string {
  return JSON.stringify([
    [...parts.pageCwids].sort(),
    [...parts.meshDescendantUis].sort(),
    parts.contentQuery,
    parts.representativePub,
  ]);
}

/** Test-only probe: the current entry count, so eviction is assertable without
 *  exporting the map itself. */
export function reasonAggCacheSize(): number {
  return reasonAggCache.size;
}

function refreshReasonAgg<T>(
  key: string,
  load: () => Promise<T>,
  shouldCache?: (data: T) => boolean,
): Promise<T> {
  const existing = reasonAggInflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = load()
    .then((data) => {
      if (shouldCache && !shouldCache(data)) return data;
      const now = Date.now();
      reasonAggCache.set(key, { data, ts: now });
      evictReasonAgg(now);
      return data;
    })
    .finally(() => {
      reasonAggInflight.delete(key);
    });
  reasonAggInflight.set(key, p);
  return p;
}

/**
 * Serve the reason-agg result for `key` from the cache when fresh, serve stale +
 * refresh in the background within the ceiling, else block on a fresh load.
 * Inflight-deduped, so concurrent misses share one load. Bypassed under test.
 *
 * `shouldCache` — optional gate on the RESULT. A rejected load is already never cached, but
 * some loaders DEGRADE INSTEAD OF THROWING: they swallow an upstream failure and resolve with
 * an empty value. Caching that turns a transient outage into a sticky one, because the retry
 * that would have healed it is served from the cache instead of re-running. A caller whose
 * loader can degrade must say so here. Omitted ⇒ cache every resolved value (the original
 * behaviour; the aggregation callers below genuinely cannot degrade-and-resolve).
 */
export function cachedReasonAgg<T>(
  key: string,
  load: () => Promise<T>,
  shouldCache?: (data: T) => boolean,
): Promise<T> {
  if (REASON_AGG_BYPASS) return load();
  const hit = reasonAggCache.get(key) as ReasonAggEntry<T> | undefined;
  const age = hit ? Date.now() - hit.ts : Number.POSITIVE_INFINITY;

  // Fresh — serve cached, no work.
  if (hit && age < REASON_AGG_TTL_MS) return Promise.resolve(hit.data);

  // Stale but within the ceiling — serve stale now, refresh in the background
  // (deduped). No request blocks; a failed refresh is swallowed and retried.
  if (hit && age < REASON_AGG_MAX_STALE_MS) {
    void refreshReasonAgg(key, load, shouldCache).catch(() => {});
    return Promise.resolve(hit.data);
  }

  // Cold or past the staleness ceiling — block on a fresh load. A failure
  // propagates to the caller and is not cached.
  return refreshReasonAgg(key, load, shouldCache);
}
