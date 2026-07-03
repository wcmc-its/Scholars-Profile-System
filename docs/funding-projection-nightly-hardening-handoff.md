# Nightly opportunity-projection — hardening & wipe-guard handoff

**As of:** 2026-06-23, master `d1a91c35` (PR #1237 merged). **Tracker:** #1218.
**Author goal:** *hard*-confirm `etl:dynamodb` runs cleanly every night, and guard against a
hiccup wiping today's good data. **Context: high-stakes presentation tomorrow (2026-06-24).**

This is self-contained — a fresh session can execute from here.

---

## 0. TL;DR / the one decision before the presentation

The opportunity corpus was freshly projected today (**802 opportunities**, run `manual-verify-…16134`
SUCCEEDED 2026-06-23 08:23 ET). The funding-matcher data the demo likely uses is **safe** — that
table is upsert-only and a failed run can't empty it.

**But two profile tables (`topic_assignment` = profile Topics, `scholar_tool` = Methods & Tools) are
wiped-and-recreated non-transactionally with no empty-source guard. A bad nightly run can leave them
empty for up to 24h.** The 06:30 UTC schedule fires **before** a US-morning demo.

**Recommended immediate action (pick one, do tonight):**
- **Freeze (simplest, zero-risk):** disable the EventBridge rule until after the talk — today's data
  is already fresh, so nothing can change or wipe it. Re-enable after.
  `aws events disable-rule --name sps-opportunity-projection-staging`
  (re-enable: `aws events enable-rule --name sps-opportunity-projection-staging`)
- **Snapshot, then let it run:** take a manual Aurora snapshot now as a precise restore point
  (`aws rds create-db-cluster-snapshot`), and let the 06:30 run proceed. Heavier to restore.

Freeze is the lazy correct move for one night. The hardening below makes future nights safe so you
don't have to freeze again.

---

## 1. What's deployed now (state)

- **PR #1237 merged** (Steps 2 + 3 of the funding-matcher work). Step 3 (app: grant-history join)
  is in master but reaches staging only on the next **app image roll** (CD `:latest`).
- **`cdk deploy Sps-Etl-staging` done** (2026-06-23). Created the standalone projection schedule:
  - State machine `scholars-opportunity-projection-staging` (single step → `npm run etl:dynamodb`).
  - EventBridge rule `sps-opportunity-projection-staging`, **ENABLED**, `cron(30 6 * * ? *)` (daily 06:30 UTC).
  - Cadence alarm `sps-opportunity-projection-cadence-staging` → ETL failure SNS topic.
  - Catch → SNS on a failed run.
  - Gated on `opportunityProjectionScheduleEnabled` (staging `true`, **prod `false`**).
- That deploy also caught staging's **Nightly/Weekly** state machines up to master (bundled, approved).
- Verified end-to-end: a manual execution SUCCEEDED and logged `opportunity upserts complete: 802 rows`.

---

## 2. The wipe risk — confirmed analysis (`etl/dynamodb/index.ts`)

`etl:dynamodb` projects ReciterAI's `reciterai` DynamoDB table into MySQL. Per-block destructiveness:

| Block | Table | Write pattern | Wipe-safe? |
|---|---|---|---|
| grant-opportunity-etl.ts | `opportunity` | `upsert` per id | ✅ safe (never deletes; stale opps just linger) |
| index.ts Block 2 | `publication_topic` | `upsert` (pmid,cwid,topic) | ✅ safe |
| index.ts core block | `core` / `publication_core` | `upsert` | ✅ safe |
| index.ts topic block | `scholar` metrics | `update` only | ✅ safe |
| **index.ts ~L534** | **`topic_assignment`** | **`deleteMany()` then loop `createMany()`** | ❌ **at risk** |
| **index.ts ~L741** | **`scholar_tool`** | **`deleteMany()` then loop `createMany()`** | ❌ **at risk** |

Why the two are dangerous (both verified in the code):
1. **Not transactional.** `deleteMany()` and the `createMany()` batch loop are separate awaits. A
   task timeout (SM 65 min / task 60 min), OOM, DB connection drop, or Fargate kill **between** them
   leaves the table empty or partially filled.
2. **No empty-source guard.** The `deleteMany()` runs unconditionally — there is no
   `if (rows.length === 0) abort` before it. If an upstream hiccup makes the `FACULTY#` / `TOOL#`
   scan return zero items, it **deletes everything and inserts nothing.** (Contrast: `publication_topic`
   has `publication-topic-guard.ts`, but that's a *post-hoc* abort on a *non-destructive* upsert.)
3. **Retry helps but isn't a guarantee.** The SM does 1 retry (2 attempts total); each re-runs the
   whole task, so a transient failure usually self-heals. The residual risk is *both* attempts failing
   mid-block — low probability, catastrophic for a demo, and 24h to the next scheduled heal.

`opportunity` is safe because it never deletes. So: **funding-matcher demo = safe; any demo showing
profile Topics or Methods & Tools = exposed** until the hardening lands.

**Existing safety nets (coarse):** Aurora PITR (14d) + AWS Backup daily, cluster-level. The logical
`backup:curated` (#1032) does **not** cover these tables (it backs up org-unit + methods-overlay +
field_override/suppression). So today there is *no targeted, fast restore* for `topic_assignment` /
`scholar_tool` / `opportunity` — only a full-cluster PITR/snapshot restore.

---

## 3. Hardening work (code — next session, prioritized)

**P0 — sanity-threshold guard, NOT a naive zero-check (cheap, kills the highest-probability wipe).**
Before each `deleteMany()`, abort the run (throw → non-zero exit → SM Catch → SNS, table untouched)
when the freshly-built row set is *implausibly* small relative to what's there now — but DO let
legitimate shrinkage through (see §3a: claims do legitimately disappear). So guard on a **relative
delta + absolute floor against the live row count**, not on `=== 0`:
```ts
const live = await db.write.topicAssignment.count();
// Refuse a catastrophic drop; allow normal churn (incl. legit removals).
if (live > 0 && rows.length < Math.max(MIN_FLOOR, live * (1 - MAX_SHRINK_FRACTION))) {
  throw new Error(`topic_assignment: ${rows.length} rows vs ${live} live — implausible drop, refusing to wipe`);
}
// ...same shape before scholar_tool deleteMany()
```
Tune `MAX_SHRINK_FRACTION` (start ~0.5) + `MIN_FLOOR` from observed day-to-day variance. A naive
`rows.length === 0` check is NOT enough: it misses a 90%-empty hiccup, and a relative guard is what
lets a real "lots of claims removed today" day through while still catching a wipe. Mirror the spirit
of `publication-topic-guard.ts`. Unit-cover: implausible drop → throws (no delete called); normal
shrink → passes.

**P1 — make the replace atomic.** Options, laziest first:
- Wrap `deleteMany()` + the `createMany()` loop in `db.write.$transaction([...])` so a mid-run failure
  rolls back. (Watch the transaction size / timeout for the larger table.)
- Or shadow-table swap: load into `topic_assignment_next`, then atomic `RENAME TABLE`. More work; best
  durability. Probably overkill — start with the transaction.
- Or convert to upsert + prune-missing (upsert all rows, then delete only ids absent from this run)
  — never an empty window, but a bigger rewrite.

**P2 — same audit for any other `deleteMany`/`truncate` in the ETL family** (`grep -rn "deleteMany\|truncate\|TRUNCATE" etl/`). At least `topic_assignment` and `scholar_tool` are confirmed; verify nothing else in the nightly/weekly chains shares the pattern.

### 3a. Anticipate legitimate non-null→null transitions (claim removals)

A publication or funding claim **does** sometimes legitimately go from present → absent (a claim is
unclaimed/retracted, a grant ends and is corrected out, a topic falls below threshold). Uncommon, but
real — and the hardening must NOT suppress these while guarding against wipes. Two consequences:

1. **The wipe guard must distinguish "catastrophic global drop" from "a few claims removed."** This is
   exactly why P0 is a *relative* threshold, not `=== 0`. A naive guard that refuses any shrink would
   freeze the data and silently swallow real removals — the opposite failure. The relative threshold
   lets normal churn (including a heavier-than-usual removal day) through and only blocks an
   implausible cliff.

2. **The upsert-only tables don't propagate removals at all — that's a real gap, not just a wipe-safety
   win.** `opportunity` and `publication_topic` use `upsert` with no prune, so a withdrawn opportunity
   or a removed publication-topic claim **lingers forever** (stale-positive). To honor removals, add a
   **bounded prune**: after the upsert pass, delete the keys that were present last run but absent this
   run — guarded by the SAME relative sanity threshold as P0 (never prune more than X% in one run; if
   the run wants to prune "almost everything," that's a hiccup → abort, don't prune). This gives
   removals-propagate without re-introducing the empty-source wipe.
   - `opportunity`: prune by `opportunityId` not seen in this scan (bounded).
   - `publication_topic`: prune by composite key not seen (bounded); coordinate with the existing
     `publication-topic-guard.ts` so the two guards agree.

3. **Downstream already handles the transition cleanly — verify, don't assume.** Step 3's
   `fundingStatus` (funded↔unfunded), `esiEligible`, and the matcher cross-ref are computed **fresh per
   request** from the live tables (no cache), so a removed grant/pub flips the signal immediately once
   the source row is gone. Confirm no materialized/denormalized copy lags (e.g. OpenSearch indices —
   `search:index` must re-run after a removal for search/profile-card surfaces to drop the claim;
   retracted publications additionally go through the #63/#604 retraction filter). The profile page
   reads live, so it reflects removals after the projection + reindex.

**Net:** P0 (relative wipe guard) and 3a (bounded prune) are two halves of one design — *propagate real
removals, refuse implausible ones.* Build them together, share the threshold constant.

---

## 4. Hard-confirm it runs every night

**Already in place:** cadence alarm (no execution started in ~2 days → SNS) + Catch→SNS on failure.
Gaps to close:

1. **Add the projection to the #595 freshness heartbeat SLA** (`etl:freshness` / `etl_run` audit).
   The new standalone SM isn't tracked by the "green-but-stale" heartbeat yet, so a *silently
   succeeding-but-doing-nothing* run wouldn't alarm. Make `etl:dynamodb` stamp `etl_run` and give it
   a daily SLA.
2. **Tighten the cadence alarm** to ~30h (one missed daily fire) instead of ~2 days, matching the
   nightly/heartbeat windows — faster signal.
3. **Morning verification procedure (run before the demo, and to confirm any night):**
   ```bash
   # last execution status
   aws stepfunctions list-executions \
     --state-machine-arn arn:aws:states:us-east-1:665083158573:stateMachine:scholars-opportunity-projection-staging \
     --max-results 3 --query 'executions[].{name:name,status:status,stop:stopDate}'
   # the projection's own success lines (row counts) from the ETL logs
   aws logs filter-log-events --log-group-name /aws/ecs/sps-etl-staging \
     --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern 'complete' \
     --query 'events[].message' --output text | tr '\t' '\n' | grep -iE 'upserts complete|inserts complete'
   ```
   Healthy night looks like: `opportunity upserts complete: ~800 rows`, `publication_topic upserts
   complete: ~77k`, `scholar_tool inserts complete: >0`, `topic_assignment Inserting >0`. A `0` on
   either insert-block table is the red flag.
4. **Watch tomorrow's real 06:30 UTC fire** (if not frozen) to get one observed clean nightly run on
   record — that's the "hard confirm."

---

## 5. Side bug — Christopher E. Mason has no pubs (should have some)

`https://scholars-staging.weill.cornell.edu/christopher-e-mason` shows no publications; he should have many.

**Key distinction for triage:** `etl:dynamodb` does **not** create `publication` rows (see index.ts
~L248 — "PubMed ETL runs separately"). Profile publications come from `publication` (+ the
scholar↔publication link), populated by `etl:reciter` / the PubMed pipeline. `etl:dynamodb` only
projects `publication_topic` (topic evidence) and scholar metadata. So Mason's missing pubs most
likely trace to the **publication ingest or the scholar-publication linkage, not tonight's projection.**

Corroborating: in the local DB he *did* have `publication_topic` rows (he ranked in the matcher), yet
his staging profile shows no pubs — consistent with "topic rows exist, publication rows/links don't."

Triage steps (next session, in-VPC or via the staging DB):
- Does Mason have rows in `publication` and the scholar↔pub link? `publication_topic`? What's his `cwid`/`slug`, `status` (active? not `deletedAt`/suppressed)?
- Is he excluded by an eligibility/visibility gate (role category, suppression) rather than missing data?
- Compare the staging `reciterai` DDB items for his cwid vs what `etl:reciter` ingested.
- If `publication` rows are simply absent, this is an `etl:reciter`/PubMed-ingest gap, separate from #1218.

---

## 6. References / handles
- Stack: `Sps-Etl-staging` (acct 665083158573, region us-east-1). Deploy from a fresh-master worktree:
  `cd cdk && npx cdk deploy Sps-Etl-staging -c env=staging --exclusively --require-approval never`
  (cdk needs `cdk/node_modules`; `-c env=staging` only — **no** `-c stagingAccount`).
- SM ARN: `arn:aws:states:us-east-1:665083158573:stateMachine:scholars-opportunity-projection-staging`
- Rule: `sps-opportunity-projection-staging` · Alarm: `sps-opportunity-projection-cadence-staging`
- Manual run: `aws stepfunctions start-execution --state-machine-arn <arn> --input '{}'`
- ETL logs: `/aws/ecs/sps-etl-staging`
- Code: `etl/dynamodb/index.ts` (Blocks: topic_assignment ~L534, scholar_tool ~L741),
  `etl/dynamodb/grant-opportunity-etl.ts` (opportunity upsert), `etl/dynamodb/publication-topic-guard.ts` (guard pattern to mirror).
- cdk: `cdk/lib/etl-stack.ts` (projection block after the curation-backup block), `cdk/lib/config.ts`
  (`opportunityProjectionScheduleEnabled`).
- Prod: everything above is staging-only; prod ships the flag `false` (no resources created).
