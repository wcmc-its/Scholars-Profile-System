# Search & Faceting Performance Audit — 2026-07-02

> **Outcome addendum (end of day 2026-07-02).** This audit is preserved as written that
> morning; the same day, tracker **#1415** landed the Tier-1/Tier-2-adjacent fixes:
> #1416/#1417/#1418/#1420/#1421/#1423 plus compression follow-ups #1428/#1431/#1433
> (the compression mechanism is documented in
> [`cloudfront-cache-spec.md` §Compression](./cloudfront-cache-spec.md)). Staging is fully
> deployed and verified: pubs/funding `taxonomy;dur=0` (was ~460–500 ms warm), repeat
> publications searches 69–84 ms (facet-split cache), wire size 196,315 → 39,275 bytes
> (−80 %). Prod flags are deployed but inert pending the prod image release; § 0's staging
> outage was transient item-3 cutover fallout, resolved the same afternoon (#1402).
> Still open: #1408–#1414 (issue-only wins) and umbrella #861. Current status lives on
> #1415, not in this file.

Audited against `origin/master` @ `baca61e0` (read-only worktree; canonical checkout was 387 commits behind).
Six-agent review: query pipeline, taxonomy matcher, facet strategy, client fetch behavior, index design, plus an
empirical latency probe. Prod numbers below come from the live `Server-Timing` header on `/api/search`
(`taxonomy;dur=…`, `search;dur=…`) and `curl -w` wire measurements.

## 0. URGENT (operational, found incidentally): staging search is DOWN

Every OpenSearch-backed staging endpoint (`/api/search` people/publications/faceted, `/api/search/suggest`)
hangs until CloudFront's ~90s origin-response timeout and returns **504** (`x-cache: Error from cloudfront`,
no `Server-Timing`, i.e. the origin handler never completes). Controls prove it is NOT app cold-start:
`/api/health` forced-to-origin = 200 in ~65ms; SSR homepage = 200 in ~1.2s at the same moments. The failure is
isolated to the OpenSearch round-trip / suggest / taxonomy-search path.

Prime suspect: the most recent master commit `baca61e0` — *"cdk(item-3): flip staging openSearchNodeFromSecret ON
(OS-endpoint decouple)"* — i.e. the in-flight item-3/VPC-consolidation work plausibly left the staging app pointed
at an OS endpoint it can't reach. **All staging A/B tracks (#1359, #1366 rollout, concentration 3-cell) are blocked
until this is fixed.** Prod search is healthy (measured directly).

## Measured baseline (prod, warm)

| Query | taxonomy (matchQueryToTaxonomy) | search (OS) |
|---|---|---|
| `q=diabetes` (people) | 487–595 ms (1,888 ms cold) | 182–378 ms |
| `q=cancer` | 536 ms – 2,174 ms | — |
| `q=smith` (no taxonomy match) | 25–50 ms | — |
| `type=funding&q=diabetes` | 460 ms | 118 ms |

- **The taxonomy resolver, not OpenSearch, dominates warm latency** on every taxonomy-matching query, on all three tabs.
- Publications JSON response: **177.7 KB on the wire, uncompressed** (Accept-Encoding sent and ignored); 136 KB (77%) is two 500-bucket facet lists.
- OS round trips per request: 1 (name/browse) to 3 serial (concept people query), plus a **fully duplicated people search in prod** (see Win 1).

---

## Ranked wins

### Tier 1 — small effort, large measured impact

