# SPEC — Shared S3 `cacheHandler` for multi-task ISR (#1503)

**Status:** DRAFT — for sign-off before the handler is built.
**Issue:** #1503. **Next.js:** 15.5.15 (App Router, `output: "standalone"`). **Author:** review-remediation (2026-07-07).
**Decision already made:** shared Next.js `cacheHandler` backed by **S3** (not ElastiCache, not task-IP fan-out). This spec designs it; the interim mitigation has already landed (see §7).

---

## 1. Problem

Prod runs `appDesiredCount: 2`, autoscaling to `appMaxCount: 6` (`cdk/lib/config.ts`). Next's default ISR cache is an **in-process, per-task** store. So:

- `revalidatePath(path)` — from the ETL webhook (`app/api/revalidate/route.ts`) or curator edits (`lib/edit/revalidation.ts` `reflect*`) — mutates the ISR store of **only the one task** that received the POST.
- The CloudFront invalidation that follows purges the edge, then the edge refills from a **random** task — which may be one whose ISR store was never busted, so it re-caches the **stale** copy for up to the route's `revalidate` TTL.

Net: on-demand revalidation is unreliable with >1 task. Confirmed real on master `5f5d275f` (review finding, #1503).

**Path-based only.** The codebase uses `revalidatePath` exclusively — **no** `revalidateTag`, `cacheTag`, or `next: { tags }` anywhere (audited: `git grep -n 'revalidateTag\|cacheTag\|next: *{ *tags' origin/master`). The only `unstable_cache` use is `lib/api/usage-summary.ts` (keyed, not tagged). This matters for §4.

## 2. Goals / non-goals

**Goals**
- All app tasks read/write **one shared** ISR store, so the edge cannot refill a stale copy from a non-revalidated task.
- `revalidatePath` propagates to every task (edits reflect within seconds, not at the next TTL).
- No render ever blocks or 500s on the cache backend being slow/unavailable.

**Non-goals**
- Replacing `lib/api/swr-cache.ts` (the separate in-memory Map that serves center/dept/div rollups). That layer's missing invalidation is **#1537 (E5)**, tracked separately — it is *not* Next ISR and this handler does not touch it.
- Fixing the fully-dynamic org-unit routes (`/departments/[slug]`, `/centers/[slug]`, divisions) whose `revalidate` export is inert because they `await searchParams`. A `cacheHandler` cannot help a route that opts out of the Data Cache; that's a separate routing decision.

## 3. Decision & rationale (recap)

S3-backed shared `cacheHandler`. Rationale (per the #1503 decision): cheapest durable shared store; strongly read-after-write consistent (S3 since Dec 2020); and since CloudFront fronts the app, read latency is mostly off the user path (only on edge miss / regeneration). ElastiCache is reserved for *if* heavy tag fan-out later proves it — a standing Redis service is hard to justify for a correctness bug an object store fixes. Task-IP fan-out is racy under autoscale and rejected.

## 4. Design

### 4a. Key scheme & region
- Next passes the handler an opaque **cache key** (a hash of the route + params). Store each entry at `s3://<cacheBucket>/<prefix>/<sha256(key)>` where `<prefix>` = `next-isr-cache/v1/<deployId>/` (**#1846** — `<deployId>` = `NEXT_DEPLOYMENT_ID`, the deploying commit SHA, surfaced as a runtime env by the Dockerfile runtime stage). Namespacing per deploy stops a new image reading the previous image's entry for a TTL-less static page; all tasks of one deploy share a namespace, and the `next-isr-cache/` lifecycle drains old ones. The sha256 avoids S3 key-charset issues and gives fixed-length keys.
- **Region** = the app's region (from `AWS_REGION`, already in the task env). Same-region S3 keeps get latency low.
- Object body = JSON `{ value, lastModified, tags }` where `value` is Next's serialized cache entry (page/RSC/fetch payload) and `tags` is the entry's tag list (see 4b). Large HTML/RSC payloads are fine for S3.

### 4b. How `revalidatePath` routes through the handler (the crux)
Even though app code only calls `revalidatePath`, App Router implements it by deriving an **implicit tag** from the path and calling the cacheHandler's `revalidateTag(tag)`. So the handler must make a tag revalidation on one task visible to all tasks. Two ways to implement, on a shared store:

1. **Tag → reverse-index of keys** (write a per-tag object listing its keys; on `revalidateTag`, load it and delete/tombstone each key). More objects, more write amplification, and races on the index under concurrency.
2. **Tag → last-revalidated timestamp map (RECOMMENDED).** Maintain a small shared map `tag → revalidatedAt`. Each stored entry carries its `tags` + `lastModified`. On `get(key)`, the entry is **stale** iff `max(revalidatedAt[t] for t in entry.tags) > entry.lastModified`. `revalidateTag(t)` is then just "write `revalidatedAt[t] = now`" — O(1), no reverse index, no key enumeration. This is the `@neshca/cache-handler` pattern and it fits path-based revalidation perfectly (few distinct path tags).

The timestamp map is small (one entry per distinct revalidated path ≈ tens–hundreds). Store it as a single S3 object `next-isr-cache/v1/_tags.json` (read-modify-write under a short in-process cache, see 4c), or — if write contention on one object is a concern — one tiny object per tag (`_tags/<sha256(tag)>` containing a timestamp), read on demand. **Recommend per-tag objects**: no read-modify-write race, and `get` only needs the handful of tags on the entry it's checking.

### 4c. Latency & the in-process front cache
Reading S3 (entry + its tag timestamps) on every ISR `get` adds ~10–30 ms. Mitigate with a **composite**: a small in-process LRU in front of S3 (the today-behavior store), used as a read-through cache with a short internal freshness (e.g. 1–5 s) for the tag-timestamp objects so a burst of gets doesn't hammer S3. The in-process layer is an optimization only — S3 is the source of truth; a cold task still converges. (Build-vs-buy: prefer a maintained composite handler — `@neshca/cache-handler` / its `@fortedigital` fork — with a custom S3 handler, over hand-rolling the LRU+remote+tag logic, which is a known bug farm. Evaluate the adapter's Next 15.5 compatibility first; if it's not solid, hand-roll the minimal handler in §4a/4b.)

### 4d. Failure mode when S3 is slow/unavailable
Wrap every S3 `get`/`set`/`revalidateTag` in a **timeout (≈250 ms) + try/catch**:
- `get` fails/times out → return the in-process entry if present, else `null` (Next regenerates). **Never throw** — a cache miss is always safe.
- `set` fails → log and drop (the entry stays only in-process for that task; today's behavior). Never block the response.
- `revalidateTag` fails → log; the edit falls back to reflecting at the route TTL (now 2h after the §7 interim). Never 500 the edit API.
- Emit a structured `event: "isr_cache_s3_error"` log with op + key hash + error, and a CloudWatch metric so we can alarm if the fallback path is hot.

### 4e. Migration & rollout flag
- Config gated: `next.config.ts` sets `cacheHandler` + `cacheMaxMemorySize: 0` **only when** `process.env.NEXT_ISR_CACHE_S3 === "on"`. Off → today's built-in FS/in-memory handler, byte-identical behavior.
- **`cacheHandler` is a BUILD-time config, not runtime.** `output: standalone` bakes the resolved config into the image (`__NEXT_PRIVATE_STANDALONE_CONFIG`); the runtime server never re-evaluates `next.config.ts`. So the flag must be present at `next build`, i.e. it is passed as a **Docker `--build-arg NEXT_ISR_CACHE_S3`** (Dockerfile `ARG`/`ENV`), set **per env by the Deploy workflow** (`.github/workflows/deploy.yml`): staging soaks it `on`, prod stays `off` until the soak passes. A runtime task-def env can **not** flip it — the original design (a task-def literal + `cdk deploy`) was a no-op and is corrected here (#1503 wiring fix).
- The gate is deliberately **not** conditioned on the bucket env: `NEXT_ISR_CACHE_BUCKET` is `isrCacheBucket.bucketName`, a CloudFormation ref only resolved at deploy time, so it can never be present at build. The bucket name is wired as a **task-def env** (runtime) and the handler reads it at module load, no-opping its S3 path if it is ever absent.
- Provisioning order to enable an env: (1) `cdk deploy Sps-App-<env>` to create the `IsrCacheBucket` + wire `NEXT_ISR_CACHE_BUCKET` into the task def; (2) build+deploy an image with `NEXT_ISR_CACHE_S3=on` for that env (the workflow's per-env policy). Do (1) before (2) so the handler isn't briefly compiled-in with no bucket to reach.
- **Phased** (de-risks the tag propagation): **Phase 1** — shared S3 `get`/`set`, `revalidateTag` best-effort. This alone kills the core divergence (one store → the edge can't refill a stale copy from another task); edits still reflect within the (shortened) route TTL. **Phase 2** — turn on the shared tag-timestamp propagation (4b) so edits reflect within seconds. Ship Phase 1, soak on staging, then Phase 2.

### 4f. Infra prerequisite (BLOCKER — must land first)
There is currently **no writable S3 bucket wired to the app task** (`analyticsBucket` is read-only + `athena-results/*` write; `staticAssetsBucket`/`logsBucket` are Edge-owned). The handler needs one of:
- (recommended) a **dedicated `isrCacheBucket`** in `AppStack` — private, SSE-S3, a **lifecycle rule expiring objects after e.g. 7 days** (bounds cost; stale entries self-clean), and an IAM grant to the app task role for `s3:GetObject`/`PutObject`/`DeleteObject` on `next-isr-cache/*` + `s3:ListBucket` scoped to that prefix. Pass the bucket name to the task as `NEXT_ISR_CACHE_BUCKET`.
- or reuse `analyticsBucket` under a new `next-isr-cache/*` prefix with the same scoped grants (fewer resources, but mixes concerns + shares a lifecycle policy — prefer the dedicated bucket).

## 5. Testing
- Unit: the handler's `get`/`set`/`revalidateTag` against a mocked S3 client — freshness math (entry stale iff a tag was revalidated after `lastModified`), the timeout/try-catch fallback (S3 throws → `get` returns in-process/null, never throws), key hashing.
- Integration (staging): edit a curated field → hit the page repeatedly through CloudFront from multiple tasks → confirm no task serves the pre-edit copy after the propagation delay; confirm S3 objects appear under the prefix.
- Load/latency: measure `get` p50/p99 with the in-process front on/off; confirm regeneration stays background (SWR) and TTFB is unaffected on the hot profile/topic/search paths (the #695/#1297 warmup concerns).

## 6. Rollback
Set the env's `NEXT_ISR_CACHE_S3` build-arg back to `off` in the Deploy workflow + redeploy (rebuilds the image with `cacheHandler` unset) → the default FS/in-memory handler returns; no data migration (ISR cache is derived, disposable). Faster kill-switch without a rebuild: remove the `NEXT_ISR_CACHE_BUCKET` task-def env (or empty the bucket) → the compiled-in handler no-ops its S3 path. The lifecycle rule drains the bucket. Fully reversible.

## 7. Interim (LANDED with this spec)
The interim ships in the same PR to reduce the staleness window now:
- **CF-after-revalidate ordering** — already correct on master: `reflect*` call `revalidatePaths()` first, then `invalidateCloudFront()` (which enqueues a durable outbox row synchronously and defers the CloudFront send via `runAfterResponse`, with the #353 reconciler as backstop). **No change needed.**
- **ISR TTL cut** — `/` and `/topics/[slug]` cut from **6h → 2h** (`app/page.tsx`, `app/(public)/topics/[slug]/page.tsx`), bounding the cross-task staleness window ~3×. Not cut deeper because `/topics/[slug]` regeneration runs the `getDistinctScholarCountForTopic` groupBy (#1514 E6), so a bigger cut amplifies a known-heavy query. `/browse` (1h) is already short; sitemap/co-pubs (24h) are low-change / high-regen-cost and left as-is.

## 8. Open questions for sign-off
1. **Dedicated `isrCacheBucket` vs `analyticsBucket` prefix?** (Recommend dedicated.)
2. **Bucket lifecycle expiry** — 7 days OK, or tie to the longest route TTL (24h) + margin?
3. **Build-vs-buy** — OK to evaluate `@neshca/cache-handler` (+ S3 adapter) before hand-rolling? A maintained composite avoids the LRU+remote+tag bug surface, at the cost of one dependency.
4. **Phase 1 only, or 1+2 together?** Phase 1 fixes the divergence; Phase 2 adds seconds-latency edit reflection. Recommend shipping Phase 1 first, soak, then Phase 2.
5. Interim TTL values — 2h acceptable for `/` and `/topics/[slug]`, or tune?
