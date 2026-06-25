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
 * an LRU dependency. Ceiling — unbounded entry count (no eviction). Acceptable
 * because the key space is bounded by (distinct concept × query × page-cwid set)
 * within a 30-min window and each entry is a few KB of bucket data; if memory
 * ever matters, add a size cap. No new dependency, mirrors the home.ts pattern.
 */

// 5 min fresh — shorter than home's 15 min because reason counts are live
// publication counts (rep-pub freshness matters more than home cards).
const REASON_AGG_TTL_MS = 5 * 60 * 1000;
// 30 min serve-stale ceiling — past this, block on a fresh load rather than
// serve very stale counts. Proportional to the shorter TTL.
const REASON_AGG_MAX_STALE_MS = 30 * 60 * 1000;
const REASON_AGG_BYPASS =
  Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

type ReasonAggEntry<T> = { data: T; ts: number };
const reasonAggCache = new Map<string, ReasonAggEntry<unknown>>();
const reasonAggInflight = new Map<string, Promise<unknown>>();

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

function refreshReasonAgg<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = reasonAggInflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = load()
    .then((data) => {
      reasonAggCache.set(key, { data, ts: Date.now() });
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
 */
export function cachedReasonAgg<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (REASON_AGG_BYPASS) return load();
  const hit = reasonAggCache.get(key) as ReasonAggEntry<T> | undefined;
  const age = hit ? Date.now() - hit.ts : Number.POSITIVE_INFINITY;

  // Fresh — serve cached, no work.
  if (hit && age < REASON_AGG_TTL_MS) return Promise.resolve(hit.data);

  // Stale but within the ceiling — serve stale now, refresh in the background
  // (deduped). No request blocks; a failed refresh is swallowed and retried.
  if (hit && age < REASON_AGG_MAX_STALE_MS) {
    void refreshReasonAgg(key, load).catch(() => {});
    return Promise.resolve(hit.data);
  }

  // Cold or past the staleness ceiling — block on a fresh load. A failure
  // propagates to the caller and is not cached.
  return refreshReasonAgg(key, load);
}
