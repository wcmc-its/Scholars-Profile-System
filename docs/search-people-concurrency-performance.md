# `/search` People concept-search — performance findings

**Scope:** why broad-concept People searches saturated under concurrency, what we changed, what the numbers say, and where the remaining ceiling is.
**Last updated:** 2026-07-03 (§7 addendum: taxonomy cache built #1420, pubs/funding mesh-only #1421, `SEARCH_PEOPLE_REASON_FROM_DOC` on both envs #1417). 2026-06-26: added §7 note on the shared Aurora-side taxonomy bottleneck.

> TL;DR — The app-side query load is now minimal (one people-index query per concept search; the per-request publications aggregation is gone). On staging the optimization improved latency but did **not** clear the ~10-concurrent target — because staging OpenSearch is a single burstable `t3.medium` node and hits a **node-capacity wall at ~5 concurrent**, not because of the code. Production is a far larger cluster (`m6g.large.search ×2`, Multi-AZ). The remaining lever is cluster scale, not more app code.

---

## 1. The problem

The People tab of `/search` ranks scholars for a query and, for each result card, shows a "reason" — *"N of M publications tagged `‹concept›`"*. For broad MeSH concepts (Neoplasms, HIV, …) the reason was computed per request by a **publications-index aggregation**. Under concurrency that agg saturated the OpenSearch thread pool: the streamed People render tailed past the **7 s `#1017` nav watchdog**, producing the ~10 s `/search` hang in demos. Target: stay responsive at ~10 concurrent searches.

## 2. What we changed (the optimization lineage)

| Step | PR | What it did |
|---|---|---|
| **A+B+C** | #1281 | Dropped a high-cardinality agg, decoupled reason rendering from the list paint (deferred), and added a response cache. Cleared low concurrency; not C=10. |
| **D** | #1284 | **Precompute** the reason count onto the people doc as `meshSubtreeCounts` (`{conceptUi → distinctPubCount}`), looked up **O(1)** at query time. Takes the publications-index aggregation **off the search path entirely**. Key papers became **lazy** — fetched per card on viewport-enter via `GET /api/search/key-paper`. |
| **1-query collapse** | #1285 | Folded the cheap doc-reason into the list query and dropped a redundant **second `searchPeople` call** (B's deferred-reason architecture had been issuing a full second people-index query just to read `meshSubtreeCounts`). Result: **one people-index query per concept search** (was two). |

Net app-side cost per concept search went from **(people-query + publications-agg)** → **(one people-query)**.

## 3. The load-test numbers

Staging C-ramp, total **p90 seconds** (prior-session measurements; the 1-query collapse #1285 is **not** in this table — it was undeployed when these were taken):

| Concurrency | Before (no A+B+C) | A+B+C | D (flag on) |
|---|---|---|---|
| 1 | 2.27 | 2.17 | **1.32** |
| 5 | 8.56 | 7.32 | 7.06 |
| 8 | 11.17 | 8.01 | 10.32 |
| 10 | 16.76 | 13.64 | **13.17** |

Single-query latency improved markedly (C=1: 2.27 → 1.32 s). But C=10 stayed ~13 s — **did not clear the target on staging**.

> ⚠️ **Measurement gap:** #1285's effect was never re-measured on staging (the fix is deployed + functionally verified, but no fresh load-test run). A clean before/after for #1285 on the `t3.medium` is the cheapest missing data point.

## 4. Root cause — two independent causes

1. **Code gap (fixed in #1285).** D removed the *publications*-index agg, but B's deferred architecture still issued a **second people-index query** to read `meshSubtreeCounts` — so D swapped (people-query + pub-agg) for (people-query + people-query): **no net query reduction**, hence no concurrency win. #1285 collapses this to one query.
2. **Cluster ceiling (infrastructure — the real wall).** A saturation probe isolated sequential vs concurrent: single **cold** queries ran ~**0.8–1.5 s**, but **5-concurrent ran ~4–5 s each** — a node-capacity wall on staging's single burstable node. Even after the 1-query fix, this node will likely not clear C=10. **Staging is not representative of go-live.**

## 5. Cluster sizing (confirmed 2026-06-25)

| | Instance | Nodes | AZ | Notes |
|---|---|---|---|---|
| **Staging** | `t3.medium.search` | 1 | single-AZ | Burstable (~2 GB heap); subject to T3 CPU-credit throttling. CDK history notes `t3.small` even returned 429 on bulk. |
| **Prod** | `m6g.large.search` | 2 | Multi-AZ (2) | Graviton (~8 GB heap each), sharded + replicated across 2 AZs. No dedicated master either side. |

- Both domains live in **one AWS account** (`665083158573`); the `--profile reciter-prod` in older notes is a no-op (resolves to the same account). Prod domain `…fquptd67j2so`, staging `…j7tli0rlgtyz`.
- The staging→prod gap is categorical (1× burstable vs 2× Graviton, sharded/replicated), so the staging C=10 number **under-reports** prod headroom. The cluster-size wall, not the application, is what staging's number reflects.

## 6. Trade-offs and side effects

- **Accuracy improved (intentional).** The doc count is the **exact** full MeSH subtree. The legacy agg capped descendants at `DESCENDANT_HARD_CAP` (200) and **undercounted** broad concepts. With D on, broad counts rise to their true value (e.g. Neoplasms → its real ~1,619, not a capped number).
- **Representative-pub snippet (#967) turned off.** `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` added a `top_hits` sub-agg to the reason-count agg — **the most expensive part** of that agg, and a direct contributor to the broad-concept hang (measured: one profile's People render 2.4 s with it on → 1.6 s off; sub-agg ≈ 0.8 s). It was set off everywhere (#1280→#1289) for prod parity. Under D the synchronous sub-agg is off the path anyway, so the flag is effectively inert for concept searches.
- **Consequence found + fixed, with a bonus perf win.** Taking the agg off the path emptied the data that fed the representative paper on the *evidence* render path (staging), so the key papers stopped displaying. Fixed by wiring the lazy `/api/search/key-paper` into the evidence disclosure — and because the papers now sit behind a chevron, the fetch moved from **eager** (every visible card, on scroll) to **on-expand** (only cards the viewer opens). That cuts key-paper query volume from per-*visible*-card to per-*expanded*-card — a complementary reduction in ambient OpenSearch load under concurrency (the fetch was never on the main search path, so it doesn't change the C-ramp latency itself). The endpoint now returns the top 3, ranked recency→impact; a Research-Area relevance re-rank (`PublicationTopic.score`, for the ~143 curated-anchor concepts) is a planned fast-follow.
- **Reindex safety (#1288).** Removing/precomputing fields means more reindexes; a guard now prevents an interrupted reindex from bricking subsequent ones (orphaned next-version index, with a live-alias-target abort).

## 7. Where the ceiling is now

- **App code: effectively maxed.** One people-index query per concept search is the floor without precomputing concept-specific key papers (option "E"), which was **deliberately rejected** (it would make key papers scholar-level/lossy instead of concept-specific).
- **Remaining lever: cluster scale.** If a **representative** cluster still saturates at C=10 after the 1-query fix, the fix is more/bigger data nodes — not more application changes.
- **A second, Aurora-side bottleneck (found 2026-06-26).** A Publications-tab C-ramp isolated `matchQueryToTaxonomy` — the query→taxonomy resolver shared by **both** tabs — as the dominant cost under concurrency: ~8.6 s at C=5 vs ~1.3 s for the OpenSearch search+aggs, because it runs two `publicationTopic.groupBy` queries **per matched candidate** (`getCounts`), uncached across requests. That is an **Aurora** ceiling independent of the OpenSearch one above, and the People path pays it too. An app-CPU bump did **not** move it (proof it's DB I/O, not CPU); the lever is a cross-request taxonomy cache. Full detail: [`performance-baseline.md` § Search performance findings (2026-06-26)](./performance-baseline.md).
- **What's unverified:** the C=10 number on the representative (prod-sized) cluster. Cheapest ways to get it without a production release: (a) re-run the staging load test now to quantify #1285 on the `t3.medium`; (b) temporarily resize staging to `m6g.large` and load-test the optimized path; (c) fold into the next planned prod release (prod is ~350 commits behind; deploying it is a large multi-feature release, and exercising the *fixed* path on prod additionally needs a prod people-reindex for `meshSubtreeCounts` + flipping `SEARCH_PEOPLE_REASON_FROM_DOC` on for prod).

**Update 2026-07-03 — the taxonomy lever above was built and the prod flag flipped** (full search/faceting audit, tracker **#1415**; see [`performance-baseline.md` § Search performance findings, item 4](./performance-baseline.md)):

- **The cross-request taxonomy cache is built.** `getCounts` is now SWR-cached cross-request (`lib/api/search-taxonomy.ts`, #1420), so the per-candidate `groupBy` load called out above no longer recurs per request.
- **The publications/funding branches skip the resolver's Prisma enrichment entirely** (#1421) — the People path still runs the full resolver, but the pub/funding tabs never pay it, and staging `Server-Timing` for this query class now reads `taxonomy;dur=0`.
- **`SEARCH_PEOPLE_REASON_FROM_DOC` is now ON in both envs** (#1417; verified in the live prod task-def `:21`), so the fixed doc-reason path runs in prod, not just staging.
- **The prod image roll is done** (GH Actions run 28624978997, deployed 2026-07-02 — `/api/search` now serves gzip on the wire and `SEARCH_PEOPLE_REASON_FROM_DOC` is on in prod, rev 21) and **`meshSubtreeCounts` is populated on the prod people index** (verified 2026-07-03 by a direct `_source` read — 118 of a 200-doc sample carry a non-empty map). Note the field is mapped `enabled: false`, so it lives in `_source` (where the doc-reason path reads it O(1)) but is **not** matchable by an `exists` query. The reason-from-doc path therefore serves real counts in prod — **#1404 resolved**.

## 8. Reusable load-test tooling

Committed under [`scripts/perf/`](../scripts/perf/) (read-only GETs; run from the WCM network; `--selftest` for a no-network sanity check):

- [`scripts/perf/sps-loadtest.sh`](../scripts/perf/sps-loadtest.sh) `‹label›` — C-ramp (default `1 5 8 10`), reports ttfb + total p50/p90/max and non-200 count per level. Rotates broad concepts to defeat the response cache so OpenSearch is actually loaded. macOS-safe (percentile via `sort -n` + index, not gawk `asort`). Hits `GET $HOST/api/search?type=people&q=…` (default `HOST=https://scholars-staging.weill.cornell.edu`; set `HOST=…scholars.weill.cornell.edu` for prod, or `PATH_TMPL` for the streamed `/search` page).
- [`scripts/perf/sps-satcheck.sh`](../scripts/perf/sps-satcheck.sh) — sequential-vs-concurrent saturation isolator (the probe that proved the node-capacity wall): a large sequential→concurrent per-query gap means the OpenSearch node is the wall, not the app.
