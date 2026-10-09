# `scripts/perf/` — search latency / load-test tooling

Reproducible load tests for the `/search` People concept-search path — the tools
behind the numbers in
[`docs/search-people-concurrency-performance.md`](../../docs/search-people-concurrency-performance.md)
and the latency cells in [`docs/performance-baseline.md`](../../docs/performance-baseline.md).

Both hit the JSON API the People tab calls (`GET /api/search?type=people&q=…`),
the same endpoint as [`../search-eval/lib.sh`](../search-eval/lib.sh). Read-only
(GET); **run from the WCM network** — the staging search API is WCM-gated. Requires
`bash`, `curl`, `jq`. macOS-safe (percentiles via `sort -n` + index, no gawk `asort`).

| Script | What it answers |
|---|---|
| `sps-loadtest.sh [label]` | C-ramp (default `1 5 8 10`): ttfb + total p50/p90/max and non-200 count per concurrency level. Rotates broad MeSH concepts so the response cache can't absorb the load. |
| `sps-satcheck.sh` | Sequential-vs-concurrent isolator: is a slow concurrent number the OpenSearch *node* saturating, or the app? A big sequential→concurrent gap = node-capacity wall. |

```sh
# staging (default)
scripts/perf/sps-loadtest.sh baseline
scripts/perf/sps-satcheck.sh

# prod, or a deeper/wider ramp
HOST=https://scholars.weill.cornell.edu scripts/perf/sps-loadtest.sh prod
LEVELS="1 5 10 15" REPS=6 scripts/perf/sps-loadtest.sh wide

# no-network sanity check of the percentile math
scripts/perf/sps-loadtest.sh --selftest
scripts/perf/sps-satcheck.sh --selftest
```

Interpreting results: staging OpenSearch is a single burstable `t3.medium.search`
node and saturates at ~5 concurrent, so its C=10 number **under-reports** prod
(`m6g.large.search ×2`, Multi-AZ). Cross-reference the cluster-sizing table in the
concurrency doc before reading a staging number as a go-live number.

## Full-site load tests (IBM RPT)

ITS runs multi-page user-flow load tests with IBM Rational Performance Tester (RPT). The first run (2026-10-01, 15 users on staging), the 150-user run (2026-10-06) and their findings are in [`docs/performance-baseline.md` § Full-site load test](../../docs/performance-baseline.md#full-site-load-test-ibm-rpt-2026-10-01). The target for later runs comes from the parallel Apollo (weillcornell.org) project: 500+ users with at least 20 logins/s. SPS public visitors don't log in, so read that as about 20 new visitors/s.

Before trusting an RPT number:

1. **Test prod-shaped capacity.** Staging runs 1 app task at 1 vCPU and Aurora at max 4 ACU; prod runs 2–6 tasks at 2 vCPU and max 8 ACU. Test prod in a quiet window, or raise staging to match for the test window and put it back afterwards. Check that staging Aurora is idle before starting.
2. **Re-record after the latest deploy.** The script captures Next.js routing headers (`x-deployment-id`, `_rsc`) that change on every build. Re-record, or treat them as variables in RPT.
3. **One transaction per user action.** SPS is a Next.js app: after the first load, clicks are client-side navigations plus background prefetches. RPT's default "page" grouping lumps several actions and their think time into one timer, and that produced the 21 s "page" times in the first run. Wrap each click in its own transaction and leave think time out of the timings.
4. **Leave the third-party host out.** Headshots load from `directory.weill.cornell.edu`, a production WCM service with no staging copy. In the first run about 60% of requests went there, and half of those were expected 404s (scholars with no photo). At 150 users (2026-10-06) the directory itself returned 503s and 502s, which turned RPT page verdicts red although SPS was fine. Exclude that host from the script, or at least drop its response-code checks and report it separately. If it stays in at scale, warn the IDM team (the directory owners) first; directory capacity is their call, not an SPS fix.
5. **Watch the server side during the run:** ALB `RequestCount`, `TargetResponseTime`, `HTTPCode_ELB_502_Count` vs `HTTPCode_Target_5XX_Count`; ECS service CPU/memory; Aurora `CPUUtilization`, `ServerlessDatabaseCapacity`, `DatabaseConnections`. Low TTFB with a slow total means the streamed body is waiting on Aurora.
6. **Ramp up.** 15 users, then 50, 100, 250, 500. Land profile edge caching (open, see the baseline doc) before the 500-user step.
