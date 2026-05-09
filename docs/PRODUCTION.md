# Production deployment & operations

This is the operational counterpart to the local-dev `README.md`. It describes the shape we're targeting in production, why each piece is there, and — most importantly — how the system absorbs load (bot crawls, search-engine indexing, traffic spikes) without falling over the way `next dev` does on a developer laptop.

The headline reason this matters: during development we observed `/topics/{slug}` responses dropping from ~150 ms to 30+ seconds after the dev server had compiled dozens of routes interleaved with concurrent requests. That is a **`next dev` artifact**, not a code regression. Production builds (`next build` + `next start`) and the runbook below sidestep it entirely. This document explains the moving parts and the load-shedding model so the prod deploy never lives or dies on a single Node process the way a dev box does.

> **Companion docs:** [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) covers auth/secrets, ETL orchestration, and schema-migration policy — the three areas this document underspecifies. [`PRODUCTION_BACKLOG.md`](./PRODUCTION_BACKLOG.md) tracks the production-readiness work as P0/P1/P2 issues.

## Why `next dev` is not production

`next dev --turbopack` runs the bundler in-process and recompiles routes on demand. Under any real concurrency it spends CPU on module-graph rebuilds and queues requests behind them. Symptoms:

- Each new route compiles only when first requested. First-hit latency is high, queued behind the compile.
- Cached HMR state can stale-bind to a previous module shape after enough hot reloads, and the resulting work is wasted.
- A burst of traffic (a crawler enumerating `/scholars/*`, for example) kicks every per-route compile in turn. Tail latency goes from sub-second to tens of seconds.
- The dev server holds a single Prisma client and a single connection pool. Under sustained load they exhaust.

`next build` produces a static + on-demand-rendered bundle with **no compilation at request time**. `next start` serves it. This document assumes the production deployment never runs `next dev`.

## Architecture (target)

Reading order: edge → app → data → background.

```
                    ┌─────────────────────────┐
                    │  CloudFront (CDN)       │  ← caches HTML and the JSON it depends on
                    │  + AWS WAF              │     using the s-maxage from each route
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  ALB                     │  ← TLS termination, health checks
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  ECS Fargate             │  ← `next start` (Node 22)
                    │  task: scholars-app      │     2+ tasks min, autoscaled on RPS
                    │  image: ghcr.io/.../app  │     and Active CPU
                    └────┬───────────┬────────┘
                         │           │
                         │           └──────────► OpenSearch Service (managed)
                         │                         autocomplete + search
                         ▼
                    ┌─────────────────────────┐
                    │  Aurora MySQL (RDS)     │  ← Prisma client per task
                    │  reader endpoint        │     read-mostly profile pages
                    │  writer endpoint        │     writes via /api/edit only
                    └─────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │ Background pipeline (separate from the request path)      │
  │                                                           │
  │  EventBridge (cron) → Lambda → ETL job → Aurora           │
  │                              → revalidate /api/revalidate │
  │                                                           │
  │  ETL jobs (one Lambda per source, daily/weekly per spec): │
  │    ed, asms, infoed, reciter, dynamodb, hierarchy,        │
  │    spotlight, completeness, search-index                  │
  └──────────────────────────────────────────────────────────┘
```

Notes on the choices:

- **`next start` on Fargate, not Lambda.** The app is `output: "standalone"`-friendly Next.js but profiles page rendering walks Prisma relations and the connection pool is most efficient when it's pinned to a long-lived Node process, not torn down per Lambda invocation. Fargate also keeps the dev/prod parity higher (same Node entry point as `npm run dev` minus the dev compiler).
- **Aurora MySQL, not RDS MySQL.** Aurora's storage layer means the read replicas can absorb a crawl burst without lag spikes on the writer. Reader endpoint for app reads, writer endpoint reserved for `/api/edit` and ETL writes.
- **OpenSearch Service.** Autocomplete (`/api/search/suggest`) and the search results page (`/search`) hit OpenSearch directly. Mostly stable load (one or two queries per autocomplete keystroke); the cluster sizing is search-dominated, not ingest-dominated.
- **CloudFront in front of everything.** The single most important production knob — see next section.

## Caching strategy (the actual load-shedder)

The application has explicit ISR per route (search the codebase for `export const revalidate`):

| Route | TTL | Comment |
|---|---:|---|
| `/scholars/[slug]` | 86400 (24 h) | Heaviest page, most-crawled |
| `/topics/[slug]` | 21600 (6 h) | |
| `/departments/[slug]`, `/centers/[slug]`, `/departments/[slug]/divisions/[div]` | 21600 (6 h) | |
| `/` (home) | 21600 (6 h) | |
| `/sitemap.xml` | 86400 (24 h) | |
| `/about`, `/about/methodology` | `force-static` | Pure-static; no DB calls at all |
| `/search` | `force-dynamic` | Per-request OpenSearch query, intentional |

