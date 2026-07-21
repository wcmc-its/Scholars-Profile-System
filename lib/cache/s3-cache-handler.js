/* eslint-disable @typescript-eslint/no-require-imports -- Next loads the
   cacheHandler via `require` from the standalone server at boot; this file must
   be CommonJS, so `require`/`module.exports` are required, not a style choice. */
// Shared S3-backed Next.js ISR cacheHandler (#1503).
//
// Problem it fixes: prod runs 2–6 app tasks (`appDesiredCount`/`appMaxCount`),
// and Next's default incremental cache is an in-process, per-task store. So
// `revalidatePath` busts only the one task that received the POST; the
// CloudFront invalidation that follows then refills the edge from a *random*
// task, which may re-cache a stale copy for up to the route TTL. This handler
// makes every task read/write ONE S3 store, and propagates revalidation via a
// shared tag→last-revalidated-timestamp map: an entry is stale iff any of its
// tags was revalidated *after* the entry was written. `revalidatePath` reaches
// here as an implicit path tag, so path-based revalidation propagates too.
//
// Whether this handler is wired at all is a BUILD-time decision in
// next.config.ts (`NEXT_ISR_CACHE_S3 === "on"`, supplied per env as a Docker
// build-arg — standalone bakes the config, so it cannot be flipped at runtime;
// see §4e of docs/1503-shared-cachehandler-spec.md). Off → Next's default
// FS/in-memory handler, byte-identical to today. At runtime this handler
// additionally no-ops its S3 path if NEXT_ISR_CACHE_BUCKET is unset.
//
// Fail-open (§4d): every S3 op has a hard timeout + try/catch and degrades to
// the in-process front (or a cache miss, which Next handles by regenerating).
// A slow or unavailable S3 must never throw into a render or 500 an edit — a
// cache miss is always safe.
//
// CJS on purpose: Next loads the cacheHandler via `require` from the standalone
// server at boot; it cannot be an ESM/TS module.

const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { createHash } = require("crypto");

// #1846 — namespace the store per deploy. The entry key is `sha(pathname)` with
// no build identity, so without this a new image reads the PREVIOUS image's
// entry for a static page (no revalidate TTL, no tag) and serves it stale until
// the 7-day lifecycle or an incidental S3 miss. NEXT_DEPLOYMENT_ID (the deploying
// commit SHA) is the same for every task of a deployment (one image, one
// build-arg), so cross-task sharing within a deploy is preserved while each new
// deploy starts a clean namespace; the `next-isr-cache/` lifecycle rule drains
// the old ones. It must be a RUNTIME env — the Dockerfile runtime stage
// re-declares the build-arg and exports it (the build-stage ENV does not cross
// the FROM boundary). Empty (local/CI, where there is no bucket anyway) → a
// stable fallback segment.
const DEPLOY_NS = process.env.NEXT_DEPLOYMENT_ID || "nodeploy";
const PREFIX = `next-isr-cache/v1/${DEPLOY_NS}`;
const S3_TIMEOUT_MS = 250; // per-op ceiling; a miss is always safe
const TAG_TTL_MS = 3000; // in-process freshness for tag timestamps (§4c)
const ENTRY_LRU_MAX = 1000; // in-process entry front cache

const BUCKET = process.env.NEXT_ISR_CACHE_BUCKET;
const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const entryS3Key = (key) => `${PREFIX}/${sha(key)}`;
const tagS3Key = (tag) => `${PREFIX}/_tags/${sha(tag)}`;

function isNotFound(err) {
  const n = err && (err.name || err.Code || err.code);
  return (
    n === "NoSuchKey" ||
    n === "NotFound" ||
    (err && err.$metadata && err.$metadata.httpStatusCode === 404)
  );
}

// Hard-timeout wrapper: rejects if the underlying op outruns `ms`, so every
// caller's try/catch can fall open. clearTimeout so the timer never leaks.
function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("s3-timeout")), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function logErr(op, keyOrTag, err) {
  try {
    // Structured so a CloudWatch metric filter can alarm if the fallback path
    // runs hot (§4d). Hash the key so no route/params leak into logs.
    console.error(
      JSON.stringify({
        event: "isr_cache_s3_error",
        op,
        key: keyOrTag ? sha(keyOrTag).slice(0, 12) : undefined,
        error: String((err && err.message) || err),
      }),
    );
  } catch {
    // logging must never throw
  }
}

