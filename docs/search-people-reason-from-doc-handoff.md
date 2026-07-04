# Handoff — `/search` People reason-from-doc (D): ship the 1-query fix, confirm prod cluster, load-test on a representative cluster

**Date:** 2026-06-25
**Status:** D (precompute counts + lazy key papers) MERGED + LIVE on staging, but did NOT clear the ~10-concurrent target. Root cause split into a code gap (now fixed, NOT deployed) + a cluster-size ceiling. This handoff = execute the recommended next steps in a fresh session.

> ⚠️ Branch drift: the canonical checkout (`docs/spotlight-pipeline`) is ~300 commits behind `origin/master`. Re-ground code refs via `git show origin/master:<path>` or the worktree below. AWS: DEFAULT credential chain = IAM user `reciter` in the **staging** account `665083158573` (no profile needed); prod is a **separate account** via `aws --profile reciter-prod`.

---

## 1. TL;DR — the recommended path (do these, in order)

1. **Ship the 1-query collapse fix** (commit `39daded6`, already written + verified, NOT pushed). Open a clean PR off fresh `origin/master`, CI → merge → CD builds the image. This halves OpenSearch queries per concept search (2 people-index queries → 1).
2. **Confirm prod's OpenSearch size** via `reciter-prod` — that's the cluster the go-live target must be met on. Staging is a single `t3.medium` and is NOT representative.
3. **Run the acceptance load test against a representative cluster** — either temporarily bump staging's node, or test prod once sized. Staging-as-is cannot demonstrate clearing 10-concurrent (node-capacity wall).
4. **Clean up the loose ends** (§7): the uncommitted flag-flip, the accidental rep-pub re-enable, and decide durable flag rollout.

---

## 2. What shipped (context)

| Item | PR / sha | State |
|---|---|---|
| **A+B+C** (drop cardinality, decouple reason render, cache) | #1281 `c92743d9` | Merged, live on staging. Cleared low-concurrency, NOT C=10. |
| **Synonyms / mesh-anchors nightly** (parallel workstream, "#1258") | #1283 `f8ae330e` | Merged. Ran a full `search:index` reindex on staging this session (benign; see §7). |
| **D** (precompute `meshSubtreeCounts` + lazy on-the-fly key papers) | #1284 `afc2ad43` | **Merged, LIVE on staging** (flag `SEARCH_PEOPLE_REASON_FROM_DOC=on`, td `sps-app-staging:82`). |
| **1-query collapse** (the fix this handoff ships) | `39daded6` (branch `chore/search-reason-from-doc-staging-on`) | **Written + tsc-clean + 28 unit tests pass. NOT pushed, NO PR, NOT deployed.** |

`origin/master` HEAD = `afc2ad43` at handoff time.

