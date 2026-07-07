// Shared S3-backed Next.js ISR `cacheHandler` (#1503).
//
// Why this exists: prod runs `appDesiredCount: 2` (autoscale to 6). Next's
// default ISR cache is per-task in-process, so `revalidatePath` busts only the
// one task that got the POST; CloudFront then refills the edge from a random
// task and can re-cache the stale copy for up to the route TTL. A single shared
// store fixes that: every task reads/writes the same S3 objects, and a tag
// revalidation on one task is visible to all.
//
// Design mirrors Next's own file-system-cache (node_modules/next/dist/server/
// lib/incremental-cache/file-system-cache.js): page tags live in the value's
// `x-next-cache-tags` header; an entry is stale iff any of its tags was
// revalidated at a time >= the entry's `lastModified` (Next's `isStale`). We
// keep the same semantics but back the tag timestamps + entries with S3 instead
// of the in-process `tagsManifest` + disk.
//
// Gated OFF by default (see next.config.ts / NEXT_ISR_CACHE_S3): when off, Next
// uses its built-in handler and this file is never loaded. Loaded via a runtime
// `require` from the standalone server, so it is plain CommonJS.
//
// CommonJS (not TS): Next `require`s the cacheHandler at runtime in the
// standalone bundle; it is not run through the webpack/babel build.

"use strict";

/* eslint-disable @typescript-eslint/no-require-imports --
   CommonJS by necessity: Next loads the cacheHandler via require/dynamic-import
   at runtime in the standalone server, and the repo has no "type":"module", so
   ESM `import` syntax would be invalid in this `.js` file. */

const crypto = require("node:crypto");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const TAGS_HEADER = "x-next-cache-tags"; // NEXT_CACHE_TAGS_HEADER
const PREFIX = "next-isr-cache/v1/";
const KIND_WITH_HEADER_TAGS = new Set(["APP_PAGE", "APP_ROUTE", "PAGES"]);

// Read lazily (not at module load) so config injected after import — and tests
// — take effect.
const bucket = () => process.env.NEXT_ISR_CACHE_BUCKET;
const region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
// ponytail: fixed per spec §4d. Promote to an env lever + wire it in cdk only if
// the isr_cache_s3_error logs show S3 p99 crossing it.
const TIMEOUT_MS = 250;
// ponytail: FIFO count cap, not byte-aware LRU. A page can be 100s of KB, so the
// worst-case front-cache footprint is ~FRONT_MAX * pageSize; bump to a
// byte-sized LRU only if task memory pressure shows up. It is a per-task
// optimization in front of S3 (the source of truth) — a cold task still
// converges, so correctness never depends on it.
const FRONT_MAX = 100;
const TAG_TS_TTL_MS = 2000; // cache shared tag timestamps briefly so a burst of gets doesn't hammer S3

// ---- injectable S3 client (real singleton in prod, fake in tests) ----------
let s3Override = null;
let s3Singleton = null;
function s3() {
  if (s3Override) return s3Override;
  if (!s3Singleton) {
    const r = region();
    s3Singleton = new S3Client(r ? { region: r } : {});
  }
  return s3Singleton;
}

// Immediate same-task tag revalidations (mirrors Next's module-level
// `tagsManifest`): a `revalidateTag` on this task is visible to this task's next
// `get` without an S3 round-trip. S3 carries it to the *other* tasks.
const localTagManifest = new Map();

// ---- serialization: cache values contain Buffers (rscData/body) and a
// Map (segmentData); JSON handles neither, so tag-encode them recursively. ----
function encode(v) {
  if (Buffer.isBuffer(v)) return { __t: "B", d: v.toString("base64") };
  if (v instanceof Map)
    return { __t: "M", e: Array.from(v, ([k, val]) => [k, encode(val)]) };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = encode(v[k]);
    return o;
  }
  return v; // string | number | boolean | null
}
function decode(v) {
  if (v && typeof v === "object") {
    if (v.__t === "B") return Buffer.from(v.d, "base64");
    if (v.__t === "M") return new Map(v.e.map(([k, val]) => [k, decode(val)]));
    if (Array.isArray(v)) return v.map(decode);
    const o = {};
    for (const k of Object.keys(v)) o[k] = decode(v[k]);
    return o;
  }
  return v;
}
const serialize = (entry) => JSON.stringify(encode(entry));
const deserialize = (str) => decode(JSON.parse(str));

