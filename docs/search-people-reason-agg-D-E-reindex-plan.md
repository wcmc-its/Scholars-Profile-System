# Plan — precompute People reason counts (D) + lazy on-the-fly key papers: take the publications-index agg off the search path

**Date:** 2026-06-25
**Status:** PLAN — awaiting approval before implementation.
**Predecessor:** `docs/search-people-reason-agg-scaling-handoff.md` (A+B+C). A+B+C merged (#1281, `c92743d9`) and live on staging.
**Grounded against:** current master + A+B+C, worktree `~/worktrees/sps-search-agg`. All file:line refs below are from that tree.

---

## 1. Why (the load-test evidence that triggers this)

A+B+C shipped and was load-tested on staging (rep-pub off, isolating the effect):

| C | total p90 before | total p90 after |
|---|---|---|
| 1 | 2.27s | 2.17s |
| 2 | 6.56s | 2.98s |
| 5 | 8.56s | 7.32s |
| 8 | 11.17s | 8.01s |
| 10 | 16.76s | 13.64s |

- **Single/low concurrency: solved.** Cold `aging` 8.45s → 2.87s; A made the per-query agg cheap.
- **~10 concurrent: NOT solved.** Still ~13.6s p90.
- **Root cause at high concurrency = OpenSearch cluster saturation, not per-query cost or app structure.** Proof: identical cold queries run **sequentially** = 0.83–1.49s each, but **5 concurrent** = 4.1–4.9s *each* (~4×). At C=10, list-paint p90 (13.78s) ≈ reason-arrive (13.76s): B's decouple buys nothing because the list's *own* people-query is stuck in the same saturated search thread pool.

**What this changes:** each People search currently issues **two** OpenSearch round-trips — the people-index query (list) **and** the publications-index reason agg (counts + key-paper `top_hits`). The fix:
- **D — precompute the counts** onto the people doc → the **initial concept search issues zero publications-index queries**.
- **Key papers — keep them real (concept-specific, highlighted) but fetch them on-the-fly, lazily** (only for cards the user views), off the critical path. NOT precomputed (see §5).

Result: the broad-concept initial render drops from 2 queries to 1 (people index only); key papers trickle in on demand, scaled to attention. That removes the publications-index load from the path that saturates. (Cluster sizing — staging is a t3.small — is a separate, complementary lever; see §9.)

---

## 2. What stays a runtime query (honest scope)

The reason line has three branches (priority order, `composeMatchReason` `lib/api/search.ts:390-414`):

1. **tagged** — "N of M publications tagged *{concept}*" — fires when the query resolved to a MeSH concept (`meshDescendantUis` non-empty). **This is the expensive/broad path that saturates.** → **D precomputes it.**
2. **mention** — "N of M publications mention \"*{query}*\"" — free-text title/abstract match on an **arbitrary** query string. **Cannot be precomputed** (unbounded input). Stays a runtime agg, but it's the cheap symmetric scan (handoff §2) and is **skippable when the tagged branch already fires** (the common concept-search case).
3. **concept** — "via related concept *{concept}*" — pure fallback, no count. Free.

So D+E's achievable win: **concept searches (the slow case) drop to a single OpenSearch query.** Free-text-only searches still issue one cheap mention agg. That matches where the load test hurts.

---

## 3. Current state (grounded refs)

| Piece | Location |
|---|---|
| Reason agg (byAuthor terms → tagged/mention filters, doc_count) | `lib/api/search.ts:2176-2242` |
| Concept resolution → descendant set | `matchQueryToTaxonomy` `lib/api/search-taxonomy.ts:597`; `MeshResolution.{descriptorUi, descendantUis}` `:136-165` (descendantUis capped at 200) |
| rep-pub top_hits (gated `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB`) | `lib/api/search.ts:2142-2159`; parse `:360-378` |
| matchReason shape `{icon,text,pub?}` / composeMatchReason | `lib/api/search.ts:296-300, 390-414` |
| skipReasonAgg + streamed 2nd call (B) | `lib/api/search.ts:2124-2134`; `app/(public)/search/page.tsx:438-460` |
| People doc builder; per-descriptor distinct-pub counts already in `uiAgg` | `buildPeopleDoc` `lib/search-index-docs.ts:658`; `uiAgg` `:695`; threshold `:785-787` |
| People pub select (needs pmid/year/citationCount added) | `lib/search-index-docs.ts:401` |
| People index mapping; source-only `object enabled:false` pattern | `lib/search.ts:84-288` (e.g. `topMeshTerms` `:190`) |
| Reindex: full rebuild + atomic alias swap (no partial update) | `etl/search-index/index.ts:589`; `etl/search-index/alias-swap.ts` |
| Run: `npm run search:index:people` / `tsx etl/search-index/index.ts --people-only`; staging = ECS run-task | `package.json:30-32`; `cdk/lib/etl-stack.ts:858,891` |

**Key fact:** OMIT-on-empty doc fields + full-rebuild-per-reindex means **the rebuild *is* the backfill** — no separate backfill job. ~9k people docs, multi-minute.

---

## 4. Design — D (tagged count from the doc)

The tagged count = **distinct** scholar pubs tagged with **any** descriptor in the concept's subtree. Two ways to precompute:

### D-exact (recommended) — subtree-count map keyed by concept descriptor
Store on the people doc: `meshSubtreeCounts: { [conceptDescriptorUi]: distinctPubCount }`, where the count is the scholar's distinct pubs having ≥1 descriptor **in that concept's subtree**.

- **Build:** for each scholar pub, expand its descriptor UIs to their **ancestor** descriptors (via MeSH tree-number prefixes — the same tree data `search-taxonomy.ts` already uses), union the ancestors **within the pub** (so a pub counts once per concept), then increment each ancestor concept's distinct-pub counter. Exact.
- **Query:** look up `doc.meshSubtreeCounts[meshResolution.descriptorUi]` — **O(1), exact, no sum.** (We index by the resolved *root* concept, so we don't even iterate `descendantUis`.)
- **Cost:** larger field — a prolific, broad scholar may have ~1–3k ancestor-concept entries (~10–30 KB source-only). Bounded; measure the field-size distribution in a dry-run build (§8) and, if needed, cap by tree depth or to search-eligible descriptors.

### D-approx (fallback) — per-leaf-descriptor counts + query-time sum
Reuse `uiAgg` directly: store `meshDescriptorCounts: {ui: distinctPubs}` (already computed at `:695`), sum over `meshDescendantUis ∩ doc.keys`, cap at total. Smaller field, but **overcounts** pubs carrying ≥2 in-set descriptors — worst exactly for broad concepts (where it matters most). Acceptable only if we accept the reason line as a soft/approximate signal.

**Recommendation: D-exact.** It's exact, the query op is a single lookup, and build cost is the only price. Decision gate in §11.

`total pub count` (the "M" / "975 pubs") is already on the doc.

---

## 5. Design — key papers: keep concept-specific, fetch on-the-fly (lazy/async) — NOT precomputed

**Decision (2026-06-25): do NOT precompute key papers (no E).** Concept-specific key papers can't be precomputed (scholar × every-possible-concept = combinatorial); precomputing forces a lossy *scholar-level* paper with no query highlight. Key papers are a core value prop — keep them real.

Instead, keep the existing runtime `top_hits` (concept-filtered, `<mark>`-highlighted — `lib/api/search.ts:2142-2159`) but change **when** and **how many** we run:

- **Off the critical path:** B already streams the reason line after the list paints. Keep that.
- **Lazy, per viewed card:** fetch the key paper for a card only when it enters the viewport / is expanded (IntersectionObserver or expand handler), via a small per-card (or per-visible-batch) server action — `topHits` filtered to one scholar + the concept, sorted, highlighted. Most searches → the user views the top 3–5 cards, so we issue a handful of tiny queries instead of a 20-bucket `top_hits` for everyone up front.
- **Cache (C) dedupes** by `(cwid, concept)` so re-views and re-searches are free.

Why this beats precompute: the paper stays **exactly the current feature** (concept-tagged, highlighted), and because D removes the count agg, the **initial** concept search issues **no** publications-index query at all — key papers arrive a beat later, scaled to attention, naturally rate-limited under load.

Cost vs today: today = 1 batched `top_hits` over all 20 page authors per search. New = N tiny queries where N = cards actually viewed (typically 3–5), spread over scroll time, off-path. Net cluster load drops in the common case; worst case (user scrolls all 20) is comparable total work but spread + deferred. Optionally batch the visible viewport into one query to bound N.

---

## 6. Mapping + builder changes

**Mapping** (`lib/search.ts` peopleIndexMapping, source-only — never searched):
```ts
meshSubtreeCounts: { type: "object", enabled: false },   // D-exact — the only new field
```
(No `topPubs` — key papers stay a runtime query, §5.)

**Builder** (`buildPeopleDoc` `lib/search-index-docs.ts`):
- After the existing MeSH loop (~`:793`): build `meshSubtreeCounts` (ancestor-expand each pub's descriptors, union within the pub, distinct-count per ancestor concept), emit OMIT-on-empty. No pub-`select` change needed (the MeSH UIs are already in scope at `:766`).
- Needs the MeSH tree ancestor map in the ETL build context — factor the tree-number→ancestor logic out of `search-taxonomy.ts` so the resolver and the builder share one implementation (avoid divergence).

---

## 7. Query-path changes

**Counts (D), in `searchPeople` behind a flag (§9):**
1. Read `meshSubtreeCounts` from each people hit's `_source` (already fetched — no extra query).
2. If the query resolved to a concept (`meshResolution.descriptorUi` present): tagged count = `meshSubtreeCounts[descriptorUi] ?? 0`. Build the matchReason text via the existing `composeMatchReason` (unchanged shape `{icon,text,pub?}`), with `pub` omitted at this stage.
3. **Only if** tagged == 0 **and** a free-text mention is possible: issue the cheap **mention-only** runtime agg (no tagged filter, no `top_hits`). Otherwise the initial render issues **no** publications-index query.

**Key papers (lazy/async), new per-card path:**
4. New server action `fetchKeyPaper({ cwid, descriptorUis, contentQuery })` → the existing `top_hits` (size 1–3, concept filter, sort, `<mark>` highlight), scoped to one scholar. Returns the same `RepresentativePub` shape.
5. The result card calls it when it enters the viewport / is expanded; the paper patches into the already-rendered reason line (extend the B streaming patch, `people-result-card-streamed.tsx`). Optionally batch the visible viewport into one call to bound query count.
6. Cache (C) keyed `(cwid, descriptorUi|contentQuery)` dedupes re-views/re-searches; the old whole-page reason-agg cache key is retired for the doc-sourced path.

Net: concept search initial render = **1 query** (people index); key papers = a few tiny deferred queries for viewed cards. Free-text search = people query + 1 cheap mention agg + lazy key papers.

---

## 8. Reindex / rollout

1. Land mapping + builder + query changes behind flag (default off), CI green.
2. **Dry-run build** locally against the local OpenSearch docker (people ~9k): verify the new fields populate, **measure `meshSubtreeCounts` field-size distribution** (p50/p99/max) to confirm doc bloat is acceptable; spot-check counts vs the live agg for parity (D-exact should match within rounding; sample broad + narrow concepts).
3. Staging reindex: `tsx etl/search-index/index.ts --people-only` via the in-VPC ECS run-task (creates `scholars-people-v{N+1}`, atomic alias swap, prunes old) — the rebuild is the backfill.
4. Flip the flag on staging (cdk env-var deploy, `--exclusively Sps-App-staging`), render-verify reason-line parity.
5. **Re-run the load test** (`/tmp/sps-loadtest.sh`, `/tmp/sps-satcheck.sh`): expect concept searches' initial render to drop to one query → C=10 p90 materially down. This is the acceptance gate. Note key papers are now lazy, so measure both initial-render latency (should clear) and the lazy key-paper fetch under a viewport-driven load.
6. Key papers ride the new lazy path (independent of the old `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` inline-top_hits flag); #1280 stays as-is — the inline batched top_hits is replaced, not re-enabled.
7. Prod: own reindex + flag flip via gated `workflow_dispatch env=prod`.

---

## 9. Cluster sizing (complementary, not part of this PR)

Even with D+E, the t3.small staging node may still saturate at high concurrency on the *people* query alone (the saturation finding). Before declaring a go-live number: confirm the **prod** OpenSearch instance size and whether it meets the ~10-concurrent target, independent of D+E. D+E reduces load; sizing sets the ceiling. Recommend measuring prod headroom after D+E lands.

---

## 10. Tests

- Unit: builder emits correct `meshSubtreeCounts` (ancestor-expansion + distinct dedupe — the double-count trap); a fixture scholar with one pub tagged by two in-subtree descriptors must count **once** for the ancestor concept.
- Unit: query-path produces the **identical** count text from `meshSubtreeCounts` vs the old agg for representative concept/free-text/no-match cases.
- Unit: `fetchKeyPaper` returns the same `RepresentativePub` shape (pmid/title/titleHtml/year) as the old inline `top_hits` for a given (cwid, concept).
- Parity: scripted diff of reason lines (agg vs doc) across a sample of concepts on staging before flipping the flag.
- Load: §8.5 re-run, including a viewport-driven key-paper fetch pass.

---

## 11. Open decisions (need your call before/while building)

1. **D-exact vs D-approx** — recommend **D-exact** (exact, O(1) lookup; cost = larger doc field, to be measured in the §8 dry-run). Approve, or prefer the smaller approximate field?
2. **Key papers = lazy runtime (resolved 2026-06-25):** keep concept-specific, highlighted key papers; fetch on-the-fly per viewed card (§5). No precompute, feature fully kept. ✓
3. **Lazy granularity** — per-card fetch (simplest) vs batch-the-visible-viewport into one call (bounds query count). Recommend starting per-card + cache, batch only if the load test shows it's needed.
4. **Flag** — new flag `SEARCH_PEOPLE_REASON_FROM_DOC` (recommended: staging-first, parity A/B, instant rollback) — OK?