**1. Flip `SEARCH_PEOPLE_REASON_FROM_DOC=on` in prod** *(trivial; flag flip via cdk app-stack.ts)*
Prod (`app-stack.ts:1405` staging "on" / prod "off") runs the **entire people search twice per people-tab SSR
render** — `page.tsx:519-525` (skipReasonAgg:true) then `page.tsx:532-545` fires a second complete
`searchPeople` from which only the reason lines are read; hits, totals, all 9 facet aggs, highlight, and hydration
are discarded. The second call also runs the publications-index reason aggregation — the documented 5–9s
concurrency hotspot (`reason-agg-cache.ts:4-8`). The replacement is already built AND already indexed: every
people doc carries precomputed `meshSubtreeCounts`/`methodFamilyCounts`/`areaCounts`
(`lib/search-index-docs.ts:857-898`), read O(1) from `_source` when the flag is on (`search.ts:2711-2718`).
Staging has run this way for a while.
*Effect: halves prod people-index query volume + facet-agg compute on the default tab; kills the 5–9s tail.*
*Prereq: verify the prod people index carries `meshSubtreeCounts` (prod `search:index` ran 2026-07-01 off the
Jun-22 image — confirm that image's indexer included the field; any doc with the field non-null proves it).*

**2. Enable compression on `/api/search*` at CloudFront** *(small; one EdgeStack deploy)*
`cdk/lib/edge-stack.ts:501` puts `/api/search*` under the managed `CACHING_DISABLED` cache policy, whose
gzip/brotli support flags are OFF — so `compress: true` (:703) never fires and 178 KB ships raw. Replace with a
custom CachePolicy: minTtl 0 / maxTtl 1 (still effectively no-store) but
`enableAcceptEncodingGzip/Brotli: true`. → ~178 KB → ~20–30 KB.
*Deploy with the mandatory `-c env/edgeCustomDomain/edgeCertArn/edgeAllowedCidrs` context flags.*

**3. Cache the taxonomy-match pipeline (the dominant cost), in stages:**
- **3a. SWR-cache `getCounts`** *(small, ~10 lines)*: `search-taxonomy.ts:415-458` runs 2
  `publicationTopic.groupBy` per matched candidate × up to `MATCH_HARD_CAP=25` = **50 group-bys per request**,
  transferring one row per distinct cwid/pmid *just to `.length` them*. They queue on the tiny Fargate Prisma pool
  (~3-5 conns) and sit serially before the OS query. Wrap in `lib/api/swr-cache.ts` `cachedRead`
  (15-min fresh / 1-h stale) keyed `taxonomy-counts:{type}:{id}` — data changes only at nightly ETL.
  Longer term: precompute the counts as Topic/Subtopic columns at ETL time.
- **3b. Pubs/funding branches: call `resolveMeshDescriptor(q)` instead of full `matchQueryToTaxonomy`** *(small)*:
  `route.ts:122-190, 250-283` consume ONLY the MeSH resolution (module-cached, O(1) warm); the whole 25-candidate
  Prisma enrichment is computed and discarded. Funding tab measured: 460 ms taxonomy for 118 ms search.
- **3c. Snapshot the candidate list cross-request** *(medium)*: `loadEntityCandidates` re-fetches ~1.6k
  topic/subtopic rows (3 Prisma queries) per request; React `cache()` is request-scoped. Reuse the in-file
  MeSH-map manifest-sha idiom (`search-taxonomy.ts:899-1024`). Keep #800/#801 overlay liveness by loading the tiny
  overlay gate per request and filtering at match time.
- **3d. Memoize the whole `TaxonomyMatchResult`** keyed by `normalizeForMatch(q)` (bounded LRU, ~15 min): facet
  toggles / sort / pagination are `router.push` soft-navs that re-run the resolver with an **identical q**.
- **3e. Cap method-family enrichment** *(trivial)*: `search-taxonomy.ts:726-740` enriches EVERY matched method
  family (2-3 queries each, multi-thousand-pmid IN-lists) before slicing to 5; topics pre-cap at 25, methods don't.
  Pre-rank and cap at ~10.
- **3f. Drop the duplicate `loadFamilyOverlayGate` call** *(trivial)*: loaded at :347-357 and again at :681-682.

*Sizing/verification for all of Tier 3: `taxonomyMatchMs` is already in every `search_query` log — pull p50/p95
split by matched-vs-not before and after.*

**4. Cache the per-interaction invariants (badge counts + taxonomy) so a facet toggle only pays the active-tab search** *(small)*
Every facet/sort/page click re-renders the SSR page end-to-end: taxonomy resolution + **3 badge count-only OS
queries** + full search. The badge counts are provably invariant across facet toggles (user axes live in
`post_filter`, excluded from the count bodies — `search.ts:2055-2068`, `3823-3830`). TTL + inflight-dedup cache
(the `cachedReasonAgg`/`cachedHomeRead` idiom) keyed on `[q, scope, resolution, flags]`.

### Tier 2 — medium effort or second-order

**5. Shrink the publications facet payload** *(medium, independently shippable pieces)*
500 journal + 500 author buckets = 136 KB of the 178 KB response; only 8 rows render until expand. Each bucket
ships a fully-materialized `toggleHref` URL and authors ship a derivable `identityImageEndpoint`; author buckets
drive a ≤500-row Prisma `scholar.findMany` per request. → Build toggle URLs client-side (the facet components are
already client components), ship bare `{value,count}`, cap terms size ~100 with a tiny search-within endpoint for
the tail, drop the header-count cardinality `precision_threshold` 4000→1000 (parked commit already validated
~1-2% error).

**6. Revive parked `927c35dd` (pub facet split, `origin/perf/pub-tab-facet-split`)** *(small)*
Verified it still applies to master — its pre-image lines survive; expect only import + cdk-snapshot conflicts.
Splits pub hits from aggs (parallel, not serial-in-one-request), wraps the agg request in the 5-min
`cachedReasonAgg` cache (facet counts are page/sort-invariant → pagination becomes agg-cache-hit), adds a 5s
facet timeout. Flag-off byte-identical. It was parked because taxonomy dominated — after Tier-1 items 1–4 this
becomes the next visible win. Rebase → full vitest → deploy flag-off → flip staging-first.

**7. Trim publications `_source` + retire per-hit Prisma author hydration** *(trivial + medium)*
Pub search has NO `_source` include list (people search carefully trims); each hit ships `meshTerms`, nested
`wcmAuthors`, etc. that the Hit type never reads — authors are re-fetched from Prisma anyway (2 waves, the second
serial: `search.ts:4128-4142`, `4194-4196`), because indexed chips lack `isFirst/isLast/roleCategory`. Step 1
(now): add the include list. Step 2 (next rebuild): index the missing chip fields and read chips from `_source`;
the suppression reconciler already reindexes affected docs.

**8. Client request-count reductions** *(small each)*
- Up to **20 eager `/grants` XHRs per People render** (`people-result-card.tsx:187-221`, fires on mount, each
  running a full server-side `searchFunding`) → gate on IntersectionObserver or expand.
- Same for lone-secondary exemplar/key-paper fetches (mount-eager).
- `prefetch=false` on facet/pagination/sort links ("Show all" can expose ~200 links, each viewport-prefetching).
- Suggest: good debounce+abort but zero caching — add a small client LRU (backspace retreads) and/or short server TTL.
- Consider Next `staleTimes` so tab flips/back-nav don't refetch everything (default dynamic staleTime is 0).

**9. Stop re-embedding the full lexical `must` clause in every excluding-self facet agg** *(medium)*
People 9×, pubs ~11×, funding 10× per request re-evaluate the cross_fields multi_match inside filter-context aggs
(`search.ts:2137-2226`, `3777-3790`, `search-funding.ts:595-638`). Aggs already run in the main query's scope;
the embedded `must` is a strict superset re-check — removing it is behavior-identical for filter-context aggs.
Needs a dedicated PR with agg-parity assertions per query shape (touches snapshots broadly).

**10. Process-cache static-vocabulary Prisma reads on the hot path** *(small)*
Whole `topic.findMany` table per `searchPeople` call when evidence/match-aware flags are on (`search.ts:2952`),
plus 3 dept/div/center label queries per SSR render (`page.tsx:1077`). Module-level TTL cache (labels change
nightly).

### Tier 3 — ETL / housekeeping

- **People index rebuild is a serial N+1**: ~6 sidecar Prisma queries × ~9k scholars ≈ 50k+ serial round trips
  per nightly rebuild (`etl/search-index/index.ts:212-219`). Batch-preload maps (like `meshAncestors`) or p-limit
  8-16. Index-build wall-time only; matters for reindex-then-flip rollouts.
- **Mentoring facet inlines raw pmid term lists** into every full pub-search body (`search.ts:4028-4045`) —
  *measure first* (`JSON.stringify(body).length`); if large, index a `mentoringPrograms` keyword field at ETL time.
- **`attributionMatch` agg is telemetry-only** (no UI reads it) yet computed on every concept people search —
  and doubled in prod by Win 1. Sample it or drop it.
- **Funding `endDate` painless script sort** (the only script in the system) → index `endDateWithGrace` at next
  rebuild.
- `SEARCH_PEOPLE_CONCEPT_PRECOUNT`: code default ON adds a serial size:0 OS hop, but deployed envs already set it
  off (per app-stack read) — align the code default; verify with the `osRoundTrips` SLI.

## What's already good (no action)

- MeSH concept resolution: module-cached ~31k-descriptor map, 1h manifest-sha invalidation, boot-warmed via
  `lib/warmup.ts`; warm cost ≈ 0 DB.
- Mappings: every facet agg targets keyword/bool/int doc_values; zero `fielddata`; no runtime scripts in scoring
  (sparse-decay scalars deliberately materialized at index time); `enabled:false`/`index:false` used correctly for
  source-only payloads; default sharding appropriate for 9k/178k-doc indices.
- Facets computed as aggs inside the hits request (no per-facet round trips); inactive tabs use size:0 counts.
- Autocomplete debounce (150ms) + AbortController; 20 results/page so no virtualization need.
- Instrumentation is in place to verify every one of these wins: `Server-Timing` (taxonomy vs search),
  `taxonomyMatchMs` + `osRoundTrips` in the `search_query` structured log.

## Suggested sequence

1. Fix staging search (item-3 fallout) — blocks all staging verification.
2. Win 1 (prod flag flip, after index-field verify) + Win 2 (edge compression) — both config-only.
3. Tier-1 item 3 (taxonomy caching PR: 3a/3b/3e/3f first, then 3c/3d) + item 4 (badge/taxonomy invariant cache).
4. Re-measure p50/p95 from `search_query` logs; then Tier 2 by observed residuals (facet payload → facet split
   revival → `_source`/hydration → client fan-out → agg must-clause).