// ---- key scheme: sha256 avoids S3 key-charset issues + fixes key length. ----
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const keyFor = (cacheKey) => PREFIX + sha(cacheKey);
const tagKeyFor = (tag) => PREFIX + "_tags/" + sha(tag);

// Tags that decide an entry's freshness. Pages carry them in the value header;
// fetch entries carry them on the stored entry (+ ctx soft/hard tags).
function tagsForEntry(entry, ctx) {
  const v = entry && entry.value;
  if (!v) return [];
  if (KIND_WITH_HEADER_TAGS.has(v.kind)) {
    const h = v.headers && v.headers[TAGS_HEADER];
    return typeof h === "string" && h ? h.split(",") : [];
  }
  if (v.kind === "FETCH") {
    const ctxTags =
      ctx && ctx.kind === "FETCH"
        ? [...(ctx.tags || []), ...(ctx.softTags || [])]
        : [];
    return Array.from(new Set([...(entry.tags || []), ...ctxTags]));
  }
  return [];
}

// Race any S3 op against a timeout so a slow/unavailable S3 never blocks a
// render. A cache miss is always safe. Aborts the request on timeout so we
// don't leak the socket.
async function withTimeout(fn) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

function logS3Error(op, keyHash, err) {
  // Structured line so a CloudWatch metric-filter can alarm when the fallback
  // path is hot. ponytail: the alarm itself is a log-metric-filter (ops/CDK),
  // not an app-side metric emitter.
  try {
    console.error(
      JSON.stringify({
        event: "isr_cache_s3_error",
        op,
        key: keyHash,
        error: err && err.message ? err.message : String(err),
      }),
    );
  } catch {
    /* never let logging throw into a render */
  }
}
const isMissing = (err) =>
  err &&
  (err.name === "NoSuchKey" ||
    err.name === "NotFound" ||
    (err.$metadata && err.$metadata.httpStatusCode === 404));

class S3CacheHandler {
  constructor(ctx) {
    // Next passes the per-request revalidated tags here; honor them for
    // instant same-request consistency (matches IncrementalCache).
    this.revalidatedTags = (ctx && ctx.revalidatedTags) || [];
    this.front = S3CacheHandler.front;
    this.tagTsCache = S3CacheHandler.tagTsCache;
  }

  frontSet(key, entry) {
    if (this.front.size >= FRONT_MAX && !this.front.has(key)) {
      this.front.delete(this.front.keys().next().value); // evict oldest
    }
    this.front.set(key, entry);
  }

  async loadEntry(key) {
    const hit = this.front.get(key);
    if (hit) return hit;
    const b = bucket();
    if (!b) return null;
    const hash = key.slice(PREFIX.length);
    try {
      const res = await withTimeout(
        (signal) =>
          s3().send(
            new GetObjectCommand({ Bucket: b, Key: key }),
            { abortSignal: signal },
          ),
      );
      const entry = deserialize(await res.Body.transformToString());
      this.frontSet(key, entry);
      return entry;
    } catch (err) {
      if (!isMissing(err)) logS3Error("get", hash, err);
      return null; // miss is always safe; never throw
    }
  }

