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

## Search origin-path optimizations (2026-06)

`/search` is `force-dynamic` — every request hits origin and is bounded by **serial
OpenSearch round-trips**, not cache. So the lever there is *round-trip count*, and three
changes cut it on the hot concept-People path (fix plan: `.planning/perf-audit.md`):

- **Section A** (#913, `5db894d`) — People `_source` include-list (stop shipping
  concatenated abstracts only to discard them), the active-tab full search hoisted above
  the badge `await` (one fewer serial RTT), and profile fan-out dedup/projection/parallelize.
- **Section B trio** (#922, `1e3dfdd`) — dept-label TTL cache, request-scoped taxonomy
  memo, and a hits-only mode for the sparse-concept fallback (skips discarded facets +
  ≤500-row hydration).
- **B2** (#924, `77f5af0`) — dropped the dedicated concept-escalation **pre-count**: the
  escalation decision now reads the main search's own `hits.total` and re-runs escalated
  only on the rare sparse case, removing **2 round-trips per cold concept-People SSR render**
  on the common non-sparse path. Gated by `SEARCH_PEOPLE_CONCEPT_PRECOUNT` (default-on = old
  pre-count path; `off` = reorder). **Staging flipped to the reorder 2026-06-12** (task def
  `sps-app-staging:45`); prod still on the old path.

> ⚠️ **Not yet a measured win.** A staging curl probe (`/search?q=…&type=people`, HTTP 200)
> confirmed the B2 reorder is live with no hot-path regression, but staging's small
> OpenSearch + single-sample curl noise (±1 s run-to-run) **cannot isolate** the per-RTT
> delta — do not cite the staging numbers as a baseline. The real before/after is the
> `search_query` `duration_ms` **p50/p95** (Logs Insights, see [§ How to (re)measure](#how-to-remeasure))
> under **prod** traffic; capture that before flipping `SEARCH_PEOPLE_CONCEPT_PRECOUNT=off`
> in prod. Until then the `/search` origin cell above stays `TBD (measure)`.

> ⚠️ **Profile edge-cache reality vs. the table.** The Scholar-profile row lists ISR TTL
> 24 h, but that is the *intended* state — the canonical root profile URL is currently
> served `force-dynamic` and lands on no cacheable CloudFront behavior, so today it is an
> origin miss every view (audit F1 / C1). The fix (force-static + edge-behavior carve) is
> **#914, held** pending its prod prerequisites (`PROFILE_EMAIL_RELEASE_GATE` on in prod
> first + a shared multi-task ISR cacheHandler). This is the single biggest site-wide win.

### Search performance findings (2026-06-26)

A round of `/search` measurement on staging (triggered by an operator hitting a ~30 s
Publications search) produced three durable findings.

**1. The reported 30 s was a post-deploy cold window, not steady-state cost — and the
warm-up had a gap (fixed, #1297).** Staging runs a single app task, so each deploy briefly
exposes one cold task. The startup warm-up (`lib/warmup.ts`, #695) was priming search with
`countOnly: true`, which short-circuits past the facet aggregation, the Prisma hydration,
**and** the taxonomy-enrich path — so a freshly-deployed task latched "warm" having never
run a real faceted search, and the first post-deploy search still paid the cold cost
(observed: staging ALB `TargetResponseTime` ~19.5 s clustered right after a deploy, nothing
> 3 s after). #1297 changes the primers to a full faceted search. (Staging's single task
still has a brief per-deploy window — #696, conditional 2-task — so point user-facing
traffic at prod, which rode the same deploys with **zero** > 3 s ALB spikes.)

**2. Under concurrency the binding cost is the taxonomy resolver (Aurora), not the
OpenSearch facet aggregation.** A C-ramp of the Publications JSON API
(`/api/search?type=publications&q=cancer`) split the per-request `Server-Timing`:

| Component | C=1 (warm) | C=5 (concurrent) |
|---|---|---|
| `matchQueryToTaxonomy` | ~1.7 s | **~8.6 s** |
| `searchPublications` (incl. facet aggs) | ~0.2 s | ~1.3 s |

Total request p50: 2.0 s (C=1) → 5.0 s (C=3) → 8.4 s (C=5). The dominant, super-linear
cost is **`matchQueryToTaxonomy`** (`lib/api/search-taxonomy.ts`), which is **Aurora-bound**:
every request re-loads the full topic/subtopic candidate set (`loadEntityCandidates`,
request-scoped-`cache()` only) and then runs **two `publicationTopic.groupBy` queries per
matched candidate** (`getCounts`) — dozens of groupBys per broad query, uncached across
requests. This is the **Aurora-side counterpart** to the OpenSearch reason-agg ceiling in
[`search-people-concurrency-performance.md`](./search-people-concurrency-performance.md);
both can bind independently, and the taxonomy resolver runs on **both** the People and
Publications paths.

**3. Two things this ruled in/out (both verified):**

- **The app-tier vCPU bump did not fix it.** Doubling the staging task 0.5 → 1 vCPU
  (`config.ts`, deployed task def rev 83) left C=3 p50 unchanged (4.8 → 5.0 s) and only
  tightened the tail (C=3 p90 6.9 → 5.4 s). A null result on a CPU bump is itself the proof
  the bottleneck is DB I/O, not CPU. Prod was **not** deployed (same reason).
- **The Publications facet-split was investigated and parked.** A handoff
  (`pub-tab-performance-handoff.md`) proposed splitting/caching the OpenSearch facet aggs
  off the hit list; measurement shows the aggs are ~0.2 s, so the split optimizes the wrong
  component. Code preserved at `origin/perf/pub-tab-facet-split` (`SEARCH_PUB_FACET_SPLIT`,
  default-off, byte-identical) to revisit only if OpenSearch aggs ever become binding.

**The real lever (documented, not built):** a cross-request cache of the taxonomy resolve.
The per-candidate counts are ETL-cadence (safe to cache for minutes/hours) and the candidate
load is query-independent, but the `#800/#801` method-family overlay gate must stay live —
so the cache needs ETL-versioning or a short TTL, not a blunt freeze. Worth doing only if
go-live concurrency makes it bind.

## Scaling characteristics

- **App tier:** ECS Fargate. Per-task sizing: **staging 1024 CPU / 2048 MiB** (bumped from
  512/1024 and deployed 2026-06-26); **prod 2048 / 4096 in `config.ts` but the deployed task
  def is still 1024 / 2048** pending a prod `cdk deploy` (sizing rides a task-def deploy, not
  the CD image roll). The 2026-06-26 bump is a marginal-only mitigation for the Aurora-bound
  taxonomy cost above — not a fix. Target-tracking
  autoscaling (#596) between min 2 (= `appDesiredCount`, AZ-spread) and max 6
  (= `appMaxCount`) on avg CPU (60%) and ALB request-count-per-target; the max and
  the thresholds are conservative placeholders pending the #554 load test. Rolling
  deploys stand up replacement tasks before draining (minHealthy 100% / max 200%).
  Blue/green is intentionally deferred until steady-state > 4 tasks or sustained
  > 100 RPS ([`DEPLOY-RUNBOOK.md § Why rolling`](./DEPLOY-RUNBOOK.md)).
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

*Baseline last updated: 2026-06-26 — added § Search performance findings (taxonomy-resolver
Aurora bottleneck under concurrency; cold-start warm-up gap → #1297; vCPU bump null result;
facet-split parked) and app-tier sizing change. 2026-06-12: search origin-path optimizations
(Section A/B, #913 / #922 / #924). Per-surface latency cells still pending a
production-traffic or load-test measurement run.*
