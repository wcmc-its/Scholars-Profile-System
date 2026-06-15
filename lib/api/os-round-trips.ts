/**
 * D3 SLI — counts OpenSearch round-trips per /api/search request; inert
 * outside a request scope (ETL/index build unaffected).
 *
 * The /api/search GET handler runs inside `runWithOsRoundTripCounter`, which
 * establishes an AsyncLocalStorage store carrying a per-request counter. The
 * search client wrapper (lib/search.ts) calls `recordOsRoundTrip` on every
 * `.search()` invocation; the counter survives `await` boundaries because the
 * store propagates through the async context. `getOsRoundTripCount` reads the
 * active store's count for the structured `search_query` log. When there is no
 * active store (ETL, index build, tests that never enter a scope), recording is
 * a no-op and the count reads 0 — so this is behavior-neutral everywhere.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Store = { count: number };

const storage = new AsyncLocalStorage<Store>();

/**
 * Run `fn` inside a fresh request-scoped round-trip counter. Returns whatever
 * `fn` returns (including a Promise, which keeps the store bound across awaits).
 */
export function runWithOsRoundTripCounter<T>(fn: () => T): T {
  return storage.run({ count: 0 }, fn);
}

/**
 * Increment the active request's OpenSearch round-trip count. No-op when called
 * outside a `runWithOsRoundTripCounter` scope (e.g. ETL / index build).
 */
export function recordOsRoundTrip(): void {
  const s = storage.getStore();
  if (s) s.count += 1;
}

/**
 * Read the active request's OpenSearch round-trip count. Returns 0 outside a
 * scope.
 */
export function getOsRoundTripCount(): number {
  return storage.getStore()?.count ?? 0;
}
