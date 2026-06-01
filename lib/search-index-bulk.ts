/**
 * Tunable, throttle-resilient bulk-write policy for the OpenSearch index
 * rebuilds (`etl/search-index`). Extracted as pure helpers so the retry +
 * pacing policy is unit-testable without standing up OpenSearch — importing
 * `etl/search-index/index.ts` directly runs its `main()` on import (the
 * known vitest landmine, see #295/#367), so the testable logic lives here.
 *
 * Issue #626 — a single small staging node (`t3.small.search`, ~2 GB) cannot
 * absorb the people bulk rebuild at the original settings (500-doc chunks,
 * back-to-back, retrying 429 only): it rejects writes (`429`) and then goes
 * unresponsive behind its ELB (`502 Bad Gateway`). CPU sat at baseline during
 * the failures, so the bottleneck is heap / write-queue (indexing) pressure,
 * not CPU. These defaults pace the writer to what a small node can take —
 * smaller chunks, an inter-chunk pause, more retries — and treat the
 * `502/503/504` gateway family as transient (worth a backoff) like `429`,
 * instead of aborting the whole rebuild on the first hiccup. Every knob is
 * env-overridable so a well-sized prod domain (`m6g.large.search` ×2) can run
 * faster (e.g. `SEARCH_INDEX_BULK_MAX_DOCS=500`, `SEARCH_INDEX_BULK_PAUSE_MS=0`).
 */

/**
 * HTTP statuses worth retrying with backoff: `429` (throttle) plus the
 * gateway / unavailable family (`502/503/504`) a momentarily-overwhelmed node
 * returns through its load balancer. A retried chunk is idempotent — index ops
 * carry explicit `_id`s — so re-sending after a backoff is safe.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export function isRetryableBulkStatus(status: number | undefined | null): boolean {
  return status != null && RETRYABLE_STATUSES.has(status);
}

export interface BulkConfig {
  /** Soft byte budget per bulk request (headroom under the 10 MB hard limit). */
  maxBytes: number;
  /** Doc cap per bulk request. Smaller = lower per-request indexing pressure. */
  maxDocs: number;
  /** Pause between successful chunks so the node can flush. 0 disables pacing. */
  pauseMs: number;
  /** Backoff attempts per chunk before giving up. */
  maxAttempts: number;
}

export const BULK_DEFAULTS: BulkConfig = {
  maxBytes: 8 * 1024 * 1024, // headroom under OpenSearch http.max_content_length (10 MB)
  maxDocs: 150, // #626 — was 500; gentler on a small node
  pauseMs: 250, // #626 — breathe between chunks
  maxAttempts: 8, // #626 — was 6; more backoff headroom for a saturated node
};

/** Parse a positive integer env value, falling back on missing/invalid/<=0. */
function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like `positiveIntOr` but allows 0 (used by `pauseMs` to disable pacing). */
function nonNegativeIntOr(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve the bulk-write config from env, with the gentle #626 defaults. Pure:
 * takes the env map explicitly (defaulting to `process.env`) so tests don't
 * mutate global state.
 */
export function resolveBulkConfig(
  env: Record<string, string | undefined> = process.env,
): BulkConfig {
  return {
    maxBytes: positiveIntOr(env.SEARCH_INDEX_BULK_MAX_BYTES, BULK_DEFAULTS.maxBytes),
    maxDocs: positiveIntOr(env.SEARCH_INDEX_BULK_MAX_DOCS, BULK_DEFAULTS.maxDocs),
    pauseMs: nonNegativeIntOr(env.SEARCH_INDEX_BULK_PAUSE_MS, BULK_DEFAULTS.pauseMs),
    maxAttempts: positiveIntOr(env.SEARCH_INDEX_BULK_MAX_ATTEMPTS, BULK_DEFAULTS.maxAttempts),
  };
}
