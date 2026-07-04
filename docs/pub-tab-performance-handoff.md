# Handoff — Publications-tab performance, applying the People-search learnings

> ⚠️ **SUPERSEDED BY MEASUREMENT (2026-06-26).** This handoff's central premise — that the
> **facet aggregation** is the dominant Publications-tab cost — did **not** hold when measured.
> A staging C-ramp put `searchPublications` (facet aggs included) at ~0.2 s (C=1) / ~1.3 s
> (C=5), while the **shared taxonomy resolver** `matchQueryToTaxonomy` was ~1.7 s / ~8.6 s —
> i.e. the aggregation is cheap and the bottleneck is Aurora, not OpenSearch. **The
> facet-split (§4.1/§4.2) was built behind `SEARCH_PUB_FACET_SPLIT` and then PARKED** (code at
> `origin/perf/pub-tab-facet-split`, tag `parked/pub-tab-facet-split`, commit `927c35dd`,
> default-off; tracked in **#1301**) because it optimizes the wrong component.
> Read [`performance-baseline.md` § Search performance findings (2026-06-26)](./performance-baseline.md)
> for the measurements and the real lever (a cross-request taxonomy cache). The §5 "what does
> NOT transfer" analysis and the cost-surface map below remain accurate and useful.

**Date:** 2026-06-26
**Audience:** next engineer optimizing the `/search` **Publications** tab.
**Premise:** the People tab was made fast this cycle (#1281–#1285, #1290–#1293). This handoff maps *which* of those moves transfer to the Publications tab, which don't, and in what order — grounded in the actual `searchPublications` cost surface.

> Ground refs (re-verify against `origin/master`; canonical checkout drifts): `searchPublications` in `lib/api/search.ts` (~L2890–3900); the People findings in `docs/search-people-concurrency-performance.md`; the recency tilt in `lib/api/search-flags.ts` (`resolvePubRecencyMode`); the response cache in `lib/api/reason-agg-cache.ts`.

---

## 1. TL;DR

The People tab's win came from **taking the expensive aggregation off the hit-list path** (precompute + lazy + 1-query collapse + a response cache), not from cluster scale. The Publications tab's expensive work is **the facet-aggregation bundle**, which today runs **in the same OpenSearch request as the hits + the exact total count**, on the ~90k-doc publications index. The single highest-leverage change is the same shape as the People fix: **decouple the facets from the hit list** — paint rows from a cheap query, compute facets in a separate, cacheable, interruptible request.

The recency-blend re-rank we built for key papers (#1293) **does not** transfer (see §5).

---

## 2. What we learned on the People tab (the playbook)

| Move | People PR | Mechanism | Transfers to Pubs? |
|---|---|---|---|
| **Precompute onto the doc** | #1284 | `meshSubtreeCounts` on the people doc → O(1) reason count, agg off the search path | **Partial** — facets are query-filtered, can't fully precompute; but the *total count* can be relaxed (§4.3) |
| **Decouple expensive work from the list paint** | #1281 (B) | reason render deferred; list paints first | **Yes — the big one** (§4.1) |
| **Response cache** | #1281 (C) | `cachedReasonAgg` keyed by query | **Yes** (§4.2) |
| **1-query collapse** | #1285 | folded the cheap signal into the list query; dropped a redundant 2nd query | **Yes — audit for a redundant request** (§4.5) |
| **Lazy per-card fetch** | #1290 | key papers fetched on expand, not per visible card | **Yes — for heavy/rarely-touched facets** (§4.4) |
| **requestTimeout cap + nav watchdog** | #1278 / #1017 | a slow agg can't hang past the 7s `#1017` watchdog | **Yes — the pub search has no timeout guard** (§4.6) |
| **Node-capacity wall, not code** | — | staging `t3.medium ×1` saturates ~5 concurrent; prod `m6g.large ×2` | **Same caveat** — set expectations, measure on a representative cluster (§6) |

---

## 3. The Publications-tab cost surface (what one active-tab search actually does)

A single active-tab `searchPublications` request body carries **all of the following in one OpenSearch round-trip**:

1. **`track_total_hits: true`** on a ~90k index → an exact total even for broad queries (`q=cancer` counts the full match set). Comment in code acknowledges it "counts a few thousand extra docs on broad queries."
2. **Relevance path scoring** — a `function_score` Gaussian recency tilt (#645, `recencyGauss`, gentle = `bm25 × (1 + 2·gauss)`). Modest; **not** the main cost. Skipped on explicit sorts.
3. **`highlight`** on `title` (cheap; short field).
4. **The facet-aggregation bundle — the dominant cost.** Each facet is a `filter` agg using the `filtersExcept(axis)` "excluding-self" pattern (with `post_filter` applying the user axes after aggs):
   - `publicationTypes` — terms, size 15
   - `journals` — terms on `journal.keyword`, **size 500**
   - `wcmRoleFirst/Senior/Middle` — 3 filter aggs
   - `wcmAuthors` — terms on `wcmAuthorCwids`, **size 500**, **+ `cardinality` with `precision_threshold: 4000`** (high-accuracy HLL → the priciest single sub-agg)
   - `departments` — terms on `wcmAuthorDepartments`, size 200 (flag-gated)
   - `mentoring` — **per-bucket** filter sub-aggs, each with a `terms: { pmid: [...bucketPmids] }` list (flag-gated; the heaviest when many buckets are active)
   - year distribution

**Already done well:** the `countOnly` path (inactive tabs) short-circuits to `size:0` with **no aggs** — only the badge total. So the cost above is the *active* tab only.

The takeaway: on a broad query the hits are cheap; the **aggregation fan-out + exact count** is what makes the active Publications tab slow and what saturates the OpenSearch thread pool under concurrency — exactly the failure mode the People reason-agg had.

---

## 4. Recommendations (prioritized; each maps to a People learning)

### 4.1 Split facets off the hit-list path *(highest impact — the #1281-B move)*
Issue two requests instead of one:
- **Request A (fast):** hits + `track_total_hits` + highlight + the recency `function_score`. Paints the result rows immediately.
- **Request B (facets):** `size:0` with the same `query` + `post_filter` and the agg bundle. Streamed in / rendered when it lands.

The rows stop waiting on the agg fan-out; the agg request can be cached (§4.2), timed out (§4.6), or skipped on pagination (facets don't change page-to-page — recompute only when the query/filters change, not when `from` changes). **This is the single change most likely to move p90.**

### 4.2 Cache the facet response *(the #1281-C move)*
Facets are a pure function of `(query, activeFilters)` — independent of `page`. Wrap Request B in `cachedReasonAgg` (or the same TTL cache), keyed by the normalized query + filter set. Popular queries (`cancer`, `covid`, `microbiome`) recompute the size-500 + cardinality bundle on every keystroke/page today; a short TTL collapses that to once.

### 4.3 Relax the exact total on broad queries *(the precompute/approximate spirit of #1284)*
`track_total_hits: true` forces an exact count of every match. For the subhead, exact-to-the-unit beyond a few thousand has no UX value. Set `track_total_hits: <cap>` (e.g. 50,000) and render "50,000+" past the cap. Trade an over-precise number for a cheaper counter on the broadest queries. *(Confirm with design that "10,000+"-style copy is acceptable — the current code comment chose exactness deliberately.)*

### 4.4 Make the heavy/rare facets lazy *(the #1290 lazy-fetch move)*
The author and journal facets compute **size 500** lists on every search, but the user only engages them via typeahead, and most searches never touch them. Options:
- compute author/journal facets **on facet-panel open / first keystroke**, not on the main search; or
- drop their inline `size` to the visible top-N (e.g. 25) and fetch the long tail lazily when the user searches within the facet.
Same with the **mentoring per-bucket agg** — it's the heaviest and flag-gated; make it a separate lazy request.

### 4.5 Lower the cardinality precision + audit for a redundant request *(cheap win + the #1285 collapse)*
- `precision_threshold: 4000` on the author `cardinality` is near-exact and expensive; the facet header ("Author 1,619") tolerates ~1–2% error — drop to ~1,000.
- Audit the active-tab + inactive-tab badge flow for a **redundant second request** (the People bug #1285 fixed: a deferred-count architecture was silently issuing a full second query). Confirm the badge `countOnly` calls and the active query aren't double-counting work per render.

### 4.6 Add a requestTimeout guard *(the #1278 / #1017 move)*
The People reason-agg got a `requestTimeout` so a slow broad-concept agg can't tail past the **7s `#1017` nav watchdog** and hard-reload the page. The pub search has **no equivalent guard** — a broad `q=cancer` with all facets can stall. Add a bounded `requestTimeout` (esp. to the facet Request B from §4.1) and degrade to empty/partial facets rather than hanging the navigation.

---

## 5. What does NOT transfer (don't mis-apply)

- **The #1293 key-paper blend (pool-fetch + app-side `rankKeyPaperHitsByBlend`)** is a **top-3** technique: fetch ~50, re-rank in TS, return 3. The Publications tab is a **paginated** list (`from`/`size`, PAGE_SIZE 20, deep pages) — it needs OpenSearch-side sort + paging, so an app-side re-rank of a fetched pool can't produce correct page 2+. Keep relevance ranking in OpenSearch here. *(The blend's tunable knobs are a key-papers concern only.)*
- **Precomputing facet counts onto the doc** — facets are filtered by the live query + other axes, so they can't be denormalized the way `meshSubtreeCounts` was. Only the unfiltered *total* is relaxable (§4.3).

---

## 6. Measurement plan (do this first and last)

- **Baseline before touching code.** Reuse the load-test tooling referenced in `docs/search-people-concurrency-performance.md` §8 (`/tmp/sps-loadtest.sh`) against the Publications tab for a broad query (`q=cancer`, active tab, facets on). Capture p90 at C=1/5/8/10.
- **Representativeness caveat (unchanged from People):** staging is a single `t3.medium.search` and hits a node-capacity wall at ~5 concurrent; prod is `m6g.large.search ×2` Multi-AZ. Per-query latency wins (§4.x) show on staging; the *concurrency ceiling* is a cluster-scale question, not code. Don't chase C=10 on staging.
- **Attribution probe:** the cheapest diagnostic is to run the active query body with `size:0` and **no `aggs`** vs **with the full agg bundle** and compare `took` — that isolates how much of the latency is the facet fan-out (and validates §4.1 before building it).

---

## 7. Suggested sequence

1. Baseline load-test + the `aggs`-on/off `took` probe (§6) — confirm facets are the cost.
2. §4.1 split (facets → Request B) + §4.2 cache + §4.6 timeout — the core win, shipped behind a flag.
3. §4.5 cheap wins (precision_threshold, redundant-request audit).
4. §4.3 (relaxed total) and §4.4 (lazy heavy facets) — each needs a small design sign-off.
5. Re-measure; decide whether any prod cluster-scale change is warranted (likely not for launch traffic).