  // max(local same-task revalidation, shared S3 revalidation) for a tag.
  async tagTimestamp(tag) {
    const local = localTagManifest.get(tag) || 0;
    const b = bucket();
    if (!b) return local;
    const cached = this.tagTsCache.get(tag);
    if (cached && Date.now() - cached.at < TAG_TS_TTL_MS) {
      return Math.max(local, cached.t);
    }
    let t = 0;
    try {
      const res = await withTimeout(
        (signal) =>
          s3().send(
            new GetObjectCommand({ Bucket: b, Key: tagKeyFor(tag) }),
            { abortSignal: signal },
          ),
      );
      t = JSON.parse(await res.Body.transformToString()).t || 0;
    } catch (err) {
      if (!isMissing(err)) logS3Error("getTag", tag, err);
      // missing tag object => never revalidated => 0
    }
    this.tagTsCache.set(tag, { t, at: Date.now() });
    return Math.max(local, t);
  }

  async get(key, ctx) {
    const entry = await this.loadEntry(keyFor(key));
    if (!entry) return null;
    const tags = tagsForEntry(entry, ctx);
    if (tags.length) {
      // instant same-request revalidation
      if (tags.some((t) => this.revalidatedTags.includes(t))) return null;
      for (const tag of tags) {
        const revAt = await this.tagTimestamp(tag);
        if (revAt && revAt >= (entry.lastModified || Date.now())) return null; // stale
      }
    }
    return { value: entry.value, lastModified: entry.lastModified };
  }

  async set(key, data, ctx) {
    const entry = {
      value: data,
      lastModified: Date.now(),
      tags: ctx && ctx.fetchCache ? ctx.tags || [] : [],
    };
    const k = keyFor(key);
    this.frontSet(k, entry);
    const b = bucket();
    if (!b || !data) return; // nothing durable to write (mirrors FS flushToDisk guard)
    const hash = k.slice(PREFIX.length);
    try {
      await withTimeout(
        (signal) =>
          s3().send(
            new PutObjectCommand({
              Bucket: b,
              Key: k,
              Body: serialize(entry),
              ContentType: "application/json",
            }),
            { abortSignal: signal },
          ),
      );
    } catch (err) {
      logS3Error("set", hash, err); // entry stays in this task's front cache; never block the response
    }
  }

  async revalidateTag(tags) {
    tags = typeof tags === "string" ? [tags] : tags;
    if (!tags || !tags.length) return;
    const now = Date.now();
    for (const tag of tags) {
      localTagManifest.set(tag, now); // instant on this task
      this.tagTsCache.set(tag, { t: now, at: now }); // don't re-read our own write for TTL
      const b = bucket();
      if (!b) continue;
      try {
        await withTimeout(
          (signal) =>
            s3().send(
              new PutObjectCommand({
                Bucket: b,
                Key: tagKeyFor(tag),
                Body: JSON.stringify({ t: now }),
                ContentType: "application/json",
              }),
              { abortSignal: signal },
            ),
        );
      } catch (err) {
        // falls back to reflecting at the route TTL; never 500 the edit path
        logS3Error("revalidateTag", tag, err);
      }
    }
  }

  resetRequestCache() {}
}

// Shared across handler instances within a task (Next constructs the handler
// per IncrementalCache; the front + tag caches must persist across requests).
S3CacheHandler.front = new Map();
S3CacheHandler.tagTsCache = new Map();

module.exports = S3CacheHandler;
// Test-only surface (unused by Next at runtime).
module.exports.__test = {
  encode,
  decode,
  serialize,
  deserialize,
  keyFor,
  tagKeyFor,
  tagsForEntry,
  localTagManifest,
  setS3Client: (c) => {
    s3Override = c;
  },
  reset: () => {
    s3Override = null;
    s3Singleton = null;
    localTagManifest.clear();
    S3CacheHandler.front.clear();
    S3CacheHandler.tagTsCache.clear();
  },
  // Wipe only the per-task caches (front + tag TTL + local manifest), keeping
  // the injected S3 client — simulates a *different* task pointed at the same
  // shared store, for cross-task propagation tests.
  clearTaskCaches: () => {
    localTagManifest.clear();
    S3CacheHandler.front.clear();
    S3CacheHandler.tagTsCache.clear();
  },
  get BUCKET() {
    return bucket();
  },
};
