# Performance baseline

**Audience.** Operators and ITS colleagues answering *"Is Scholars fast? How fast should
it be? Where does the time go when it isn't?"*

**What this doc is — and isn't.** [`SLOs.md`](./SLOs.md) states the *targets*
(p99 `TargetResponseTime` < 1.5 s; 99.5% availability). This doc is the *measured* side:
the observed baseline per surface, the alarm thresholds that bracket "normal," and the
method to (re)populate the numbers. **Cells marked `TBD (measure)` are not yet backed by a
real measurement run** — they are placeholders, not estimates, and must be filled from the
method in [§ How to (re)measure](#how-to-remeasure) rather than guessed. Treating an
unmeasured cell as a known value is the failure mode this doc exists to prevent.

> Why so many TBDs at launch: a meaningful latency/throughput baseline needs post-launch
> traffic (or a load test against a production-shaped environment). Pre-launch, the honest
> baseline is "targets + alarm thresholds + the handful of real observations below."

---

## The mental model: cache is the performance story

SPS is read-mostly and CloudFront-fronted. **The dominant performance variable is cache
hit rate, not render speed.** A cache *hit* is served from the CloudFront edge in tens of
milliseconds and never touches the app or DB. A cache *miss* runs a full Next.js render +
Prisma query. So "how fast is Scholars" has two very different answers depending on the
layer you measure:

| Layer | Metric | What it captures |
|---|---|---|
| **Edge (user-perceived)** | CloudFront `OriginLatency`, RUM | What a real visitor experiences — mostly cache hits |
| **Origin (app tail)** | ALB `TargetResponseTime` p50/p95/p99 | What the app does on a cache miss — the SLO surface |
| **DB** | Aurora query latency (Performance Insights) | The bottleneck inside an origin render |

A healthy CloudFront cache hit rate is **>85%**; below **50%** is an incident signal
([`PRODUCTION.md § Incident: pages are slow`](./PRODUCTION.md)).

## Targets and alarm thresholds (the brackets of "normal")

These are real and enforced today (`cdk/lib/observability-stack.ts`, [`SLOs.md`](./SLOs.md)):

| Surface / metric | Target (SLO) | Alarm fires at | Notes |
|---|---|---|---|
| Origin latency — ALB `TargetResponseTime` p99 | **< 1.5 s** | > 1.5 s for 3×5m | Excludes the CloudFront edge round trip. The end-user p99 SLO is set *after* EdgeStack traffic is observable. |
| Availability — 2xx+3xx / total at ALB | **99.5%** / 28 d | 5xx rate > 1% for 2×5m | 4xx excluded from the failure count. |
| RUM (real-user) | — | p95 > 2 s **or** 5xx > 1% | `PRODUCTION.md § Observability` (CloudWatch RUM/synthetics). |
| CloudFront cache hit rate | > 85% healthy | (dashboard, not alarmed) | < 50% ⇒ investigate (bad deploy cache-key change, or hot invalidation cycle). |
| Aurora CPU | — | > 80% for 3×5m | Hot query loop / runaway analytic. |
| Aurora connections | — | > 80 for 3×5m | Pool exhaustion. Budget: `connectionLimit=15`/task. |
| OpenSearch JVM memory pressure | — | > 85% for 3×5m | GC pressure cascading into query latency. |

## Per-surface baseline

`Observed` = a real number we have seen in dev/prod and can cite. `TBD (measure)` = needs a
run. **Do not infer the TBDs from the Observed column** — they are different render paths.

| Surface | Route | ISR TTL | Origin render (cache miss) | Edge (cache hit) | Source |
|---|---|---|---|---|---|
| Scholar profile | `/scholars/[slug]` | 24 h | **Observed ~150–800 ms** (prod, Prisma + render) | TBD (measure) | [`PRODUCTION.md`](./PRODUCTION.md) line 103 |
| Topic page | `/topics/[slug]` | 6 h | TBD (measure) | TBD (measure) | — |
| Department / Center | `/departments/[slug]`, `/centers/[slug]` | 6 h | TBD (measure) | TBD (measure) | — |
| Home | `/` | 6 h | TBD (measure) | TBD (measure) | — |
| Search results | `/search` | `force-dynamic` | TBD (measure) — bounded by OpenSearch, **every request hits origin** | n/a (not cached) | by design |
| Autocomplete | `/api/search/suggest` | n/a | TBD (measure) — 1–2 OpenSearch queries/keystroke | n/a | [`PRODUCTION.md`](./PRODUCTION.md) line 67 |
| Edit write | `POST /api/edit/*` | n/a | TBD (measure) — Aurora write + audit insert (1 tx) + LDAP authz | n/a | low volume, staff-only |

> ⚠️ **The 30-second number is a dev artifact, not a baseline.** During development,
> `/topics/{slug}` was observed degrading from ~150 ms to 30+ s under concurrency. That is
> a `next dev` per-route-compile pathology that production (`next build` + `next start`)
> does not have. Do **not** cite it as a production figure. ([`PRODUCTION.md § Why next dev is not production`](./PRODUCTION.md).)

### Other measured timings (real, citable)

| What | Value | Source |
|---|---|---|
| On-call relay Lambda cold start / warm p50 | ~400 ms / ~200 ms | `PRODUCTION_ADDENDUM.md § B27` |
| Staging deploy wall-clock (no migration) | ~7–9 min | [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) |
| Rolling-replacement step (zero-downtime cost) | ~3 min | [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) |
| Restore drill (PITR, mechanism only) | 19 min (2026-05-21) | [`PRODUCTION.md § Recovery objectives`](./PRODUCTION.md) |
| ETL `reciter` run | ~5 min (heavy) | [`PRODUCTION.md § ETL scheduling`](./PRODUCTION.md) |

## Scaling characteristics

- **App tier:** ECS Fargate, prod 2 tasks (1024 CPU / 2048 MiB), autoscaling target on
  RPS/CPU. Rolling deploys briefly run 2→3 tasks. Blue/green is intentionally deferred
  until steady-state > 4 tasks or sustained > 100 RPS ([`DEPLOY-RUNBOOK.md § Why rolling`](./DEPLOY-RUNBOOK.md)).
- **DB tier:** Aurora Serverless v2 auto-scales 1–8 ACU (prod); prod has a reader endpoint
  for `db.read`. Connection budget: 15/task; alarm at 80 connections.
- **Search tier:** OpenSearch prod = 2 × `m6g.large.search`, multi-AZ. Sizing is
  search-dominated, not ingest-dominated.
- **Load model:** a bot crawl of all ~9,000 `/scholars/*` URLs hits origin once per slug
  per 24 h, then serves from edge; WAF rate rule caps abusive crawlers at 1000 req/5 min/IP.

## How to (re)measure

Run these to replace the `TBD (measure)` cells. Record the date + environment + commit SHA
alongside each number you write back.

1. **Origin latency per route (the SLO surface).** CloudWatch → ALB `TargetResponseTime`
   with the `LoadBalancer` dimension, p50/p95/p99 over a representative window. For
   per-route splits (not natively dimensioned), use the structured `profile_view` /
   `search_query` log events (`duration_ms`) via Logs Insights — see
   [`logging-reference.md`](./logging-reference.md).
2. **Edge / user-perceived.** CloudWatch RUM on `/`, `/search`, `/scholars/{slug}`,
   `/topics/{slug}`; and CloudFront `OriginLatency` + cache-hit-rate on the Edge dashboard.
3. **DB.** RDS Performance Insights — top SQL by total time; confirm no plan table-scans
   `publication_topic` / `publication_author`.
4. **Synthetic load test (pre-launch baseline).** The documented acceptance check:
   *"run a 1000-scholar synthetic crawl in a load-test environment to confirm cache hit
   rate ramps to ~99% by run 2"* ([`PRODUCTION.md § Going from this repo to production`](./PRODUCTION.md)).
   Capture origin p50/p95/p99 on run 1 (all misses) and edge latency on run 2 (all hits) —
   that single test fills most of the per-surface table.
5. **Trace attribution.** For "where did the time go in one slow render," open the X-Ray
   trace and find the longest Prisma span ([`tracing.md`](./tracing.md)).

## Review cadence

Re-measure and update this doc at the same triggers as the SLO review
([`SLOs.md § Review cadence`](./SLOs.md)): **30 days after EdgeStack traffic is live**
(CloudFront adds the edge-latency surface), quarterly thereafter, and after any change that
moves the render path (a new heavy query, an ISR TTL change, an instance-size change).

---

*Baseline last updated: 2026-05-28 — pre-launch; per-surface latency cells pending a
production-traffic or load-test measurement run.*
