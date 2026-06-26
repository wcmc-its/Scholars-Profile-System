/**
 * Generic stale-while-revalidate read cache (module-level Map + TTL + inflight
 * dedup). Extracted from the proven `cachedHomeRead` idiom in lib/api/home.ts
 * and mirrored by lib/api/reason-agg-cache.ts — there were already two copies, so
 * this is the shared one new callers should use.
 *
 * Use for viewer-INDEPENDENT, slow-changing reads (entity pages:
 * centers/departments/divisions). Two wins:
 *   1. Repeat hits within the fresh window serve warm — no DB round-trip.
 *   2. Inflight dedup: N concurrent misses for the same key collapse to ONE
 *      load; the rest await it. This is the load-shedding that flattens the
 *      "TTFB 0.2→6.2s under contention" tail on the center page.
 *
 * ponytail (full): deliberately a module Map, NOT `unstable_cache` — matches the
 * team's existing idiom (reason-agg-cache.ts:17 explains the why) and sidesteps
 * unstable_cache's serialization constraints + per-task filesystem cache.
 * Ceiling — unbounded entry count (no eviction), bounded in practice by
 * (entity × page) within the stale window; add a size cap if memory ever matters.
 */

// Fresh: serve from cache without revalidating. Matches the slow-changing nature
// of entity rollups (ETL refreshes them at most daily); tunable per caller later.
const FRESH_MS = 15 * 60 * 1000;
// Past fresh but under this: serve stale + revalidate in the background. Past it:
// block on a fresh load rather than serve very stale data.
const MAX_STALE_MS = 60 * 60 * 1000;

// Bypass entirely under test so cache state never bleeds across cases and
// per-call query assertions still hold (mirrors reason-agg-cache.ts).
const BYPASS = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

type Entry<T> = { data: T; ts: number };
const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// Load `key` once, deduped via `inflight`. Caches on success; on failure the
// rejection propagates and nothing is cached, so the next request retries.
function refresh<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = load()
    .then((data) => {
      store.set(key, { data, ts: Date.now() });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export function cachedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (BYPASS) return load();
  const hit = store.get(key) as Entry<T> | undefined;
  if (!hit) return refresh(key, load);
  const age = Date.now() - hit.ts;
  if (age < FRESH_MS) return Promise.resolve(hit.data);
  if (age < MAX_STALE_MS) {
    // Stale-while-revalidate: kick off a refresh, swallow its failure (we're
    // serving the still-acceptable stale value either way).
    void refresh(key, load).catch(() => {});
    return Promise.resolve(hit.data);
  }
  return refresh(key, load); // too stale — block on fresh
}