**D design (what's live):** the People "N of M publications tagged {concept}" count is precomputed onto the people doc as `meshSubtreeCounts: {conceptDescriptorUi → distinctPubCount}` (source-only `object enabled:false` mapping field), looked up O(1) at query time instead of a publications-index agg. Key papers are NOT precomputed (would be lossy/scholar-level) — they stay concept-specific + `<mark>`-highlighted, fetched **lazily per card** on viewport-enter via `GET /api/search/key-paper`. Flag `SEARCH_PEOPLE_REASON_FROM_DOC` (default off; staging on). Plan: `docs/search-people-reason-agg-D-E-reindex-plan.md`.

**Intentional accuracy change (live):** the doc count is the EXACT full subtree; the legacy agg capped the descendant set at `DESCENDANT_HARD_CAP` (200) and UNDERCOUNTS broad concepts (e.g. Neoplasms). So with the flag on, broad-concept counts go UP to their true value (documented + tested in `taggedCountFromDoc`).

---

## 3. Why D didn't clear C=10 (the diagnosis behind the fix)

Load test on staging with D live (flag on, rep-pub also on — see §7 confound):

| C | before (no A+B+C) | A+B+C | **D (flag on)** |
|---|---|---|---|
| 1 | 2.27 | 2.17 | 1.32 |
| 5 | 8.56 | 7.32 | 7.06 |
| 8 | 11.17 | 8.01 | 10.32 |
| 10 | 16.76 | 13.64 | **13.17** |
(total p90 seconds; `/tmp/sps-loadtest.sh`)

**Two root causes:**
1. **Code gap (FIXED in `39daded6`, undeployed):** D removed the *publications*-index agg, but B's deferred-reason architecture still issued a **second `searchPeople` call** (`app/(public)/search/page.tsx`, `activePeopleReasonPromise`) — a full second *people*-index query just to read `meshSubtreeCounts`, a field the list query's hits already carry. So D swapped (people-query + pub-agg) for (people-query + people-query): no net query reduction → no concurrency win. **The fix folds the cheap doc-reason into the list call (`skipReasonAgg:false`) and drops the second call; routes the now-null reason promise through the lazy key-paper wrapper so key papers still load.** One people-index query per concept search.
2. **Cluster ceiling (infra, unresolved):** staging OpenSearch is a single `t3.medium.search` node. The saturation probe (`/tmp/sps-satcheck.sh`) proved single cold queries ~0.8–1.5s but 5-concurrent ~4–5s EACH — a node-capacity wall. So even after the 1-query fix, the `t3.medium` will likely still not clear C=10. **Staging is not representative of go-live.**

---

## 4. Exact state to resume from

- **Worktree:** `~/worktrees/sps-search-agg`, branch `chore/search-reason-from-doc-staging-on`. Deps symlinked from canonical (`node_modules`, `cdk/node_modules`, `lib/generated`); `.env`/`.env.local` copied in. Repo runs **vitest** (NOT jest); `cdk/` runs **jest**.
  - Commit `39daded6` = the 1-query fix (`page.tsx` + `people-result-card-streamed.tsx`) — CLEAN, ready to PR.
  - **Uncommitted on the branch:** `cdk/lib/app-stack.ts` (flag set to `env === "staging" ? "on" : "off"`, line ~1351) + its jest snapshot. This is the flag-flip that was **cdk-deployed transiently** to staging (td:82). It is NOT in master.
- **Staging (account 665083158573):** D live — flag `SEARCH_PEOPLE_REASON_FROM_DOC=on` on td `sps-app-staging:82`. People index = `scholars-people-v11`, 8937 docs, **carries `meshSubtreeCounts`** (verified: sfs2002 Neoplasms=1619, mub2002=757). App OpenSearch = `opensearch58799-j7tli0rlgtyz` (**t3.medium.search ×1, single-AZ**).
- **Prod:** separate account; OpenSearch size **UNCONFIRMED** (the `m6g.large.search×2` domain `…fquptd67j2so` is in the *staging* account — purpose unclear, NOT confirmed prod). Confirm via `aws --profile reciter-prod opensearch list-domain-names` / `describe-domain`, or read `cdk/lib/data-stack.ts` for env-conditional sizing.

---

## 5. Step-by-step recipes

### 5a. Ship the fix (step 1)
The fix commit `39daded6` is **already PUSHED** as `origin/chore/search-reason-from-doc-staging-on` (only the committed fix is on the remote — the uncommitted flag-flip stayed local). Just open the PR:
```bash
cd /Users/paulalbert/Dropbox/GitHub/Scholars-Profile-System
gh pr create --base master --head chore/search-reason-from-doc-staging-on \
  --title "perf(search): collapse the doc-reason path to a single people-index query"
```
Verify before PR: `cd $WT && npx tsc --noEmit` (ignore stale-prisma noise: `exemplarContexts`, `opportunity`, `vis-network` — pre-existing), and `node_modules/.bin/vitest run tests/unit/search-people-reason-from-doc.test.ts tests/unit/search-fetch-key-paper.test.ts tests/unit/people-result-card-*.test.tsx`. Merge → CD builds the app image (deploy.yml on push-to-master = staging auto; prod triple-gated). **NOTE:** the fix is verified by tsc+units only; the doc-path can't be fully exercised locally (local OpenSearch lacks `meshSubtreeCounts` — no local reindex). Real verification is the staging re-test after deploy.

### 5b. Confirm prod cluster (step 2)
```bash
aws --profile reciter-prod opensearch list-domain-names
aws --profile reciter-prod opensearch describe-domain --domain-name <d> \
  --query 'DomainStatus.ClusterConfig.{type:InstanceType,count:InstanceCount,zoneAware:ZoneAwarenessEnabled}'
# if denied, read cdk/lib/data-stack.ts for `env === "prod" ? ...` instance sizing.
```

### 5c. Load test (step 3) — needs a representative cluster
Scripts (reusable, written this session): `/tmp/sps-loadtest.sh <label>` (C-ramp 1→10, ttfb+total p50/p90/max+non200), `/tmp/sps-satcheck.sh` (sequential-vs-concurrent saturation isolator), `/tmp/sps-listprobe.sh` (per-request list-paint vs reason-arrival). BASE = `https://scholars-staging.weill.cornell.edu/search`. macOS: `gunzip -c` not `zcat`; the load-test awk avoids gawk `asort`. To validate clearing 10-concurrent, EITHER temporarily resize staging's node (t3.medium → t3.large/m6g.large; cdk `data-stack.ts`) OR load-test prod once sized.

### 5d. People-only reindex (if needed again)
```bash
unset AWS_PROFILE; export AWS_REGION=us-east-1
SUBNETS="subnet-03de6e3dfe190288b,subnet-019afebef588ee4b3"; SG="sg-0e9f5358a40c016a5"   # from describe-services sps-app-staging
aws ecs run-task --cluster sps-cluster-staging --task-definition sps-etl-staging --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","search:index:people"]}]}'
# wait: aws ecs wait tasks-stopped ...; exit code via describe-tasks; logs /aws/ecs/sps-etl-staging
```

### 5e. cdk flag deploy (staging)
```bash
cd $WT/cdk && npx jest app-stack -u   # refresh CFN snapshot (cdk uses jest)
npx cdk diff Sps-App-staging -c env=staging       # expect only the env-var change; ResolverRuleAssociation noise = Sps-Network drift
npx cdk deploy --exclusively Sps-App-staging -c env=staging --require-approval never   # NO -c stagingAccount
```

---

## 6. Inspect/operate OpenSearch (it's in-VPC — no laptop access)
Run a `node -e` via `aws ecs run-task` (overrides command), using the `etl` container's env (`OPENSEARCH_NODE/USER/PASS`). Pattern used this session (write the overrides JSON to a file, `--overrides file://…`, single-quote-only JS to dodge JSON escaping):
```js
const {Client}=require('@opensearch-project/opensearch');
const opt={node:process.env.OPENSEARCH_NODE};
if(process.env.OPENSEARCH_USER&&process.env.OPENSEARCH_PASS)opt.auth={username:process.env.OPENSEARCH_USER,password:process.env.OPENSEARCH_PASS};
const c=new Client(opt);
// then c.cat.aliases / c.cat.indices / c.count / c.search ...
```
`meshSubtreeCounts` is `enabled:false` (NOT indexed) → can't query `exists`; verify by sampling `_source` of known prolific cwids (sfs2002, mub2002, rbdevere, rgcryst).

---

## 7. Gotchas / loose ends to clean up

- **Uncommitted flag-flip:** `cdk/lib/app-stack.ts` staging-on + snapshot are uncommitted on the worktree branch and were cdk-deployed transiently (td:82). NOT in master → a `cdk deploy` from master would revert it. Decide: open the durable flag PR (after the fix lands + a clean re-test) OR `cdk deploy` from master to revert staging to off.
- **rep-pub re-enabled (confound):** the cdk flag deploy (from master, where #1280's rep-pub-off was never merged) flipped `SEARCH_PEOPLE_SNIPPET_REPRESENTATIVE_PUB` back ON on staging. Under D the key paper is lazy so it's inert for server-side curls, but it's an uncontrolled variable. #1280 (PR open, unmerged) is the rep-pub-off intent — reconcile master's value.
- **Orphaned-index trap (alias-swap):** a failed/partial `search:index` leaves an orphaned `scholars-people-vN` (the next-version target), and every subsequent reindex then dies with `resource_already_exists_exception`. This session hit a leftover `v11` (1802 partial docs). Fix = delete the orphan **with an in-script guard that aborts if it's the live alias target** (a concurrent reindex can swap the alias between your inspect and delete — it did this session). Consider hardening `etl/search-index/alias-swap.ts` to clean a stale next-version index before create.
- **Parallel-session collision:** another session ("claude-1258", the synonyms workstream) ran a full `search:index` concurrently and swapped the people alias mid-operation. Check `aws ecs list-tasks … --desired-status RUNNING` for `family:sps-etl-staging` before reindexing; don't race.
- **JMESPath `==`/`||` flakiness:** `environment[?name=='X'||name=='Y']` intermittently returned `[]` via the shell; `environment[?contains(name,'SEARCH_PEOPLE')]` piped to `jq` was reliable.
- **Prisma symlink:** `lib/generated` is symlinked to canonical (stale, Jun 13). Ignore stale-prisma tsc errors (`exemplarContexts`, `opportunity`); a dry-run ETL build's optional method-family gate path throws `Unknown field exemplarContexts` — pass `gate=undefined`. NEVER `prisma generate` through the symlink (clobbers canonical).
- **Worktree cleanup:** `git worktree remove --force ~/worktrees/sps-search-agg` + `pkill -f 'vitest|esbuild|tinypool'` when done. (Has uncommitted flag-flip + the unpushed fix commit — preserve `39daded6` first.)

---

## 8. The bottom line for the new session
The code story is essentially complete (A+B+C + D + the 1-query collapse). What remains is **infrastructure**: the staging `t3.medium` can't demonstrate the go-live number, and prod's size is unconfirmed. Ship the fix, size prod, and load-test on a cluster that actually represents go-live — that's the gate, not more app code. If a representative cluster STILL saturates at 10-concurrent after the 1-query fix, the next lever is cluster scale-out (more/bigger data nodes), not E (key-paper precompute, which we deliberately rejected to keep concept-specific papers).
