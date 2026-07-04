# Handoff — `/search` People reason-agg: hang root cause, fixes shipped, and the go-live scaling plan

**Date:** 2026-06-25
**Status:** root cause confirmed; two interim band-aids shipped (1 deployed to staging); cleaner/scaling fix designed and ready to implement; concurrency load test NOT yet run.

> ⚠️ The canonical checkout is on `docs/spotlight-pipeline`, **~295 commits behind `origin/master`**. Re-ground every code reference below via `git show origin/master:<path>` or a fresh-master worktree before trusting line numbers. All file:line refs here are against **origin/master**.

---

## 1. TL;DR

The `/search` "hangs ~10s on the second search" report (incl. the CIO demo, 2026-06-23 16:58 EDT) is a **slow server-side People render**, not deploy skew / client deadlock / the nav watchdog. On every People search, `searchPeople` fires a **SECOND OpenSearch aggregation over the 178k-doc publications index** to build the per-row "N publications … / key paper" reason line. For broad MeSH concepts × prolific scholars it tails to **5–9s under concurrent load**, blocks the streamed People render, and trips the 7s `#1017` nav watchdog → hard reload → the ~10s hang.

**The reframe (from the user, and the point of this handoff):** fixing the demo is *not* the goal. A demo that buckles on a few concurrent sessions is a **preview of the go-live throughput cliff (~10 concurrent users target)**. We must make the reason line (counts **and** representative/key papers — a feature we want to KEEP) **scale under concurrency**, not switch it off.

---

## 2. Confirmed root cause (with evidence)

