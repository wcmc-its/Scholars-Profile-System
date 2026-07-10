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