What this means in practice:

- A bot crawling `/scholars/*` for the first time fills the CDN. After that, the same URL is served by CloudFront for 24 h with no app hit, no DB hit. The Fargate task only ever serves the *first* request per slug per 24 h.
- ETL jobs invalidate stale entries via `POST /api/revalidate` after each successful run (see `app/api/revalidate/route.ts`). That writes targeted `path:` invalidations — slug pages that didn't change in the run still serve cached.
- The `force-dynamic` search page is the only request path that hits the app on every request. We want it that way (search-as-you-type), and the work it does is bounded by OpenSearch, not the DB.

CloudFront configuration to enforce this:

- Cache key includes path + query string filtered to known params (`mesh`, `position`, `subtopic`, `tab`, `sort`, `page`, `q`, `type`, `yearMin`, `yearMax`). Drop tracking params. Anything else has its own URL and its own cache entry.
- Honor `s-maxage` from the origin (Next.js sets it from the route's `revalidate`).
- Set `min-TTL: 60` so a single bad response can't permanently poison a popular URL.
- 5xx responses cached only for 5 seconds — enough to absorb a bad-deploy thundering herd, short enough that a fix lands fast.
- Origin shield enabled (single regional shield per region) to protect the origin from cache-fill stampedes when a new ETL run invalidates a popular slug.

## What "hammered by bots" actually looks like, and why this holds

A typical crawl pattern for this site is `GET /sitemap.xml` (8,919 scholar URLs at last count) followed by sequential `GET /scholars/<slug>` for each. With the configuration above:

- Sitemap is one cached response per 24 h.
- First crawl of each `/scholars/{slug}` hits the origin. Each takes ~150–800 ms in production (no compile, just Prisma + render). 8,919 × 500 ms ≈ 75 minutes of *spread* origin traffic, but bots crawl in parallel, so the actual wall-clock is whatever the bot's concurrency allows.
- Subsequent crawls within 24 h hit CloudFront only.

If a bot somehow ignores caching headers, two layers protect us:

1. **AWS WAF rate rule**: 1000 req / 5 min per IP (`RateBasedRule`). Borderline-aggressive crawlers see 429s; well-behaved Googlebot/Bingbot stay well under.
2. **Origin concurrency**: ALB target group caps in-flight requests per task (default 2x healthy task count). If the burst still gets through WAF, the queue absorbs and 503s start; the ECS service autoscaler triggers within 60 s.

Lighter mitigation appropriate for `robots.txt`:

```
User-agent: *
Crawl-delay: 1
Sitemap: https://scholars.weill.cornell.edu/sitemap.xml
```

Crawl-delay is advisory — Google ignores it — but `Sitemap` and a sane `Disallow` block (`/api/`, `/edit/`) are honored.

## Database connection pooling

Prisma defaults to `connection_limit = num_physical_cpus * 2 + 1`. On a Fargate task with 1 vCPU that's 3 connections — too low under any concurrency. Set explicitly in `DATABASE_URL`:

```
mysql://app:***@cluster-ro.{region}.rds.amazonaws.com:3306/scholars?connection_limit=15&pool_timeout=10
```

Sizing logic:

- Aurora MySQL `db.r6g.large` reader allows ~270 client connections (4 GB instance, `max_connections ≈ ram_mb / 12.5`). Allocate ~80% to the app, leave headroom for ETL, Bastion, and observability.
- 4 Fargate tasks × 15 connections = 60 active. Up to 16 tasks before exhaustion; ECS service should cap at 12.
- `pool_timeout=10` — fail a request fast rather than queueing on a depleted pool. Better signal for autoscaler.

If you see `Timed out fetching a new connection from the connection pool` in the logs, either the pool is too small for the task's concurrency (raise `connection_limit`), or there's a leaked transaction (the application bug — fix it). Don't paper over either by raising `pool_timeout`.

## ETL scheduling

ETLs run on EventBridge Schedule rules, one rule per pipeline:

| Pipeline | Cadence | Notes |
|---|---|---|
| `ed` | nightly | Source: WCM ED LDAP. Updates Scholar/Appointment/Education. |
| `asms` | nightly | Source: ASMS. Updates Education with field qualifier. |
| `infoed` | nightly | Source: InfoEd. Updates Grant. |
| `coi` | nightly | Source: COI Portal. Updates CoiActivity. |
| `reciter` | weekly | Source: ReciterDB. Updates Publication, PublicationAuthor, MeshTerms. Heavy job (~5 min). |
| `dynamodb` | weekly | Source: DynamoDB TOPIC#/IMPACT# projections. Updates Topic, PublicationTopic, TopicAssignment. **Must run after `reciter`** — the reciter ETL `deleteMany`s `Publication` and cascades `PublicationTopic`. |
| `hierarchy` | annual | Subtopic catalog refresh. Subtopic IDs are not stable across runs (Phase 8 D-06). |
| `spotlight` | weekly | Updates Spotlight cards. Run after `reciter` and `dynamodb`. |
| `search-index` | nightly (after the SOR ETLs) | Rebuilds the OpenSearch index. |
| `completeness` | nightly | Updates the dashboard snapshot. |

ETL ordering matters because `reciter` cascades. Encode it in EventBridge with sequential rules or a Step Functions state machine, not parallel rules.

After each pipeline finishes, it must call `POST /api/revalidate` with the affected paths — see `app/api/revalidate/route.ts:43` for the matched-path regexes. Without this the CDN serves stale data until the natural TTL expires.

## Observability

Three places to look when the site is slow:

1. **CloudWatch RUM / synthetic checks**. Real-user metrics on `/`, `/search`, `/scholars/{slug}`, `/topics/{slug}`. Alarms fire on p95 > 2 s or 5xx rate > 1%.
2. **Application logs in CloudWatch Logs**. The app emits structured JSON: `{event, ...}`. Notable events: `profile_view`, `analytics_search_log`, `sparse_state_hide`, `revalidate_path`. Surface the slow ones (`profile_view` with `duration_ms > 2000`) into an alarm.
3. **RDS Performance Insights**. The first place to look when latency climbs without an obvious app cause. `analysis_summary_*` are not on this DB; everything live is keyed by indexed columns. Query plans should never table-scan `publication_topic` or `publication_author`.

Three pre-built dashboards:

- **Edge dashboard**: CloudFront cache hit rate, 4xx/5xx rate, origin requests per second.
- **App dashboard**: Fargate task count, CPU/memory utilization, ALB target response time p50/p95/p99.
- **Data dashboard**: Aurora connections, query latency p99, OpenSearch indexing latency, ETL run history.

## Incident: "pages are slow"

This is the runbook for the symptom we hit in dev. In production the resolution is different at each layer:

1. **Check CloudFront cache hit rate** (Edge dashboard). Healthy = >85%. If <50%, something is generating cache misses — most often a recent deploy with a different cache key or a hot ETL invalidation cycle. Roll back the deploy or back off the invalidation rate.
2. **Check Fargate task count and CPU** (App dashboard). If tasks are pegged but the autoscaler hasn't reacted, manually scale out. Investigate why the policy didn't fire (cooldown? metric lag?).
3. **Check Aurora connections + slow query log** (Data dashboard). If the connection pool is exhausted, scale tasks (more pools) before scaling the DB. If a single query plan changed (Aurora occasionally swaps plans after stats updates), force-run `ANALYZE TABLE` on the affected tables.
4. **Check OpenSearch query latency** if `/search` is slow but profile pages aren't. Cluster needs more data nodes, or a query is hitting an unindexed field.

Things that are *never* the right first response:

- Restarting all Fargate tasks. Restart cycles a cold cache and worsens the problem.
- Bumping all timeouts. Masks the symptom; the queue grows behind it.
- Disabling the CDN. Removes the only reason production isn't dev.

## Going from this repo to production

A non-exhaustive list of concrete things to do before flipping a domain:

- [ ] Build a Docker image: `next build` + `node server.js` entrypoint, multi-stage with `output: "standalone"` set in `next.config.ts`.
- [ ] Push to ECR or GHCR; deploy via the existing CI workflow.
- [ ] Provision Aurora MySQL with the Prisma schema (`prisma migrate deploy`, never `prisma migrate dev` in prod).
- [ ] Provision OpenSearch Service. Run `npm run search:index` once to seed; schedule the nightly rebuild.
- [ ] Stand up the ETL pipeline (one Lambda per pipeline; the `etl/*/index.ts` entry points work as Lambda handlers with minor wrapping).
- [ ] Configure CloudFront with the cache key, headers, and origin shield described above.
- [ ] Configure WAF with the rate rule and AWS Managed Rules (Common Rule Set + Bot Control).
- [ ] Wire alarms on the three dashboards.
- [ ] Run a 1000-scholar synthetic crawl in a load test environment to confirm cache hit rate ramps to ~99% by run 2.

The repo's `next.config.ts` only needs `output: "standalone"` added for the Docker image; everything else (`reactStrictMode`, `poweredByHeader: false`, image patterns) is already production-safe.