- **Streamed render:** People tab shell paints in ~25–300ms (fast TTFB); the results Suspense boundary then `await`s `searchPeople`, which runs the reason agg **synchronously inline** before returning (`lib/api/search.ts` ~2100–2195; the `byAuthor` terms agg, ~line 2141). So the **list cannot paint until the slow agg returns.**
- **The agg:** `terms{wcmAuthorCwids: pageCwids}` over the pub index, per author two `filter` sub-aggs — `tagged` (meshDescriptorUi ∈ resolved concept's descendant set) and `mention` (multi_match title/abstract = literal query) — each with `cardinality(pmid)` + (when `representativePub` on) a `top_hits` sub-agg for the example paper.
- **Cost driver = concept descendant breadth × scholar productivity**, NOT page-author pub volume. Refuted by calibration: the FAST "cancer immunotherapy" page scans MORE pubs (6,703) than the SLOW "aging" page (~5k). The symmetric `mention` scan is cheap; the asymmetric `tagged` cardinality over a broad descendant set is the cost.
- **Evidence (CloudFront access logs, staging, demo window):** bucket `sps-edge-staging-logsbucket9c4d8843-kyqasc6ziviz`, prefix `cf/staging/`, dist `E17NRWINXLP3B3`; use `gunzip -c` (NOT `zcat`) on macOS; field 19 `time-taken`, 28 `ttfb`.
  - `q=Antimicrobial resistance&type=people&pi=multi&pi_min=3` — ttfb **26ms**, time-taken **7.1s**, edge-result **Error** (watchdog aborted the in-flight RSC).
  - `q=aging` — 4.7–9.6s. Narrow/name queries (`javaid`, `pancreatic cancer immunotherapy`) — 0.25–0.32s.
- **Watchdog telemetry:** `search_nav_watchdog` beacon (`lib/analytics/nav-watchdog.ts`) → `/api/analytics` → CloudWatch `/aws/ecs/sps-app-{env}`. Exactly ONE firing in 21 days, at demo time, surface `search_results`. Watch this metric to confirm fixes hold in the wild.

Full diagnosis also in memory: `project_search_reason_agg_hang.md`.

---

## 3. What's been shipped (interim band-aids — NOT the final answer)

| Item | What | State | Note |
|---|---|---|---|
| **PR #1278** | App-side: cap the reason-agg request at `requestTimeout` 1200ms (env `SEARCH_PEOPLE_REASON_AGG_TIMEOUT_MS`, `maxRetries:0`); on timeout skip counts, list still paints. Branch `fix/search-reason-agg-bound`. | **OPEN, review-only, CI running. NOT merged.** | Band-aid: *drops* reason counts on broad searches. tsc clean on file; 10/10 unit tests (new `search-reason-agg-timeout.test.ts` + existing `search-people-result-evidence`). |
| **PR #1280** | cdk: `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` → `off` on staging (match prod). Branch `chore/search-rep-pub-off-staging`. | **DEPLOYED to staging** (`cdk deploy --exclusively Sps-App-staging`, task def verified `off`, stack `UPDATE_COMPLETE`); **PR OPEN, not merged to master.** | Band-aid: removes the **key-papers feature** on staging — the thing we want to keep. Measured win: "aging" 2.4s→1.6s isolated (top_hits ≈0.8s). |

**Decision pending:** the user is reluctant to give up rep/key papers. Options: (a) **revert** the staging flag (restore the feature now), or (b) leave it off as interim load relief until the cleaner fix lands. **Do NOT merge #1280 to master** without a decision (merging makes the feature-off permanent in code). #1278 can stay as a parked safety net.

**Do NOT lower `NAV_WATCHDOG_MS`** (`components/search/autocomplete.tsx` + `transition-link.tsx`): these are slow-but-*completing* renders; a tighter watchdog aborts legit searches and the hard-reload re-runs the same slow agg.

---

## 4. Cleaner-fix design (investigation complete — evidence-backed)

Goal: keep counts + key papers; make them scale to ~10 concurrent. Findings (origin/master):

| # | Fix | Finding | Feasibility | Evidence |
|---|---|---|---|---|
| **A** | **Drop redundant `cardinality(pmid)`** → use the filter agg's intrinsic `doc_count` | Pub index is **one doc per pmid** (`_id = pmid`), so a filter's `doc_count` already == distinct-pmid count. The cardinality agg is wasted CPU. | **CHEAP** (no reindex, no UI change, semantics-preserving) | `etl/search-index/index.ts:288` (`id: pmid`); agg at `lib/api/search.ts:~2159` |
| **B** | **Decouple the reason line from the LIST render** | The list awaits the full `searchPeople()` result (incl. reason data) before painting. Split it: return hits first (9k people index, fast), stream the reason line in a nested boundary / follow-up fetch. | **CHEAP** (restructure only) | `app/(public)/search/page.tsx:~989` (awaits resultPromise); reason agg inline at `lib/api/search.ts:~2112`; card consumes `hit.matchReason` (`components/search/people-result-card.tsx`) |
| **C** | **Reason-agg result cache** (LRU / `unstable_cache`, key = `[pageCwids, meshDescendantUis, contentQuery]`) | No caching today — search route is `force-dynamic`, every request hits OpenSearch fresh. | **CHEAP** (no infra) | `app/api/search/route.ts:45` |
| **D** | **Precompute per-descriptor counts** onto the people doc (`{descriptorUi: pubCount}`) → "tagged" count becomes a lookup over descendant UIs, **eliminating the pub-index agg** | People doc already carries a FLAT `publicationMeshUi: string[]` (deduped UIs, ≥2-pub threshold) but **no per-descriptor counts**. | **NEEDS REINDEX** (new field + rebuild) | `lib/search-index-docs.ts:716–751`; mapping `lib/search.ts:175` |
| **E** | **Precompute key papers** (`topPubs:[{pmid,title,year}]`) onto the people doc → eliminate the `top_hits` sub-agg | No such field exists in either index today. | **NEEDS REINDEX** (do alongside D if pursuing) | schema/mapping searches all negative |

### Recommended sequence (ROI order)
1. **A + B + C together** — all CHEAP, no reindex. A removes wasted CPU; **B is the structural fix** (list never blocks on the agg, so a slow agg degrades to "reason line streams in late," never a hang); C absorbs concurrent/repeat load. This likely clears the ~10-concurrent target while KEEPING the feature.
2. **Measure under load** (section 5). If the cluster still saturates on the agg itself under concurrency, escalate to **D (+E)** — the reindex that removes the pub-index round-trip entirely. D is the true scalability fix but costs a reindex + backfill.

Note: with the feature KEPT, re-enable `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` (revert #1280) once B/C are in — or implement E so key papers are precomputed and cheap.

---

## 5. Load test — the actual acceptance gate (NOT yet run)

The real test is **concurrency, not isolated latency.** Target: ramp to **~10 concurrent** broad-concept People searches and find where p90 / errors break.

⚠️ An in-session attempt to run this from the shell was **declined** — confirm with the user how they want it driven (a dedicated tool like `k6`/`vegeta`/`hey`, or explicit OK to fire from the shell). Ready-to-run shell version:

```bash
BASE="https://scholars-staging.weill.cornell.edu/search"
QS=(aging cancer diabetes inflammation immunotherapy obesity hypertension depression asthma microbiome)
TMP=$(mktemp -d)
one(){ curl -s -o /dev/null -w '%{time_total} %{http_code}\n' --max-time 45 "$BASE?q=$1&type=people"; }
for C in 1 2 3 5 8 10; do
  : > "$TMP/c$C"
  for r in 1 2 3; do for i in $(seq 1 $C); do one "${QS[$((RANDOM%${#QS[@]}))]}" >> "$TMP/c$C" & done; wait; done
  awk -v C=$C '{t[NR]=$1; if($2!=200)bad++} END{n=asort(t); printf "C=%2d n=%2d p50=%.2f p90=%.2f max=%.2f non200=%d\n",C,n,t[int(n*.5)||1],t[int(n*.9)||1],t[n],bad+0}' "$TMP/c$C"
done; rm -rf "$TMP"
```

`time_total` on the streamed `/search` doc = full render incl. the reason agg. Look for: where p90 crosses ~7s (watchdog territory), and where non-200s (5xx / curl timeouts) appear. **Caveat:** staging currently has rep-pub **off** (#1280), so this measures the post-flag state (cardinality cost only). To characterize the original/full feature, re-enable rep-pub first, or test before/after each cleaner fix. Also worth watching during the run: OpenSearch **search thread-pool queue/rejections** (the saturation signal) and the `search_nav_watchdog` beacon rate.

---

## 6. Open decisions / next actions
1. **Rep/key papers on staging:** revert #1280 (restore feature now) or keep off as interim relief? (User leans toward keeping the feature.)
2. **Run the load test** (≤10 concurrent) — get the breaking-point numbers. Decide the tool (shell run was declined).
3. **Implement A+B+C** (cheap, no reindex), re-measure under load.
4. If still saturating → **D (+E)** reindex (per-descriptor counts + precomputed key papers).
5. **#1278 / #1280**: park as safety nets; don't merge #1280 to master pending decision #1; revisit #1278 once B lands (the cap matters less once the list doesn't block on the agg).

---

## 7. Gotchas / operational notes
- **Branch drift:** canonical checkout is 295 behind master — re-ground all refs via `git show origin/master:` or a fresh worktree off `origin/master`.
- **Staging cdk deploy recipe (worked):** fresh-master worktree, edit `cdk/lib/app-stack.ts`, `npx jest app-stack -u` (refresh CFN snapshot), `npx cdk diff Sps-App-staging -c env=staging` (verify), `npx cdk deploy --exclusively Sps-App-staging -c env=staging --require-approval never`. NO `-c stagingAccount`. `--exclusively` skips unrelated `Sps-Network-staging` resolver-assoc drift. Default `reciter` profile = staging acct **665083158573**. cdk env-var change rolls a new task def with the CURRENT image (no image build needed).
- **App PR (#1278) deploy** needs a **merge → CD image build** (CD ships images; cdk ships infra/env). Staging+prod both get it on merge.
- **macOS:** `gunzip -c` not `zcat` for `.gz`; `gzcat` also works.
- **Worktrees:** clean up with `git worktree remove --force` + `pkill -f 'vitest|esbuild|tinypool'`. Symlink `node_modules` + `cdk/node_modules` + `lib/generated` from canonical to skip `npm ci` (deps stable enough for tsc/jest/cdk; prisma client is stale → ignore prisma-model tsc errors, they vanish in CI).
- **Don't** run `prisma generate` through a symlinked `lib/generated` — it would clobber the canonical checkout's client.
