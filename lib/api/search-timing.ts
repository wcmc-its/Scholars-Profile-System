/**
 * Issue #294 PR-5 — search timing instrumentation.
 *
 * Shared timing primitives so the #294 loading-UX audit can publish real
 * p50/p95 search latencies instead of impressionistic numbers.
 *
 *   - `app/(public)/search/page.tsx` (a Server Component) wraps each search
 *     in `timed()` and emits a `search_page_render` structured log. A Server
 *     Component cannot set a response header, so that log IS the
 *     instrumentation there — the audit's "Server-Timing headers (or
 *     equivalent)".
 *   - `app/api/search/route.ts` (a Route Handler) additionally serializes a
 *     `Server-Timing` response header via `serverTimingHeader()`, so the
 *     resolver and search latencies show per-request in browser DevTools.
 *
 * Logs aggregate into percentiles; a header is per-request. Both surfaces
 * log; only the route handler can also set the header.
 */

/** One measured segment, ready to serialize as a `Server-Timing` metric. */
export type TimingMark = {
  /** Metric name — must be a `Server-Timing` token (no whitespace). */
  name: string;
  /** Elapsed wall time, whole ms. Negative / non-finite marks are dropped. */
  ms: number;
  /** Optional human-readable label, emitted as the metric's `desc`. */
  desc?: string;
};

/**
 * Run `fn` and return its resolved value alongside the elapsed wall time in
 * whole milliseconds. The clock starts before `fn` is invoked, so a search
 * function's synchronous prep (query-body construction) is included. A
 * rejection from `fn` propagates unchanged — nothing is swallowed.
 *
 * Uses `performance.now()`, which is monotonic: the measurement is immune to
 * a wall-clock adjustment landing mid-call.
 */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - start) };
}

/**
 * Serialize timing marks into a `Server-Timing` header value, e.g.
 * `taxonomy;dur=12;desc="matchQueryToTaxonomy", search;dur=140;desc="searchPeople"`.
 *
 * Marks whose `ms` is negative or non-finite are dropped, so a caller may
 * pass a sentinel for "not measured" without polluting the header. `desc` is
 * emitted as a quoted string. Returns `""` when no mark survives; a caller
 * should then skip the header rather than send an empty one.
 */
export function serverTimingHeader(marks: TimingMark[]): string {
  return marks
    .filter((m) => Number.isFinite(m.ms) && m.ms >= 0)
    .map((m) => {
      const desc = m.desc ? `;desc=${JSON.stringify(m.desc)}` : "";
      return `${m.name};dur=${m.ms}${desc}`;
    })
    .join(", ");
}
