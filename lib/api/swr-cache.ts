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
 *
 * #1537 — `bust()` only clears the Map on the task that handled the edit; prod
 * runs 2-6 app tasks, so the other tasks kept serving the pre-edit rollup for up
 * to MAX_STALE_MS. Fix: a lightweight cross-task bust SIGNAL, modeled on (not
 * imported from — that file is CJS for Next's cacheHandler loader) the
 * DEPLOY_NS-namespaced, fail-open S3 pattern in lib/cache/s3-cache-handler.js.
 * Reuses that same NEXT_ISR_CACHE_BUCKET env var; if it's unset (local/CI/no
 * bucket configured) this whole signal is a no-op and behavior is byte-identical
 * to before. `bust(prefix)` best-effort writes a "busted-at" marker to S3;
 * `cachedRead` cheaply checks (in-process TTL-cached, mirrors TAG_TTL_MS) whether
 * a newer marker exists before trusting a local fresh hit. Never blocks a render
 * on S3, never throws out of `bust()` — a missed cross-task signal just falls
 * back to today's MAX_STALE_MS ceiling.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

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

// --- #1537 cross-task bust signal (see file header) -----------------------

const BUCKET = process.env.NEXT_ISR_CACHE_BUCKET;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const s3Client = BUCKET ? new S3Client({ region: REGION }) : null;

// Same deploy-namespacing rationale as lib/cache/s3-cache-handler.js #1846: a
// new image must not read a previous image's marker.
const DEPLOY_NS = process.env.NEXT_DEPLOYMENT_ID || "nodeploy";
const PREFIX = `swr-cache-bust/v1/${DEPLOY_NS}`;
const S3_TIMEOUT_MS = 250; // per-op ceiling; a miss/failure is always safe
const EPOCH_TTL_MS = 3000; // in-process freshness for the bust-epoch check

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bustS3Key = (prefix: string) => `${PREFIX}/${sha(prefix)}`;

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const n = e && (e.name || e.Code || e.code);
  return n === "NoSuchKey" || n === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

// Hard-timeout wrapper mirroring s3-cache-handler.js's withTimeout: rejects if
// the op outruns `ms`, so every caller's try/catch can fall open.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error("s3-timeout")), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

// cachedRead keys are `${entityKind}:${...}`, and every existing bust() caller
// passes exactly that kind prefix (e.g. "center:", "methods:") — so the kind
// segment is the natural, already-matching granularity for the cross-task
// signal too.
export function bustPrefixOf(key: string): string {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i + 1);
}

// Last-known "busted-at" epoch for `prefix` (0 = never seen), cached
// in-process for EPOCH_TTL_MS so a burst of reads doesn't hammer S3 (mirrors
// tagRevalidatedAt in s3-cache-handler.js). Fails open: a timed-out/failed
// fetch keeps the previously-known epoch (defaulting to 0 the first time),
// i.e. never manufactures a bust signal that didn't arrive.
const bustEpochCache = new Map<string, { ts: number; at: number }>();
async function bustEpochFor(prefix: string): Promise<number> {
  const now = Date.now();
  const cached = bustEpochCache.get(prefix);
  if (cached && now - cached.at < EPOCH_TTL_MS) return cached.ts;
  let ts = cached ? cached.ts : 0;
  try {
    const res = await withTimeout(
      s3Client!.send(new GetObjectCommand({ Bucket: BUCKET, Key: bustS3Key(prefix) })),
      S3_TIMEOUT_MS,
    );
    const body = await withTimeout(res.Body!.transformToString(), S3_TIMEOUT_MS);
    const parsed = JSON.parse(body) as { bustedAt?: number };
    ts = Number(parsed.bustedAt) || 0;
  } catch (err) {
    if (!isNotFound(err)) {
      // swallow — fail open, keep the previously-known epoch
    }
  }
  bustEpochCache.set(prefix, { ts, at: now });
  return ts;
}

/**
 * Pure freshness predicate (unit-tested directly, mirrors `computeStale` in
 * lib/cache/s3-cache-handler.js): a cached entry is busted iff a cross-task
 * bust marker for its prefix was written strictly after the entry was cached.
 * `epochTs` of 0 means "no marker ever seen" (fail-open default).
 */
export function computeBusted(entryTs: number, epochTs: number): boolean {
  return epochTs > entryTs;
}

/** True iff a cross-task bust for this key's prefix landed after `entryTs`. */
async function isBustedSince(key: string, entryTs: number): Promise<boolean> {
  const epoch = await bustEpochFor(bustPrefixOf(key));
  return computeBusted(entryTs, epoch);
}

// Best-effort marker write; never throws (bust() is sync/fire-and-forget on
// the edit-reflection path and must not turn this into a 500).
function writeBustMarker(prefix: string): void {
  if (!s3Client) return;
  void withTimeout(
    s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: bustS3Key(prefix),
        Body: JSON.stringify({ bustedAt: Date.now() }),
        ContentType: "application/json",
      }),
    ),
    S3_TIMEOUT_MS,
  ).catch(() => {
    // best-effort — a slow/unavailable S3 falls back to today's MAX_STALE_MS
    // ceiling on the other tasks, never surfaces to the caller
  });
}

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

/**
 * Drop every cached + inflight entry whose key starts with `prefix`. The edit
 * reflection path (`lib/edit/revalidation.ts`) calls this so a curator edit
 * doesn't keep serving a stale Map entry for up to MAX_STALE_MS after the
 * ISR/CDN busts — the origin task reads through this Map, which `revalidatePath`
 * and the CloudFront invalidation never touch (#1537).
 *
 * ponytail (full): coarse per-prefix bust — a single center edit evicts every
 * `center:*` entry, not just the edited one. Edits are rare superuser actions
 * and cachedRead's inflight dedup collapses the reload, so the blunt sweep is
 * cheaper than threading entity codes/pages/sorts through the reflection path.
 * Upgrade path: pass exact (entity, page, sort) keys if edit frequency ever
 * makes the reload storm measurable.
 */
export function bust(prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
  for (const key of inflight.keys()) if (key.startsWith(prefix)) inflight.delete(key);
  // #1537 — signal the bust to the other app tasks. No-op when NEXT_ISR_CACHE_BUCKET
  // is unset (local/CI); best-effort and never throws otherwise.
  writeBustMarker(prefix);
}

export function cachedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (BYPASS) return load();
  const hit = store.get(key) as Entry<T> | undefined;
  if (!hit) return refresh(key, load);
  const age = Date.now() - hit.ts;
  if (age < FRESH_MS) {
    // #1537 — a local "fresh" hit can still be stale if another task busted
    // this prefix after this entry was cached. Skipped entirely when the S3
    // bucket isn't configured (BUCKET falsy) — same behavior as before this fix.
    if (!BUCKET) return Promise.resolve(hit.data);
    return isBustedSince(key, hit.ts).then((busted) =>
      busted ? refresh(key, load) : hit.data,
    );
  }
  if (age < MAX_STALE_MS) {
    // Stale-while-revalidate: kick off a refresh, swallow its failure (we're
    // serving the still-acceptable stale value either way).
    void refresh(key, load).catch(() => {});
    return Promise.resolve(hit.data);
  }
  return refresh(key, load); // too stale — block on fresh
}