// Buffers appear inside IncrementalCacheValue (RSC payloads, ROUTE/IMAGE
// bodies). JSON.stringify already turns a Buffer into {type:"Buffer",data:[…]}
// via Buffer.prototype.toJSON; this reviver turns that back into a Buffer on
// read. Correct round-trip with zero custom encode.
// ponytail: byte-array JSON is ~5× larger than base64 for big RSC payloads.
// If S3 object size becomes a cost/latency issue, swap in a base64 replacer/
// reviver pair. Correctness first — this stays lossless.
function reviveBuffers(_key, value) {
  if (value && value.type === "Buffer" && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

/**
 * Pure freshness predicate (unit-tested directly). An entry is stale iff any
 * of its tags — the tags captured at `set` plus the implicit tags Next passes
 * on `get` (ctx.tags / ctx.softTags, e.g. the path tag from revalidatePath) —
 * has a revalidated-at timestamp strictly greater than the entry's
 * lastModified. `tagTimestamps` maps tag → epoch-ms (missing = never = 0).
 */
function computeStale(entry, ctxTags, tagTimestamps) {
  const tags = new Set([...(entry.tags || []), ...(ctxTags || [])]);
  for (const t of tags) {
    if ((tagTimestamps[t] || 0) > entry.lastModified) return true;
  }
  return false;
}

// Factory so tests can inject a fake S3 client + clock; the default export
// (Next's entry point) wires the real ones from module env. State (LRU + tag
// cache) lives per-instance — Next constructs the handler once per process.
function createHandler({
  client,
  bucket,
  now = () => Date.now(),
} = {}) {
  const entryLru = new Map(); // cacheKey → {value,lastModified,tags}
  const tagCache = new Map(); // tag → {ts, at}

  function lruSet(k, v) {
    entryLru.delete(k);
    entryLru.set(k, v);
    if (entryLru.size > ENTRY_LRU_MAX) {
      entryLru.delete(entryLru.keys().next().value);
    }
  }

  async function getJson(key, reviver) {
    const res = await withTimeout(
      client.send(new GetObjectCommand({ Bucket: bucket, Key: key })),
      S3_TIMEOUT_MS,
    );
    const body = await withTimeout(res.Body.transformToString(), S3_TIMEOUT_MS);
    return JSON.parse(body, reviver);
  }

  async function putJson(key, obj) {
    await withTimeout(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(obj),
          ContentType: "application/json",
        }),
      ),
      S3_TIMEOUT_MS,
    );
  }

  // last-revalidated timestamp for a tag (0 = never), cached in-process for
  // TAG_TTL_MS so a burst of gets doesn't hammer S3. This TTL is the
  // cross-task propagation delay: after task A revalidates, task B sees it
  // within ≤ TAG_TTL_MS. ponytail: 3s is the known ceiling — lower it if edits
  // must reflect faster, at the cost of more S3 GETs per render.
  async function tagRevalidatedAt(tag) {
    const t = now();
    const cached = tagCache.get(tag);
    if (cached && t - cached.at < TAG_TTL_MS) return cached.ts;
    let ts = 0;
    try {
      const obj = await getJson(tagS3Key(tag));
      ts = Number(obj && obj.revalidatedAt) || 0;
    } catch (err) {
      if (!isNotFound(err)) logErr("tagGet", tag, err);
      // NotFound → never revalidated → ts stays 0
    }
    tagCache.set(tag, { ts, at: t });
    return ts;
  }

  async function collectTagTimestamps(entry, ctxTags) {
    const tags = new Set([...(entry.tags || []), ...(ctxTags || [])]);
    const map = {};
    for (const tag of tags) map[tag] = await tagRevalidatedAt(tag);
    return map;
  }

  return {
    async get(cacheKey, ctx) {
      const ctxTags = (ctx && (ctx.tags || ctx.softTags)) || [];
      let entry = entryLru.get(cacheKey);
      if (!entry && client) {
        try {
          entry = await getJson(entryS3Key(cacheKey), reviveBuffers);
          if (entry) lruSet(cacheKey, entry);
        } catch (err) {
          if (!isNotFound(err)) logErr("get", cacheKey, err);
          return null; // miss → Next regenerates; never throw
        }
      }
      if (!entry) return null;
      try {
        const ts = client ? await collectTagTimestamps(entry, ctxTags) : {};
        if (computeStale(entry, ctxTags, ts)) {
          entryLru.delete(cacheKey);
          return null;
        }
      } catch (err) {
        logErr("staleCheck", cacheKey, err);
        // fail-open: serve what we have rather than 500
      }
      return { value: entry.value, lastModified: entry.lastModified };
    },

    async set(cacheKey, data, ctx) {
      const entry = { value: data, lastModified: now(), tags: (ctx && ctx.tags) || [] };
      lruSet(cacheKey, entry); // in-process always (today's behavior)
      if (!client) return;
      try {
        await putJson(entryS3Key(cacheKey), entry);
      } catch (err) {
        logErr("set", cacheKey, err); // drop; entry stays in-process only
      }
    },

    async revalidateTag(tags) {
      const t = now();
      const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
      for (const tag of list) {
        tagCache.set(tag, { ts: t, at: t }); // in-process immediate
        if (!client) continue;
        try {
          await putJson(tagS3Key(tag), { revalidatedAt: t });
        } catch (err) {
          logErr("revalidateTag", tag, err); // falls back to route TTL
        }
      }
    },

    resetRequestCache() {},
  };
}

const defaultClient = BUCKET ? new S3Client({ region: REGION }) : null;

// Next's entry point: `new CacheHandler(ctx)` then get/set/revalidateTag/…
class S3CacheHandler {
  constructor() {
    this._h = createHandler({ client: defaultClient, bucket: BUCKET });
  }
  get(cacheKey, ctx) {
    return this._h.get(cacheKey, ctx);
  }
  set(cacheKey, data, ctx) {
    return this._h.set(cacheKey, data, ctx);
  }
  revalidateTag(tags) {
    return this._h.revalidateTag(tags);
  }
  resetRequestCache() {
    return this._h.resetRequestCache();
  }
}

module.exports = S3CacheHandler;
// test hooks (not used by Next)
module.exports.createHandler = createHandler;
module.exports.computeStale = computeStale;
module.exports.reviveBuffers = reviveBuffers;
module.exports._sha = sha;
